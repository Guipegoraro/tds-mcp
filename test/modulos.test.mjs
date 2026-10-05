// Teste do programa inicial com módulo (SIGABPM) — não precisa de AppServer.
// Uso: node test/modulos.test.mjs
import assert from "node:assert/strict";
import { programaInicial, resolveModulo } from "../dist/modulos.js";

let falhas = 0;
function check(nome, condicao, detalhe = "") {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}
function erroDe(fn) {
  try {
    fn();
    return "";
  } catch (e) {
    return e.message;
  }
}

for (const [entrada, esperado] of [["4", "04"], ["04", "04"], ["SIGAEST", "04"], ["est", "04"], ["sigafat", "05"], ["34", "34"]]) {
  check(`módulo "${entrada}" -> ${esperado}`, resolveModulo(entrada) === esperado, resolveModulo(entrada));
}
for (const entrada of ["SIGAXYZ", "0", "estoque", "123"]) {
  check(`módulo "${entrada}" é recusado pedindo o código`, /código numérico/.test(erroDe(() => resolveModulo(entrada))));
}

const semModulo = programaInicial("u_zRot", ["a", "b"]);
check("sem módulo a função é o programa inicial", semModulo.programa === "u_zRot" && semModulo.argumentos.join() === "a,b");

const comModulo = programaInicial("u_zRot", [], "SIGAEST");
check(
  "com módulo abre pelo SIGABPM com código e rotina",
  comModulo.programa === "SIGABPM" && JSON.stringify(comModulo.argumentos) === '["04","u_zRot"]' && comModulo.codigoModulo === "04",
  JSON.stringify(comModulo)
);

check("módulo com argumentos é recusado", /sem argumentos/.test(erroDe(() => programaInicial("u_zRot", ["x"], "04"))));
for (const p of ["SIGAMDI", "sigabpm", "SIGAADV", "SIGAEST"]) {
  check(`programa ${p} é recusado apontando modulo`, /use|modulo/.test(erroDe(() => programaInicial(p, []))), erroDe(() => programaInicial(p, [])));
}
check("rotina que só começa com siga no meio não é recusada", programaInicial("u_SigaRel", []).programa === "u_SigaRel");

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DE MODULO PASSARAM");
