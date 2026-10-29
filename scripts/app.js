// Site público da Ponte GLPI.
//
// Regras de segurança deste arquivo:
// - Todo texto vindo da rede é exibido com textContent (nunca innerHTML).
// - Nada de credenciais do GLPI. O único segredo é o token da sessão (aleatório,
//   256 bits), guardado em localStorage para que fechar a aba ou o celular
//   descartar a página não derrube a sessão. Ele é apagado ao desconectar ou
//   quando a sessão termina, e o relay o recusa depois de 12 h.
// - Cada envio gera um request_id novo; não há reenvio automático.

import { relayUrl } from "./config.js";
import { SOLUTION_TEMPLATES } from "./templates.js";
import {
  PAIRING_STAGE_MESSAGES,
  PAIR_REJECT_MESSAGES,
  RECOVER_FAIL_MESSAGES,
  SESSION_END_MESSAGES,
  SESSION_MAX_SECONDS,
  SOLUTION_MAX_CHARS,
  STATUS_LABELS,
  TERMINAL,
  charCount,
  formatCode,
  formatDuration,
  normalizeCode,
  uuid4,
  validateSolution,
  validateTicketNumber,
} from "./protocol.js";

const TOKEN_KEY = "glpi-bridge.session-token";
const VERIFICATION_KEY = "glpi-bridge.verification-code";
const SUBMIT_ACK_TIMEOUT_MS = 15000;
const RECONNECT_MAX_MS = 30000;

const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  phase: "idle", // idle | pairing | recovering | session
  pendingCode: null,
  pendingRecover: null,
  pairingVerification: null,
  verification: readStored(VERIFICATION_KEY),
  token: readToken(),
  expiresAt: null,
  waitingDeadline: null,
  stationOnline: true,
  requests: new Map(), // request_id -> { ticket, status, message }
  submitting: null,
  submitTimer: null,
  reconnectDelay: 1000,
  reconnectTimer: null,
  socketAttempt: 0,
};

// ------------------------------------------------------------------ armazenamento

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readToken() {
  return readStored(TOKEN_KEY);
}

// Código de 4 dígitos da aprovação, só para mostrar na tela da sessão.
function saveVerification(code) {
  state.verification = code;
  $("session-verification").textContent = code || "—";
  try {
    if (code) localStorage.setItem(VERIFICATION_KEY, code);
    else localStorage.removeItem(VERIFICATION_KEY);
  } catch {
    /* só exibição */
  }
}

function saveToken(token) {
  state.token = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Sem localStorage a sessão continua válida enquanto a página estiver aberta.
  }
}

// ------------------------------------------------------------------------- telas

function showScreen(name) {
  for (const id of ["connect", "recover", "waiting", "session", "ended"]) {
    $(`screen-${id}`).hidden = id !== name;
  }
}

function notice(text, kind = "warn") {
  const box = $("notice");
  box.textContent = text || "";
  box.dataset.kind = kind;
  box.hidden = !text;
}

function setLinkStatus(text, tone = "") {
  const chip = $("link-status");
  chip.textContent = text || "Desconectado";
  chip.dataset.tone = text ? tone : "";
}

function showEnded(reason) {
  $("ended-reason").textContent = SESSION_END_MESSAGES[reason] || "A sessão foi encerrada.";
  notice("");
  showScreen("ended");
}

// ----------------------------------------------------------------------- conexão

async function openSocket() {
  closeSocket();
  // Cada abertura tem um número; se outra começar enquanto esta lê o
  // endereço, esta desiste.
  const attempt = ++state.socketAttempt;
  setLinkStatus("Conectando…", "warn");
  const url = await relayUrl();
  if (attempt !== state.socketAttempt) return false;
  if (!url) {
    setLinkStatus("");
    notice("Não foi possível obter o endereço do serviço. A estação central pode estar desligada; tente de novo em instantes.", "error");
    return false;
  }
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    notice("Não foi possível abrir a conexão com o serviço.", "error");
    return false;
  }
  state.ws = ws;
  ws.addEventListener("open", () => onOpen(ws));
  ws.addEventListener("message", (event) => onMessage(ws, event));
  ws.addEventListener("close", () => onClose(ws));
  setLinkStatus("Conectando…", "warn");
  return true;
}

function closeSocket() {
  state.socketAttempt++;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.ws) {
    const ws = state.ws;
    state.ws = null;
    try {
      ws.close();
    } catch {
      /* já fechado */
    }
  }
}

