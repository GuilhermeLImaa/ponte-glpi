// Regras espelhadas de bridge_protocol (Python). Ao alterar um limite aqui,
// altere também bridge_protocol/limits.py e docs/protocol.md.

export const PAIRING_CODE_DIGITS = 8;
export const SESSION_MAX_SECONDS = 12 * 60 * 60;
export const TICKET_NUMBER_MAX_DIGITS = 10;
export const SOLUTION_MIN_CHARS = 5;
export const SOLUTION_MAX_CHARS = 4000;

const TICKET_RE = new RegExp(`^[1-9][0-9]{0,${TICKET_NUMBER_MAX_DIGITS - 1}}$`);
const FORBIDDEN_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const STATUS_LABELS = {
  sending: "Enviando…",
  pending: "Aguardando a estação",
  approved: "Aprovado na estação",
  running: "Executando no GLPI",
  succeeded: "Chamado encerrado e verificado",
  failed: "Falha conhecida",
  unknown: "Resultado inconclusivo — verificar manualmente no GLPI",
  cancelled: "Cancelado",
  rejected: "Não enviado",
};

export const TERMINAL = new Set(["succeeded", "failed", "unknown", "cancelled", "rejected"]);

export const PAIR_REJECT_MESSAGES = {
  declined: "Conexão recusada na estação.",
  invalid_code: "ID inválido ou expirado. Confira o ID exibido na estação.",
  rate_limited: "Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.",
  busy: "A estação já está atendendo outra conexão.",
  station_offline: "A estação está desconectada no momento.",
  timeout: "A estação não respondeu a tempo. Solicite a conexão novamente.",
  client_left: "Solicitação de conexão cancelada.",
};

// Etapas informadas pela estação enquanto decide a conexão: [texto, tom].
export const PAIRING_STAGE_MESSAGES = {
  awaiting_credentials: ["Conexão aceita na estação. Aguardando o login no GLPI…", ""],
  verifying_login: ["Verificando o login no GLPI…", ""],
  login_failed: ["O login no GLPI falhou na estação. Aguardando nova tentativa…", "warn"],
};

export const SESSION_END_MESSAGES = {
  expired: "A sessão expirou (limite de 12 horas). Faça uma nova conexão e aprovação na estação.",
  ended_by_station: "A estação encerrou a sessão.",
  ended_by_client: "Você desconectou este dispositivo.",
  station_disconnected: "A estação ficou desconectada e a sessão foi revogada.",
  invalid_or_expired: "A sessão não é mais válida. Faça uma nova conexão.",
  rate_limited: "Muitas tentativas. Aguarde alguns minutos.",
};

export function normalizeCode(raw) {
  const code = String(raw).replace(/\s+/g, "");
  return new RegExp(`^[0-9]{${PAIRING_CODE_DIGITS}}$`).test(code) ? code : null;
}

export function formatCode(raw) {
  const digits = String(raw).replace(/\D/g, "").slice(0, PAIRING_CODE_DIGITS);
  return digits.replace(/(\d{2})(?=\d)/g, "$1 ");
}

export function validateTicketNumber(raw) {
  const value = String(raw).trim();
  if (!TICKET_RE.test(value)) {
    return { error: `Informe apenas dígitos (até ${TICKET_NUMBER_MAX_DIGITS}), sem zero à esquerda.` };
  }
  return { value };
}

// Conta pontos de código, como o len() do Python.
export function charCount(text) {
  return [...text].length;
}

export function validateSolution(raw) {
  const value = String(raw).replace(/\r\n?/g, "\n").trim();
  const length = charCount(value);
  if (length < SOLUTION_MIN_CHARS) {
    return { error: `Descreva a solução com pelo menos ${SOLUTION_MIN_CHARS} caracteres.` };
  }
  if (length > SOLUTION_MAX_CHARS) {
    return { error: `A descrição deve ter no máximo ${SOLUTION_MAX_CHARS} caracteres.` };
  }
  if (FORBIDDEN_CONTROL_RE.test(value)) {
    return { error: "A descrição contém caracteres não permitidos." };
  }
  return { value };
}

// UUID v4 com crypto.getRandomValues (funciona também fora de HTTPS em testes na rede local).
export function uuid4() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
