// Site público da Ponte GLPI.
//
// Regras de segurança deste arquivo:
// - Todo texto vindo da rede é exibido com textContent (nunca innerHTML).
// - Nada de credenciais do GLPI. O único segredo é o token da sessão, guardado
//   em sessionStorage (apaga ao fechar a aba) para sobreviver a um recarregamento.
// - Cada envio gera um request_id novo; não há reenvio automático.

import { relayUrl } from "./config.js";
import {
  PAIRING_STAGE_MESSAGES,
  PAIR_REJECT_MESSAGES,
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
const SUBMIT_ACK_TIMEOUT_MS = 15000;
const RECONNECT_MAX_MS = 30000;

const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  phase: "idle", // idle | pairing | session
  pendingCode: null,
  token: readToken(),
  expiresAt: null,
  waitingDeadline: null,
  stationOnline: true,
  requests: new Map(), // request_id -> { ticket, status, message }
  submitting: null,
  submitTimer: null,
  reconnectDelay: 1000,
  reconnectTimer: null,
};

// ------------------------------------------------------------------ armazenamento

function readToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveToken(token) {
  state.token = token;
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Sem sessionStorage a sessão continua válida enquanto a página estiver aberta.
  }
}

// ------------------------------------------------------------------------- telas

function showScreen(name) {
  for (const id of ["connect", "waiting", "session", "ended"]) {
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

function openSocket() {
  closeSocket();
  const url = relayUrl();
  if (!url) {
    notice("O endereço do serviço intermediário não está configurado neste site.", "error");
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
  } else if (state.phase === "session" && state.token) {
    send({ type: "session.resume", session_token: state.token });
  }
}

function onClose(ws) {
  if (ws !== state.ws) return;
  state.ws = null;
  if (state.phase === "session") {
    setLinkStatus("Reconectando…", "error");
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (state.phase === "session") openSocket();
    }, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, RECONNECT_MAX_MS);
  } else if (state.phase === "pairing") {
    state.phase = "idle";
    setLinkStatus("");
    notice("A conexão com o serviço foi perdida. Tente novamente.", "error");
    showScreen("connect");
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
    $("verification-code").textContent = String(msg.verification_code || "");
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
    startSession(msg.expires_in, true);
    notice("Conexão aprovada na estação.", "ok");
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
  if (!openSocket()) {
    state.phase = "idle";
    showScreen("connect");
  }
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

function onRestart() {
  state.requests.clear();
  renderRequests();
  $("code-input").value = "";
  showScreen("connect");
  $("connect-button").disabled = false;
  $("code-input").focus();
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
  $("connect-form").addEventListener("submit", onConnectSubmit);
  $("cancel-pairing").addEventListener("click", onCancelPairing);
  $("disconnect-button").addEventListener("click", onDisconnect);
  $("ticket-form").addEventListener("submit", onTicketSubmit);
  $("restart-button").addEventListener("click", onRestart);
  setInterval(renderCountdowns, 1000);

  if (state.token) {
    // Recarregamento da página: tenta retomar a sessão existente.
    state.phase = "session";
    $("session-countdown").textContent = "Retomando sessão…";
    showScreen("session");
    openSocket();
  } else {
    showScreen("connect");
  }
}

init();
