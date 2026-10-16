// Teste do PPO pelo advpls appre (tds_generate_ppo) — usa o advpls do config, não precisa de AppServer.
// Uso: node test/ppo.test.mjs
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gerarPpo } from "../dist/ppo.js";
import { resolveAdvplsPath } from "../dist/advpls.js";
import { loadConfig } from "../dist/config.js";
import { readServersJson } from "../dist/session.js";

let advpls;
try {
  advpls = resolveAdvplsPath(loadConfig().advplsPath);
} catch (e) {
  console.log(`SKIP  advpls não encontrado (${e.message})`);
  process.exit(0);
}
let includes = [];
try {
  includes = (readServersJson().includes ?? []).filter((d) => d && fs.existsSync(d));
} catch {
  /* sem servers.json */
}
if (includes.length === 0) {
  console.log("SKIP  nenhuma pasta de include do servers.json existe nesta máquina");
  process.exit(0);
}

let falhas = 0;
function check(nome, ok, detalhe) {
  if (!ok) falhas++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-ppo-"));
const tmpBase = path.join(os.tmpdir(), "tds-mcp");
const ppoDirs = () => (fs.existsSync(tmpBase) ? fs.readdirSync(tmpBase).filter((n) => n.startsWith("ppo-")) : []);
const antes = new Set(ppoDirs());
try {
  const ok = path.join(dir, "zPpoOk.prw");
  fs.writeFileSync(ok, '#include "totvs.ch"\r\n#include "zppolocal.ch"\r\nUser Function zPpoOk()\r\nReturn ZPPO_VALOR\r\n', "latin1");
  fs.writeFileSync(path.join(dir, "zppolocal.ch"), "#define ZPPO_VALOR 42\r\n", "latin1");
  const r1 = await gerarPpo(advpls, ok, includes);
  check("PPO gerado com o .ch da pasta do fonte e o define expandido", !!r1.ppo && /Return 42/.test(r1.ppo), JSON.stringify(r1.erros));
  check(
    "#line aponta o fonte original, não a cópia temporária",
    !!r1.ppo && r1.ppo.toLowerCase().includes(dir.toLowerCase()) && !/\\tds-mcp\\ppo-/i.test(r1.ppo)
  );

  const ruim = path.join(dir, "zPpoErr.prw");
  fs.writeFileSync(ruim, '#include "totvs.ch"\r\n#include "naoexiste_zppo.ch"\r\nUser Function zPpoErr()\r\nReturn\r\n', "latin1");
  const r2 = await gerarPpo(advpls, ruim, includes);
  check(
    "include inexistente vira erro com o nome do fonte e a linha",
    !r2.ppo && r2.erros.some((e) => /zPpoErr\.prw\(2\)/i.test(e) && /C2090/.test(e)),
    JSON.stringify(r2.erros)
  );
  check("nenhum nome APPRE<n> no erro", !r2.erros.some((e) => /APPRE\d+/i.test(e)));

  const sobras = fs.readdirSync(dir).filter((n) => /\.(ppx_|ppo|err)/i.test(n));
  check("nada gravado ao lado do fonte", sobras.length === 0, sobras.join(", "));
  const novas = ppoDirs().filter((n) => !antes.has(n));
  check("pasta temporária removida", novas.length === 0, novas.join(", "));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(falhas === 0 ? "\nTODOS OS CASOS DO PPO PASSARAM" : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
