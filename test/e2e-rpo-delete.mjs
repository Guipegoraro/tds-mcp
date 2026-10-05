// E2E do registro de temporários e do tds_rpo_delete pelo servidor MCP real.
// GRAVA E REMOVE do RPO: rode só em AppServer de desenvolvimento, acompanhado.
// Uso: node test/e2e-rpo-delete.mjs <servidor> [ambiente]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const serverName = process.argv[2] ?? process.env.TDS_MCP_TEST_SERVER;
const environment = process.argv[3] ?? process.env.TDS_MCP_TEST_ENV;
const credenciais = process.env.TDS_MCP_TEST_USER
  ? { usuario: process.env.TDS_MCP_TEST_USER, senha: process.env.TDS_MCP_TEST_PASSWORD ?? "" }
  : {};
if (!serverName) {
  console.error("Uso: node test/e2e-rpo-delete.mjs <servidor> [ambiente]");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-del-"));
const fonte = (nome) => {
  const arquivo = path.join(dir, `${nome}.prw`);
  fs.writeFileSync(
    arquivo,
    `#include "totvs.ch"\r\n\r\n/*/{Protheus.doc} ${nome}\r\nFonte temporario do E2E de remocao do RPO.\r\n` +
      `@type user function\r\n@author tds-mcp\r\n@since 05/10/2026\r\n@return logical, sempre .T.\r\n/*/\r\n` +
      `User Function ${nome}()\r\nReturn .T.\r\n`,
    "latin1"
  );
  return arquivo;
};
const DEL1 = fonte("zTstDel1");
const DEL2 = fonte("zTstDel2");

const mcp = new Client({ name: "e2e-rpo-delete", version: "0.0.1" });
await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, "..", "dist", "index.js")] }));
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
const noRpo = async (nome) => ((await call("tds_rpo_objects", { filtro: nome })).data?.objetos ?? []).some((o) => o.fonte === nome);

try {
  const conn = await call("tds_use_server", { servidor: serverName, ambiente: environment, ...credenciais });
  check("conecta no servidor", conn.data?.conectado === true, `${conn.data?.servidor}/${conn.data?.ambiente}`);

  const c1 = await call("tds_compile", { arquivos: [DEL1], temporario: true, recompile: true });
  check(
    "compila zTstDel1 como temporário e registra",
    c1.data?.sucesso === true && (c1.data?.registradosComoTemporarios ?? []).includes("ZTSTDEL1.PRW"),
    short(c1.data?.registradosComoTemporarios ?? c1.data)
  );
  const c2 = await call("tds_compile", { arquivos: [DEL2], recompile: true });
  check("compila zTstDel2 sem a marca", c2.data?.sucesso === true && !c2.data?.registradosComoTemporarios, short(c2.data?.sucesso));

  const lista = await call("tds_rpo_temporarios");
  const t1 = (lista.data?.temporarios ?? []).find((t) => t.fonte === "ZTSTDEL1.PRW");
  check(
    "tds_rpo_temporarios lista zTstDel1 no RPO e não lista zTstDel2",
    t1?.noRpo === true && !(lista.data?.temporarios ?? []).some((t) => t.fonte === "ZTSTDEL2.PRW"),
    short(lista.data?.temporarios)
  );

  const recusaFora = await call("tds_rpo_delete", { fontes: ["zTstDel2.prw"] });
  check(
    "fonte fora do registro é recusado sem foraDoRegistro e continua no RPO",
    recusaFora.isError && /Não são temporários registrados/.test(recusaFora.data?.erro ?? "") && (await noRpo("ZTSTDEL2.PRW")),
    short(recusaFora.data)
  );

  const recusaMisturada = await call("tds_rpo_delete", { fontes: ["zTstDel1.prw", "zTstDel2.prw"] });
  check(
    "lista com um fonte fora do registro não remove nenhum",
    recusaMisturada.isError && (await noRpo("ZTSTDEL1.PRW")) && (await noRpo("ZTSTDEL2.PRW")),
    short(recusaMisturada.data)
  );

  const ausente = await call("tds_rpo_delete", { fontes: ["ZTSTNAOEXISTE.PRW", "zTstDel2.prw"], foraDoRegistro: true });
  check(
    "nome ausente do RPO recusa a lista inteira",
    ausente.isError && /Não estão no RPO/.test(ausente.data?.erro ?? "") && (await noRpo("ZTSTDEL2.PRW")),
    short(ausente.data)
  );

  // Objeto oficial TOTVS: o tds-mcp recusa antes de enviar qualquer remoção.
  const padrao = (await call("tds_rpo_objects", { filtro: "MATA010", limite: 5 })).data?.objetos?.[0]?.fonte;
  const oficial = await call("tds_rpo_delete", { fontes: [padrao], foraDoRegistro: true });
  check(
    `objeto oficial TOTVS (${padrao}) é recusado e continua no RPO`,
    !!padrao && oficial.isError && /oficiais TOTVS/.test(oficial.data?.erro ?? "") && (await noRpo(padrao)),
    short(oficial.data)
  );

  await call("tds_debug_start", { programa: "u_zTstDel1", modo: "navegador" });
  const emDebug = await call("tds_rpo_delete", { fontes: ["zTstDel1.prw"] });
  await call("tds_debug_stop");
  check(
    "remoção é recusada com depuração ativa",
    emDebug.isError && /depuração ativa/.test(emDebug.data?.erro ?? "") && (await noRpo("ZTSTDEL1.PRW")),
    short(emDebug.data)
  );

  const del1 = await call("tds_rpo_delete", { fontes: [DEL1] });
  const depois = await call("tds_rpo_temporarios");
  check(
    "remove o temporário pelo caminho e tira do registro",
    !del1.isError &&
      (del1.data?.removidos ?? []).includes("ZTSTDEL1.PRW") &&
      !(await noRpo("ZTSTDEL1.PRW")) &&
      !(depois.data?.temporarios ?? []).some((t) => t.fonte === "ZTSTDEL1.PRW"),
    short(del1.data)
  );

  const del2 = await call("tds_rpo_delete", { fontes: ["ZTSTDEL2.PRW"], foraDoRegistro: true });
  check(
    "foraDoRegistro remove fonte fora do registro",
    !del2.isError && (del2.data?.removidos ?? []).includes("ZTSTDEL2.PRW") && !(await noRpo("ZTSTDEL2.PRW")),
    short(del2.data)
  );
} finally {
  await call("tds_debug_stop").catch(() => {});
  await mcp.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(falhas === 0 ? "\nE2E RPO DELETE OK" : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
