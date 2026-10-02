// Teste do aviso de breakpoint em linha onde o depurador não para — não precisa de AppServer.
// Uso: node test/breakpointLines.test.mjs
// O mapa para/não para foi medido no AppServer 24.3 com um breakpoint em cada linha.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { breakpointLineWarnings } from "../dist/breakpointLines.js";

const fonte = [
  '#include "protheus.ch"', //  1 diretiva
  "#define LIMITE 2", //        2 diretiva
  "User Function zLin()", //    3 declaração
  "    Local nI := 0", //       4 para
  "    Local nX", //            5 para
  "    If nI == 0", //          6 para
  "        nX := 1", //         7 para
  "    Else", //                8 não para
  "        nX := 2", //         9 para
  "    EndIf", //              10 não para
  "    While nI < LIMITE", //  11 para
  "        nI++", //           12 para
  "    EndDo", //              13 não para
  "    Do Case", //            14 não para
  "    Case nI == 2", //       15 para
  "        nX := 3", //        16 para
  "    OtherWise", //          17 não para
  "    EndCase", //            18 não para
  "    Begin Sequence", //     19 não para
  "        nX := 4", //        20 para
  "    End Sequence", //       21 não para
  "    For nI := 1 To 2", //   22 para
  "    Next nI", //            23 não para
  "    // comentario", //      24 não para
  "", //                       25 em branco
  "    /* bloco", //           26 comentário
  "       continua */", //     27 comentário
  "Return nX", //              28 para
].join("\r\n");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-bp-"));
const file = path.join(dir, "zLin.prw");
fs.writeFileSync(file, fonte, "latin1");

const naoPara = [1, 2, 3, 8, 10, 13, 14, 17, 18, 19, 21, 23, 24, 25, 26, 27];
const para = [4, 5, 6, 7, 9, 11, 12, 15, 16, 20, 22, 28];

let falhas = 0;
for (const n of naoPara) {
  const ok = breakpointLineWarnings(file, [n]).length === 1;
  if (!ok) falhas++;
  console.log(`${ok ? "PASS" : "FAIL"}  linha ${n} avisa (não para): ${fonte.split("\r\n")[n - 1].trim() || "(em branco)"}`);
}
for (const n of para) {
  const ok = breakpointLineWarnings(file, [n]).length === 0;
  if (!ok) falhas++;
  console.log(`${ok ? "PASS" : "FAIL"}  linha ${n} sem aviso (para): ${fonte.split("\r\n")[n - 1].trim()}`);
}
const fora = breakpointLineWarnings(file, [99]);
if (!(fora.length === 1 && /não existe/.test(fora[0]))) falhas++;
console.log(`${fora.length === 1 ? "PASS" : "FAIL"}  linha além do fim avisa`);
fs.rmSync(dir, { recursive: true, force: true });

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DE LINHA DE BREAKPOINT PASSARAM");
