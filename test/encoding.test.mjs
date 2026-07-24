// Teste da deteccao de encoding — nao precisa de AppServer.
// Uso: node test/encoding.test.mjs
import assert from "node:assert/strict";
import { detectEncoding, isTextSource } from "../dist/encoding.js";

const casos = [
  {
    nome: "ASCII puro -> ascii (seguro nos dois encodings)",
    buf: Buffer.from('User Function zTeste()\n    ConOut("ok")\nReturn\n', "ascii"),
    esperado: "ascii",
  },
  {
    nome: "CP1252 com acentos -> cp1252 (bytes nao formam UTF-8 valido)",
    buf: Buffer.from('cMsg := "Inclusão não permitida"\n', "latin1"),
    esperado: "cp1252",
  },
  {
    nome: "UTF-8 com acentos -> utf8 (BLOQUEIA)",
    buf: Buffer.from('cMsg := "Inclusão não permitida"\n', "utf8"),
    esperado: "utf8",
  },
  {
    nome: "UTF-8 com BOM -> utf8-bom (BLOQUEIA)",
    buf: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("User Function x()\n", "utf8")]),
    esperado: "utf8-bom",
  },
  {
    nome: "CP1252 com c-cedilha isolado -> cp1252",
    buf: Buffer.from([0x63, 0xe7, 0xe3, 0x6f]), // "ção" em CP1252
    esperado: "cp1252",
  },
];

let falhas = 0;
for (const c of casos) {
  const kind = detectEncoding(c.buf);
  const ok = kind === c.esperado;
  if (!ok) falhas++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.nome}\n      detectado=${kind} esperado=${c.esperado}`);
}

// Recursos binarios nao devem ser checados como texto
const binarios = ["logo.png", "icone.bmp", "arquivo.res"];
for (const f of binarios) {
  const ok = !isTextSource(f);
  if (!ok) falhas++;
  console.log(`${ok ? "PASS" : "FAIL"}  recurso binario ignorado na checagem: ${f}`);
}
for (const f of ["fonte.prw", "fonte.tlpp", "trad.tres"]) {
  const ok = isTextSource(f);
  if (!ok) falhas++;
  console.log(`${ok ? "PASS" : "FAIL"}  fonte de texto checado: ${f}`);
}

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DE ENCODING PASSARAM");
