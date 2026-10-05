// E2E dos casos de borda da depuração: encerramento por inatividade no modo navegador,
// download no modo job e validações de parâmetro. Usa um perfil de usuário temporário
// com debugIdleMinutes curto (servers.json e advpls reais via variáveis de ambiente).
// Exige test/zTstDbg1.prw compilado (rode antes o e2e-debug).
// Uso: node test/e2e-debug-bordas.mjs <servidor> [ambiente]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAdvplsPath } from "../dist/advpls.js";
import { serversJsonPath } from "../dist/session.js";

const serverName = process.argv[2] ?? process.env.TDS_MCP_TEST_SERVER;
const environment = process.argv[3] ?? process.env.TDS_MCP_TEST_ENV;
const credenciais = process.env.TDS_MCP_TEST_USER
  ? { usuario: process.env.TDS_MCP_TEST_USER, senha: process.env.TDS_MCP_TEST_PASSWORD ?? "" }
  : {};
if (!serverName) {
  console.error("Uso: node test/e2e-debug-bordas.mjs <servidor> [ambiente]");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-home-"));
fs.mkdirSync(path.join(home, ".tds-mcp"));
// 0,1 min; no modo navegador vale o triplo (18 s), conferido a cada 30 s.
fs.writeFileSync(path.join(home, ".tds-mcp", "config.json"), JSON.stringify({ debugIdleMinutes: 0.1 }));

const mcp = new Client({ name: "e2e-debug-bordas", version: "0.0.1" });
await mcp.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "..", "dist", "index.js")],
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      TDS_MCP_ADVPLS: resolveAdvplsPath(),
      TDS_MCP_SERVERS_JSON: serversJsonPath(),
    },
  })
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

try {
  const conn = await call("tds_use_server", { servidor: serverName, ambiente: environment, ...credenciais });
  check("conecta no servidor", conn.data?.conectado === true, `${conn.data?.servidor}/${conn.data?.ambiente}`);

  // --- inatividade no modo navegador: a próxima chamada recebe a aba a fechar, uma vez só
  const nav = await call("tds_debug_start", { programa: "u_zTstDbg1", modo: "navegador" });
  const contexto = nav.data?.abrirCom?.isolatedContext;
  await new Promise((r) => setTimeout(r, 65000));
  const depois = await call("tds_debug_wait", { timeoutSeg: 1 });
  check(
    "sessão do navegador encerrada por inatividade avisa qual aba fechar",
    depois.isError && /inatividade/.test(depois.data?.erro ?? "") && (depois.data?.erro ?? "").includes(contexto),
    short(depois.data)
  );
  const stop = await call("tds_debug_stop");
  check("o aviso sai uma vez só", stop.data?.encerrada === false && !stop.data?.fecharAba, short(stop.data));

  // --- modo job também grava os downloads
  const pastaDl = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-bordas-dl-"));
  try {
    await call("tds_debug_start", { programa: "u_zTstDbgD", modo: "job", aguardarSeg: 0, pastaDownloads: pastaDl });
    const fim = await call("tds_debug_wait", { timeoutSeg: 60 });
    check(
      "modo job: arquivo enviado ao navegador vem em arquivosBaixados",
      fim.data?.estado === "encerrado" && fim.data?.arquivosBaixados?.[0]?.estado === "concluido" && fs.readdirSync(pastaDl).length === 1,
      short(fim.data)
    );
    await call("tds_debug_stop");
  } finally {
    fs.rmSync(pastaDl, { recursive: true, force: true });
  }

  // --- validações de parâmetro, antes de iniciar qualquer coisa
  const relativa = await call("tds_run", { programa: "u_zTstDbgD", pastaDownloads: "downloads" });
  check("pastaDownloads relativa é recusada", relativa.isError && /caminho absoluto/.test(relativa.data?.erro ?? ""), short(relativa.data));
  const navDl = await call("tds_debug_start", { programa: "u_zTstDbg1", modo: "navegador", pastaDownloads: os.tmpdir() });
  check("pastaDownloads no modo navegador é recusada", navDl.isError && /headless e job/.test(navDl.data?.erro ?? ""), short(navDl.data));
  const modInvalido = await call("tds_debug_start", { programa: "u_zTstDbg1", modo: "navegador", modulo: "estoque" });
  check("módulo por nome desconhecido pede o código", modInvalido.isError && /código numérico/.test(modInvalido.data?.erro ?? ""), short(modInvalido.data));

  const users = await call("tds_monitor_users", { programa: "ZTSTDBG" });
  check("nenhuma thread de teste presa no servidor", (users.data?.totalFiltrado ?? 1) === 0, short(users.data?.sessoes));
} finally {
  await call("tds_debug_stop").catch(() => {});
  await mcp.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(falhas === 0 ? "\nE2E BORDAS OK" : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
