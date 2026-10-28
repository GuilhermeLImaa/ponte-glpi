// Endereço do relay.
//
// Em desenvolvimento (página servida por http://) usa o relay local do mesmo
// host, na porta 8765 ou na indicada por ?relayPort= (usado nos testes).
// Em produção (https://) usa apenas PRODUCTION_RELAY_URL, que deve ser
// preenchido com o endereço wss:// real ao publicar o site. Em produção não há
// parâmetro para trocar o relay: um link malicioso poderia desviar os dados.

// Túnel rápido da Cloudflare: o endereço muda quando o túnel é reiniciado.
// Ao trocar, atualize também o connect-src do index.html.
export const PRODUCTION_RELAY_URL = "wss://amy-gel-liked-pleased.trycloudflare.com/client";
const DEV_RELAY_PORT = 8765;

export function relayUrl() {
  if (location.protocol === "http:") {
    const param = new URLSearchParams(location.search).get("relayPort");
    const port = /^\d{2,5}$/.test(param || "") ? param : DEV_RELAY_PORT;
    return `ws://${location.hostname}:${port}/client`;
  }
  if (PRODUCTION_RELAY_URL.startsWith("wss://")) {
    return PRODUCTION_RELAY_URL;
  }
  return null;
}
