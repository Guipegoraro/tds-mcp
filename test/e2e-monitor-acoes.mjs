// E2E das ações do monitor pelo servidor MCP real: mensagem, app kill e kill
// numa thread do próprio teste (u_zTstDbg1 parado num breakpoint). COMPILA
// test/zTstDbg1.prw. Use só em ambiente de desenvolvimento.
// Uso: node test/e2e-monitor-acoes.mjs <servidor> [ambiente]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const serverName = process.argv[2] ?? process.env.TDS_MCP_TEST_SERVER;
const environment = process.argv[3] ?? process.env.TDS_MCP_TEST_ENV;
// Credenciais opcionais (sem elas vale o token salvo pelo TDS ou o config do tds-mcp)
const credenciais = process.env.TDS_MCP_TEST_USER
  ? { usuario: process.env.TDS_MCP_TEST_USER, senha: process.env.TDS_MCP_TEST_PASSWORD ?? "" }
  : {};
if (!serverName) {
  console.error("Uso: node test/e2e-monitor-acoes.mjs <servidor> [ambiente]");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "zTstDbg1.prw");
const L_SOMA = fs.readFileSync(SRC, "latin1").split(/\r?\n/).findIndex((l) => l.includes("nTotal += zTstSoma(nI)")) + 1;
if (!L_SOMA) throw new Error('zTstDbg1.prw sem a linha "nTotal += zTstSoma(nI)"');

const mcp = new Client({ name: "e2e-monitor-acoes", version: "0.0.1" });
await mcp.connect(
  new StdioClientTransport({ command: process.execPath, args: [path.join(here, "..", "dist", "index.js")] })
);

async function call(name, args = {}) {
  const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  let parsed;
  try {
    parsed = JSON.parse(r.content?.[0]?.text ?? "");
  } catch {
    parsed = r.content?.[0]?.text;
  }
  return { isError: !!r.isError, data: parsed };
}

let falhas = 0;
function check(nome, condicao, detalhe) {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}
const short = (v) => String(JSON.stringify(v)).slice(0, 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const threadsDoTeste = async () => (await call("tds_monitor_users", { programa: "ZTSTDBG" })).data?.sessoes ?? [];

try {
  const conn = await call("tds_use_server", { servidor: serverName, ambiente: environment, ...credenciais });
  check("conecta no servidor", conn.data?.conectado === true, `${conn.data?.servidor}/${conn.data?.ambiente}`);
  const comp = await call("tds_compile", { arquivos: [SRC] });
  check("compila o fonte de teste", comp.data?.sucesso === true, short(comp.data?.resultados));

  // Thread do teste presa num breakpoint: é o alvo das ações
  const st = await call("tds_debug_start", { programa: "u_zTstDbg1", breakpoints: [{ arquivo: SRC, linha: L_SOMA }], aguardarSeg: 60 });
  check("programa de teste parado no breakpoint", st.data?.estado === "parado", short(st.data?.local));
  const [alvo] = await threadsDoTeste();
  check("tds_monitor_users acha a thread do teste", !!alvo?.threadId, short(alvo));

  const msg = await call("tds_monitor_send_message", { threadId: alvo.threadId, mensagem: "teste e2e do tds-mcp" });
  check("tds_monitor_send_message envia para a thread", !msg.isError, short(msg.data));

  const app = await call("tds_monitor_app_kill_user", { threadId: alvo.threadId });
  check("tds_monitor_app_kill_user aceita a thread", !app.isError, short(app.data));

  const kill = await call("tds_monitor_kill_user", { threadId: alvo.threadId });
  check("tds_monitor_kill_user aceita a thread", !kill.isError, short(kill.data));
  let restante = await threadsDoTeste();
  for (let i = 0; i < 15 && restante.some((s) => s.threadId === alvo.threadId); i++) {
    await sleep(1000);
    restante = await threadsDoTeste();
  }
  check("a thread some do monitor depois do kill", !restante.some((s) => s.threadId === alvo.threadId), short(restante));
} finally {
  await call("tds_debug_stop").catch(() => {});
  const sobra = await threadsDoTeste().catch(() => []);
  check("nenhuma thread de teste presa no servidor", sobra.length === 0, short(sobra));
  await mcp.close();
}

console.log(falhas === 0 ? "\nE2E MONITOR OK" : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