function send(message) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function onOpen(ws) {
  if (ws !== state.ws) return;
  state.reconnectDelay = 1000;
  setLinkStatus("Conectado", "ok");
  if (state.phase === "pairing" && state.pendingCode) {
    send({ type: "pair.request", code: state.pendingCode });
  } else if (state.phase === "recovering" && state.pendingRecover) {
    send({ type: "session.recover", verification_code: state.pendingRecover });
  } else if (state.phase === "session" && state.token) {
    send({ type: "session.resume", session_token: state.token });
  }
}

function reopenSession() {
  openSocket().then((ok) => {
    // Sem endereço: tenta de novo mais tarde (o túnel pode estar reiniciando).
    if (!ok && state.phase === "session" && !state.ws) onClose(null);
  });
}

function onClose(ws) {
  if (ws !== state.ws) return;
  state.ws = null;
  if (state.phase === "session") {
    setLinkStatus("Reconectando…", "error");
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (state.phase === "session") reopenSession();
    }, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, RECONNECT_MAX_MS);
  } else if (state.phase === "pairing") {
    state.phase = "idle";
    setLinkStatus("");
    notice("A conexão com o serviço foi perdida. Tente novamente.", "error");
    showScreen("connect");
  } else if (state.phase === "recovering") {
    recoverFailed("A conexão com o serviço foi perdida. Tente novamente.");
  } else {
    setLinkStatus("");
  }
}

function onMessage(ws, event) {
  if (ws !== state.ws) return;
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }
  if (!msg || typeof msg.type !== "string") return;
  const handler = handlers[msg.type];
  if (handler) handler(msg);
}

const handlers = {
  "pair.pending"(msg) {
    state.pairingVerification = String(msg.verification_code || "");
    $("verification-code").textContent = state.pairingVerification;
    state.waitingDeadline = Date.now() + (Number(msg.expires_in) || 0) * 1000;
    notice("");
    showScreen("waiting");
    renderCountdowns();
  },

  "pair.progress"(msg) {
    const [text, tone] = PAIRING_STAGE_MESSAGES[msg.stage] || ["", ""];
    const stage = $("waiting-stage");
    stage.textContent = text;
    stage.dataset.tone = tone;
  },

  "pair.rejected"(msg) {
    state.phase = "idle";
    state.pendingCode = null;
    closeSocket();
    setLinkStatus("");
    notice(PAIR_REJECT_MESSAGES[msg.reason] || "Não foi possível conectar.", "error");
    showScreen("connect");
    $("connect-button").disabled = false;
  },

  "pair.approved"(msg) {
    state.phase = "session";
    state.pendingCode = null;
    state.requests.clear();
    saveToken(String(msg.session_token || ""));
    saveVerification(state.pairingVerification || null);
    startSession(msg.expires_in, true);
    notice("Conexão aprovada na estação.", "ok");
  },

  "session.recovered"(msg) {
    if (state.phase !== "recovering") return;
    state.phase = "session";
    state.pendingRecover = null;
    state.requests.clear();
    saveToken(String(msg.session_token || ""));
    saveVerification(/^\d{4}$/.test(msg.verification_code || "") ? msg.verification_code : null);
    startSession(msg.expires_in, msg.station_online !== false);
    for (const item of Array.isArray(msg.requests) ? msg.requests : []) applyStatus(item);
    renderRequests();
    notice("Reconectado à sessão.", "ok");
  },

  "session.recover_failed"(msg) {
    recoverFailed(RECOVER_FAIL_MESSAGES[msg.reason] || RECOVER_FAIL_MESSAGES.invalid_code);
  },

  "session.resumed"(msg) {
    startSession(msg.expires_in, msg.station_online !== false);
    const known = new Set();
    for (const item of Array.isArray(msg.requests) ? msg.requests : []) {
      known.add(item.request_id);
      applyStatus(item);
    }
    // Envios sem confirmação do serviço antes da queda.
    for (const [id, req] of state.requests) {
      if (req.status === "sending" && !known.has(id)) {
        req.status = "rejected";
        req.message = "O serviço não recebeu esta solicitação. Envie novamente se necessário.";
      }
    }
    finishSubmit();
    renderRequests();
  },

  "session.invalid"(msg) {
    endSession(msg.reason || "invalid_or_expired");
  },

  "session.ended"(msg) {
    endSession(msg.reason);
  },

  "station.status"(msg) {
    state.stationOnline = msg.online === true;
    renderStationStatus();
  },

  "ticket.status"(msg) {
    applyStatus(msg);
    if (msg.request_id === state.submitting) {
      finishSubmit();
      $("ticket-input").value = "";
      $("solution-input").value = "";
      $("template-select").value = "";
      updateCharCount();
    }
    renderRequests();
  },

  error(msg) {
    const id = typeof msg.request_id === "string" ? msg.request_id : null;
    if (id && msg.code === "duplicate_request") return; // o estado atual chega em seguida
    if (id && state.requests.has(id)) {
      const req = state.requests.get(id);
      if (req.status === "sending") {
        req.status = "rejected";
        req.message = String(msg.message || "Solicitação recusada pelo serviço.");
      }
      if (id === state.submitting) finishSubmit();
      renderRequests();
      return;
    }
    notice(String(msg.message || "Erro no serviço."), "error");
  },
};

