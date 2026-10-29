// Endereço do relay.
//
// Em desenvolvimento (página servida por http://) usa o relay local do mesmo
// host, na porta 8765 ou na indicada por ?relayPort= (usado nos testes).
// Em produção (https://) lê relay.json, publicado ao lado do site pelo botão
// "Ligar conexão" da estação central sempre que o túnel da Cloudflare ganha um
// endereço novo. Em produção não há parâmetro na URL para trocar o relay: um
// link malicioso poderia desviar os dados. Só endereços do túnel rápido são
// aceitos (o mesmo limite vale no connect-src do index.html).

const RELAY_FILE = "relay.json";
const ALLOWED_RELAY = /^wss:\/\/[a-z0-9-]+\.trycloudflare\.com\/client$/;
const DEV_RELAY_PORT = 8765;

export async function relayUrl() {
  if (location.protocol === "http:") {
    const param = new URLSearchParams(location.search).get("relayPort");
    const port = /^\d{2,5}$/.test(param || "") ? param : DEV_RELAY_PORT;
    return `ws://${location.hostname}:${port}/client`;
  }
  try {
    // Sem cache: o endereço muda a cada reinício do túnel.
    const response = await fetch(`${RELAY_FILE}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data.relay === "string" && ALLOWED_RELAY.test(data.relay) ? data.relay : null;
  } catch {
    return null;
  }
}
