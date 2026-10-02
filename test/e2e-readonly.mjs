// E2E READ-ONLY pelo servidor MCP real: valida o caminho de veredito de
// compilação sem gravar nada no RPO (usa syntaxOnly).
// Uso: node test/e2e-readonly.mjs <servidor> [ambiente]
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
  console.error("Uso: node test/e2e-readonly.mjs <servidor> [ambiente]");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const okFile = path.join(here, "zTstMcp1.prw");
const badFile = path.join(here, "zTstE2eRo.prw");
const forFile = path.join(here, "zTstE2eFor.prw");
fs.writeFileSync(
  forFile,
  '#include "protheus.ch"\r\n\r\nUser Function zTstE2eFor()\r\n    Private nK := 0\r\n    For nK := 1 To 2\r\n        nK := nK\r\n    Next nK\r\nReturn nK\r\n',
  "latin1"
);
fs.writeFileSync(
  badFile,
  '#include "protheus.ch"\n\nUser Function zTstE2eRo()\n    Local cX := "aberta\n    nY := Soma(1,\nReturn cX\n',
  "latin1"
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, "..", "dist", "index.js")],
});
const mcp = new Client({ name: "e2e-readonly", version: "0.0.1" });
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
  const conn = await call("tds_use_server", { servidor: serverName, ambiente: environment, ...credenciais });
  check("conecta no servidor", conn.data?.conectado === true, `${conn.data?.servidor}/${conn.data?.ambiente}`);

  const ok = await call("tds_syntax_check", { arquivos: [okFile] });
  check(
    "fonte valido -> sintaxeOk=true e isError=false",
    ok.data?.sintaxeOk === true && ok.isError === false,
    `sintaxeOk=${ok.data?.sintaxeOk} isError=${ok.isError} returnCode=${ok.data?.returnCode} ignorados=${ok.data?.ignorados}` +
      (ok.data?.aviso ? `\n      aviso: ${ok.data.aviso.substring(0, 90)}...` : "")
  );

  const bad = await call("tds_syntax_check", { arquivos: [badFile] });
  check(
    "fonte invalido -> sintaxeOk=false E isError=true",
    bad.data?.sintaxeOk === false && bad.isError === true,
    `sintaxeOk=${bad.data?.sintaxeOk} isError=${bad.isError} returnCode=${bad.data?.returnCode} erros=${bad.data?.erros}`
  );
  check(
    "erro aponta arquivo e linha (string aberta na linha 4/5)",
    (bad.data?.diagnosticos ?? []).some((d) => d.severidade === "erro" && /zTstE2eRo.prw$/i.test(d.arquivo) && (d.linha === 4 || d.linha === 5)),
    JSON.stringify(bad.data?.diagnosticos)
  );

  const forRes = await call("tds_syntax_check", { arquivos: [forFile] });
  check(
    "For com variável não Local -> sintaxeOk=true com aviso W0004 (linter mais rigoroso que o compilador)",
    forRes.data?.sintaxeOk === true && (forRes.data?.diagnosticos ?? []).some((d) => d.severidade === "aviso" && /W0004/.test(d.mensagem)),
    JSON.stringify(forRes.data?.diagnosticos)
  );

  const objs = await call("tds_rpo_objects", { filtro: "ZTSTMCP", limite: 3 });
  check("inspetor de RPO responde", typeof objs.data?.totalNoRPO === "number", `${objs.data?.totalNoRPO} objetos no RPO`);
} finally {
  await mcp.close().catch(() => {});
  fs.rmSync(badFile, { force: true });
  fs.rmSync(forFile, { force: true });
}

console.log(falhas === 0 ? "\nE2E READ-ONLY OK" : `\n${falhas} VERIFICACAO(OES) FALHARAM`);
process.exit(falhas === 0 ? 0 : 1);
