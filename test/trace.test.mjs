// Teste de nomes e pastas de patch — não precisa de AppServer.
// Uso: node test/trace.test.mjs
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { slugify, ensurePatchDir, patchBaseName } from "../dist/trace.js";

let falhas = 0;
function check(nome, condicao, detalhe = "") {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}

check("slug remove acento e espaço", slugify("Ação Comercial 01") === "acao-comercial-01", slugify("Ação Comercial 01"));

const outer = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-trace-"));
const root = path.join(outer, "patches");
fs.mkdirSync(root);
try {
  const dir = ensurePatchDir(root, "Cliente X", "TCK-123");
  check("pasta do ticket fica dentro da raiz", path.relative(root, dir) === path.join("cliente-x", "tck-123"), dir);

  for (const [cliente, ticket] of [["..", "x"], ["x", ".."], ["...", "x"], ["", "x"], ["x", "///"]]) {
    let erro = "";
    try {
      ensurePatchDir(root, cliente, ticket);
    } catch (e) {
      erro = e.message;
    }
    check(`cliente="${cliente}" ticket="${ticket}" é recusado`, /inválido/.test(erro), erro);
  }
  check("nada foi criado fora da raiz", JSON.stringify(fs.readdirSync(outer)) === '["patches"]', fs.readdirSync(outer).join(", "));

  const stamp = { fileStamp: "021026_1530", fileStampSeconds: "021026_153012" };
  check("nome-base começa pela data", patchBaseName(stamp, "TCK 1") === "021026_1530_tck-1");
} finally {
  fs.rmSync(outer, { recursive: true, force: true });
}

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DE PATCH PASSARAM");
