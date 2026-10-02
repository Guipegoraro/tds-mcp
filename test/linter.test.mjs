// Teste do linter local (tds_syntax_check) — usa o advpls instalado, não precisa de AppServer.
// Uso: node test/linter.test.mjs
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lintFiles } from "../dist/linter.js";
import { resolveAdvplsPath } from "../dist/advpls.js";

let advpls;
try {
  advpls = resolveAdvplsPath();
} catch (e) {
  console.log(`SKIP  advpls não encontrado (${e.message})`);
  process.exit(0);
}
// O linter precisa da pasta de include real (inclui PRTOPDEF.CH implicitamente):
// usa a primeira pasta existente do servers.json do TDS.
let includes = [];
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".totvsls", "servers.json"), "utf8"));
  const todas = [...(cfg.includes ?? []), ...cfg.configurations.flatMap((s) => s.includes ?? [])];
  includes = todas.filter((d) => d && fs.existsSync(path.join(d, "prtopdef.ch"))).slice(0, 1);
} catch {
  /* sem servers.json */
}
if (includes.length === 0) {
  console.log("SKIP  nenhuma pasta de include com prtopdef.ch no servers.json");
  process.exit(0);
}

let falhas = 0;
function check(nome, condicao, detalhe = "") {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-lint-"));
const ok = path.join(dir, "zLintOk.prw");
const err = path.join(dir, "zLintErr.prw");
const w4 = path.join(dir, "zLintW4.prw");
const cp = path.join(dir, "zLintCp.prw");
fs.writeFileSync(ok, "User Function zLintOk()\r\n    Local nX := 1\r\nReturn nX\r\n", "latin1");
fs.writeFileSync(err, "User Function zLintErr()\r\n    Local nY := 0\r\n    nY := Soma(1,\r\nReturn nY\r\n", "latin1");
fs.writeFileSync(w4, "User Function zLintW4()\r\n    Private nK := 0\r\n    For nK := 1 To 2\r\n    Next nK\r\nReturn nK\r\n", "latin1");
// 0x80 (euro) e 0x93/0x94 (aspas curvas) só existem em CP1252
fs.writeFileSync(
  cp,
  Buffer.concat([
    Buffer.from('User Function zLintCp()\r\n    Local cX := "', "latin1"),
    Buffer.from([0x80, 0x20, 0x93, 0x61, 0x94]),
    Buffer.from('"\r\nReturn cX\r\n', "latin1"),
  ])
);

try {
  const r = await lintFiles(advpls, [ok, err, w4, cp], includes);
  const de = (f) => r.diagnosticos.filter((d) => d.arquivo === f);
  check("todos os fontes responderam", r.semResposta.length === 0, r.semResposta.join(", "));
  check("fonte válido sem diagnóstico", de(ok).length === 0, JSON.stringify(de(ok)));
  check(
    "parêntese aberto vira erro na linha 3",
    de(err).some((d) => d.severidade === "erro" && d.linha === 3),
    JSON.stringify(de(err))
  );
  check(
    "variável não Local no For é rebaixada a aviso W0004",
    de(w4).length > 0 && de(w4).every((d) => d.severidade !== "erro") && de(w4).some((d) => /W0004/.test(d.mensagem)),
    JSON.stringify(de(w4))
  );
  check("caracteres CP1252 (euro, aspas curvas) não geram erro", de(cp).every((d) => d.severidade !== "erro"), JSON.stringify(de(cp)));

  // Verificações seguidas: notificação escrita depois do kill não pode virar
  // rejeição sem tratamento (no MCP ela derrubaria o processo).
  const soltas = [];
  const onRejection = (e) => soltas.push(e?.code ?? String(e));
  process.on("unhandledRejection", onRejection);
  for (let n = 0; n < 3; n++) await lintFiles(advpls, [ok], includes);
  await new Promise((r) => setTimeout(r, 1500));
  process.off("unhandledRejection", onRejection);
  check("verificações seguidas sem rejeição sem tratamento", soltas.length === 0, soltas.join(", "));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DO LINTER PASSARAM");