function startSession(expiresIn, stationOnline) {
  state.expiresAt = Date.now() + (Number(expiresIn) || 0) * 1000;
  state.stationOnline = stationOnline;
  showScreen("session");
  renderStationStatus();
  renderRequests();
  renderCountdowns();
}

function endSession(reason) {
  state.phase = "idle";
  saveToken(null);
  saveVerification(null);
  state.expiresAt = null;
  finishSubmit();
  closeSocket();
  setLinkStatus("");
  showEnded(reason);
}

function applyStatus(msg) {
  if (typeof msg.request_id !== "string" || !(msg.status in STATUS_LABELS)) return;
  const req = state.requests.get(msg.request_id) || { ticket: String(msg.ticket_number || "") };
  req.status = msg.status;
  req.message = typeof msg.message === "string" ? msg.message : "";
  if (msg.ticket_number) req.ticket = String(msg.ticket_number);
  state.requests.set(msg.request_id, req);
}

function finishSubmit() {
  state.submitting = null;
  if (state.submitTimer) {
    clearTimeout(state.submitTimer);
    state.submitTimer = null;
  }
  $("submit-button").disabled = false;
}

// ----------------------------------------------------------------- renderização

function renderStationStatus() {
  $("station-status").textContent = state.stationOnline
    ? ""
    : "A estação está temporariamente desconectada. Novos envios ficam bloqueados até ela voltar.";
}

function renderRequests() {
  const list = $("requests-list");
  list.replaceChildren();
  const entries = [...state.requests.entries()].reverse();
  $("requests-empty").hidden = entries.length > 0;
  for (const [, req] of entries) {
    const li = document.createElement("li");
    li.dataset.status = req.status;
    const head = document.createElement("div");
    head.className = "head";
    const ticket = document.createElement("span");
    ticket.className = "ticket";
    ticket.textContent = `Chamado ${req.ticket}`;
    const status = document.createElement("span");
    status.className = "status";
    status.textContent = STATUS_LABELS[req.status] || req.status;
    head.append(ticket, status);
    li.append(head);
    if (req.message) {
      const detail = document.createElement("p");
      detail.className = "detail";
      detail.textContent = req.message;
      li.append(detail);
    }
    list.append(li);
  }
}

function renderCountdowns() {
  const now = Date.now();
  if (state.phase === "pairing" && state.waitingDeadline) {
    const left = (state.waitingDeadline - now) / 1000;
    $("waiting-countdown").textContent = `A solicitação expira em ${formatDuration(left)}.`;
  }
  if (state.phase === "session" && state.expiresAt) {
    const left = (state.expiresAt - now) / 1000;
    if (left <= 0) {
      send({ type: "session.end" });
      endSession("expired");
      return;
    }
    $("session-countdown").textContent = `Sessão expira em ${formatDuration(left)}.`;
    $("session-progress").value = left;
  }
}

function updateCharCount() {
  $("solution-count").textContent = String(charCount($("solution-input").value.trim()));
}

// ------------------------------------------------------------------------ ações

function onConnectSubmit(event) {
  event.preventDefault();
  const code = normalizeCode($("code-input").value);
  if (!code) {
    $("code-error").textContent = "Digite os 8 dígitos do ID.";
    return;
  }
  $("code-error").textContent = "";
  notice("");
  state.phase = "pairing";
  state.pendingCode = code;
  $("verification-code").textContent = "…";
  $("waiting-countdown").textContent = "";
  $("waiting-stage").textContent = "";
  showScreen("waiting");
  openSocket().then((ok) => {
    if (!ok && state.phase === "pairing") {
      state.phase = "idle";
      showScreen("connect");
    }
  });
}

function onCancelPairing() {
  send({ type: "session.end" });
  state.phase = "idle";
  state.pendingCode = null;
  closeSocket();
  setLinkStatus("");
  showScreen("connect");
}

function onDisconnect() {
  send({ type: "session.end" });
  endSession("ended_by_client");
}

