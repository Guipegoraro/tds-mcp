// E2E READ-ONLY das tools de administracao pelo servidor MCP real: binario em
// uso, privilegios, pastas do servidor e sessoes do monitor. Nao chama as
// tools que alteram o servidor (mensagem, desconexao).
// Uso: node test/e2e-admin-readonly.mjs <servidor> [ambiente]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const serverName = process.argv[2] ?? process.env.TDS_MCP_TEST_SERVER;
const environment = process.argv[3] ?? process.env.TDS_MCP_TEST_ENV;
// Credenciais opcionais (sem elas vale o token salvo pelo TDS ou o config do tds-mcp)
const credenciais = process.env.TDS_MCP_TEST_USER
  ? { usuario: process.env.TDS_MCP_TEST_USER, senha: process.env.TDS_MCP_TEST_PASSWORD ?? "" }
  : {};
if (!serverName) {
  console.error("Uso: node test/e2e-admin-readonly.mjs <servidor> [ambiente]");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, "..", "dist", "index.js")],
});
const mcp = new Client({ name: "e2e-admin-readonly", version: "0.0.1" });
await mcp.connect(transport);

async function call(name, args = {}) {
  const r = await mcp.callTool({ name, arguments: args });
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

try {
  const antes = await call("tds_list_servers");
  check(
    "tds_list_servers informa o binario antes de subir o advpls",
    !!antes.data?.advpls?.caminho && antes.data.advpls.emExecucao === false,
    JSON.stringify(antes.data?.advpls)
  );

  const conn = await call("tds_use_server", { servidor: serverName, ambiente: environment, ...credenciais });
  check("conecta no servidor", conn.data?.conectado === true, `${conn.data?.servidor}/${conn.data?.ambiente}`);

  const log = await call("tds_server_log");
  check(
    "tds_server_log informa versao do tds-ls em execucao",
    !!log.data?.advpls?.versaoTdsLs && log.data.advpls.emExecucao === true,
    `tds-ls ${log.data?.advpls?.versaoTdsLs} / extensao ${log.data?.advpls?.versaoExtensao}`
  );

  const perm = await call("tds_server_permissions");
  check(
    "tds_server_permissions lista operacoes",
    !perm.isError && Array.isArray(perm.data?.permissoes),
    perm.isError ? JSON.stringify(perm.data) : `${perm.data.permissoes.length} operacoes: ` +
      perm.data.permissoes.map((p) => p.operacao).join(", ")
  );

  const raiz = await call("tds_server_files", {});
  check(
    "tds_server_files lista a raiz do servidor",
    !raiz.isError && Array.isArray(raiz.data?.pastas),
    raiz.isError ? JSON.stringify(raiz.data) : `pastas: ${raiz.data.pastas.slice(0, 8).join(", ")}`
  );

  const users = await call("tds_monitor_users", { limite: 5 });
  check(
    "tds_monitor_users lista sessoes (inclui a conexao do proprio MCP)",
    !users.isError && users.data?.totalSessoes > 0,
    users.isError ? JSON.stringify(users.data) : `${users.data.totalSessoes} sessoes; 1a: ` +
      JSON.stringify(users.data.sessoes[0])
  );

  const alvo = await call("tds_monitor_kill_user", { threadId: -1 });
  check(
    "acao do monitor recusa thread que nao existe, sem chamar o servidor",
    alvo.isError && /não está na lista atual/.test(alvo.data?.erro ?? ""),
    alvo.data?.erro
  );

} finally {
  await mcp.close();
}

console.log(falhas === 0 ? "\nE2E ADMIN READ-ONLY OK" : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
