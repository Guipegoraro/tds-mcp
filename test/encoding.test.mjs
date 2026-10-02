// Teste da deteccao de encoding — nao precisa de AppServer.
// Uso: node test/encoding.test.mjs
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkFile, detectEncoding, isTextSource, utf8AccentLines } from "../dist/encoding.js";

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
  {
    nome: "CP1252 com caixa alta acentuada (AÇÃO, SÃO) -> cp1252",
    buf: Buffer.from('cTit := "AÇÃO SÃO PAULO NEGOCIAÇÃO"\n', "latin1"),
    esperado: "cp1252",
  },
  {
    nome: "CP1252 com trecho UTF-8 -> misto (BLOQUEIA)",
    buf: Buffer.concat([
      Buffer.from('cA := "Inclusão"\n', "latin1"),
      Buffer.from('cB := "Exclusão"\n', "utf8"),
    ]),
    esperado: "misto",
  },
  {
    nome: "UTF-16 LE com BOM -> utf16 (BLOQUEIA)",
    buf: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("User Function x()\n", "utf16le")]),
    esperado: "utf16",
  },
  {
    nome: "UTF-16 LE sem BOM (bytes NUL) -> utf16 (BLOQUEIA)",
    buf: Buffer.from("User Function x()\n", "utf16le"),
    esperado: "utf16",
  },
];

let falhas = 0;
for (const c of casos) {
  const kind = detectEncoding(c.buf);
  const ok = kind === c.esperado;
  if (!ok) falhas++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.nome}\n      detectado=${kind} esperado=${c.esperado}`);
}

// Fonte misto: aponta as linhas com UTF-8
{
  const buf = Buffer.concat([
    Buffer.from('cA := "Inclusão"\n', "latin1"),
    Buffer.from("// ok\n", "latin1"),
    Buffer.from('cB := "Exclusão"\n', "utf8"),
  ]);
  const linhas = utf8AccentLines(buf);
  const ok = JSON.stringify(linhas) === "[3]";
  if (!ok) falhas++;
  console.log(`${ok ? "PASS" : "FAIL"}  fonte misto aponta a linha com UTF-8\n      linhas=${JSON.stringify(linhas)}`);
}

// Conversão de UTF-8 escrita de propósito num fonte CP1252
{
  // StrTran(cTxt, "Ã§", "ç"): a linha tem a sequência C3 A7 e também o "ç" CP1252 (E7)
  const legitima = Buffer.concat([
    Buffer.from('cA := "Inclusão"\r\n', "latin1"),
    Buffer.from('cTxt := StrTran(cTxt, "', "latin1"),
    Buffer.from([0xc3, 0xa7]),
    Buffer.from('", "ç")\r\n', "latin1"),
  ]);
  const k1 = detectEncoding(legitima);
  if (k1 !== "cp1252") falhas++;
  console.log(`${k1 === "cp1252" ? "PASS" : "FAIL"}  conversão com acento CP1252 na mesma linha -> cp1252\n      detectado=${k1}`);

  // Tabela só com a sequência UTF-8 na linha: não dá para distinguir, segue bloqueada
  const tabela = Buffer.concat([
    Buffer.from('cA := "Inclusão"\r\n', "latin1"),
    Buffer.from('aAdd(aTab, {"', "latin1"),
    Buffer.from([0xc3, 0xa7]),
    Buffer.from('", "c"})\r\n', "latin1"),
  ]);
  const linhas = utf8AccentLines(tabela);
  const ok = detectEncoding(tabela) === "misto" && JSON.stringify(linhas) === "[2]";
  if (!ok) falhas++;
  console.log(`${ok ? "PASS" : "FAIL"}  linha só com a sequência UTF-8 -> misto, linha 2\n      linhas=${JSON.stringify(linhas)}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-enc-"));
  const f = path.join(dir, "zTab.prw");
  fs.writeFileSync(f, tabela);
  const bloqueado = checkFile(f);
  const liberado = checkFile(f, true);
  const ok2 = !bloqueado.safe && liberado.safe && liberado.kind === "misto";
  if (!ok2) falhas++;
  console.log(`${ok2 ? "PASS" : "FAIL"}  misto bloqueia, e aceitarMisto libera mantendo o tipo`);
  fs.rmSync(dir, { recursive: true, force: true });
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