function onTicketSubmit(event) {
  event.preventDefault();
  if (state.submitting) return;
  const ticket = validateTicketNumber($("ticket-input").value);
  const solution = validateSolution($("solution-input").value);
  $("ticket-error").textContent = ticket.error || "";
  $("solution-error").textContent = solution.error || "";
  if (ticket.error || solution.error) return;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    notice("Sem conexão com o serviço no momento. Aguarde a reconexão.", "error");
    return;
  }
  if (!state.stationOnline) {
    notice("A estação está desconectada. Aguarde ela voltar.", "error");
    return;
  }
  notice("");
  const requestId = uuid4();
  state.requests.set(requestId, { ticket: ticket.value, status: "sending", message: "" });
  state.submitting = requestId;
  $("submit-button").disabled = true;
  send({ type: "ticket.submit", request_id: requestId, ticket_number: ticket.value, solution: solution.value });
  state.submitTimer = setTimeout(() => {
    if (state.submitting === requestId) {
      const req = state.requests.get(requestId);
      if (req && req.status === "sending") req.message = "Sem resposta do serviço até agora.";
      finishSubmit();
      renderRequests();
    }
  }, SUBMIT_ACK_TIMEOUT_MS);
  renderRequests();
}

function showRecover() {
  closeSocket();
  state.phase = "idle";
  notice("");
  $("recover-error").textContent = "";
  $("recover-input").value = "";
  $("recover-button").disabled = false;
  showScreen("recover");
  $("recover-input").focus();
}

function onRecoverSubmit(event) {
  event.preventDefault();
  const code = $("recover-input").value.replace(/\D/g, "");
  if (code.length !== 4) {
    $("recover-error").textContent = "Digite os 4 dígitos.";
    return;
  }
  $("recover-error").textContent = "";
  $("recover-button").disabled = true;
  state.phase = "recovering";
  state.pendingRecover = code;
  openSocket().then((ok) => {
    if (!ok && state.phase === "recovering") recoverFailed("");
  });
}

function recoverFailed(text) {
  state.phase = "idle";
  state.pendingRecover = null;
  closeSocket();
  setLinkStatus("");
  if (text) $("recover-error").textContent = text;
  $("recover-button").disabled = false;
  showScreen("recover");
}

function onRestart() {
  state.requests.clear();
  renderRequests();
  $("code-input").value = "";
  showScreen("connect");
  $("connect-button").disabled = false;
  $("code-input").focus();
}

// Como no GLPI: escolher um modelo coloca o texto dele na descrição.
// Se já houver texto digitado, pergunta antes de substituir.
function onTemplateChange(e) {
  const template = SOLUTION_TEMPLATES.find((t) => t.id === e.target.value);
  if (!template) return;
  const field = $("solution-input");
  const current = field.value.trim();
  if (current && current !== template.text && !confirm("Substituir o texto da descrição pelo modelo?")) {
    e.target.value = "";
    return;
  }
  field.value = template.text;
  updateCharCount();
  field.focus();
}

// ------------------------------------------------------------------- inicialização

function init() {
  $("solution-max").textContent = String(SOLUTION_MAX_CHARS);
  $("session-progress").max = SESSION_MAX_SECONDS;
  $("solution-input").maxLength = SOLUTION_MAX_CHARS * 2; // o limite real é validado acima
  $("code-input").addEventListener("input", (e) => {
    e.target.value = formatCode(e.target.value);
  });
  $("ticket-input").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "");
  });
  $("solution-input").addEventListener("input", updateCharCount);
  for (const template of SOLUTION_TEMPLATES) {
    const option = document.createElement("option");
    option.value = template.id;
    option.textContent = template.name;
    $("template-select").append(option);
  }
  $("template-select").addEventListener("change", onTemplateChange);
  $("connect-form").addEventListener("submit", onConnectSubmit);
  $("cancel-pairing").addEventListener("click", onCancelPairing);
  $("disconnect-button").addEventListener("click", onDisconnect);
  $("ticket-form").addEventListener("submit", onTicketSubmit);
  $("restart-button").addEventListener("click", onRestart);
  $("recover-open").addEventListener("click", showRecover);
  $("recover-from-ended").addEventListener("click", showRecover);
  $("recover-back").addEventListener("click", onRestart);
  $("recover-form").addEventListener("submit", onRecoverSubmit);
  $("recover-input").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "");
  });
  $("session-verification").textContent = state.verification || "—";
  setInterval(renderCountdowns, 1000);
  // Ao voltar para o site (celular desbloqueado, aba trocada), reconecta na
  // hora em vez de esperar a próxima tentativa.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.phase === "session" && !state.ws) {
      reopenSession();
    }
  });

  if (state.token) {
    // Recarregamento da página: tenta retomar a sessão existente.
    state.phase = "session";
    $("session-countdown").textContent = "Retomando sessão…";
    showScreen("session");
    reopenSession();
  } else {
    showScreen("connect");
  }
}

init();
