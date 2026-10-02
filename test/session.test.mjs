// Teste da escolha de servidor e do token salvo — não precisa de AppServer.
// Uso: node test/session.test.mjs
import assert from "node:assert/strict";
import { findServer, savedTokenFor } from "../dist/session.js";

const cfg = {
  configurations: [
    { id: "a1", name: "CLIENTE_PROD", environment: "PROD", token: "tok-prod" },
    { id: "b2", name: "CLIENTE_HML", environment: "HML", token: "tok-hml" },
    { id: "c3", name: "ProtheusLocal", environment: "DESENVOLVIMENTO", token: "tok-local" },
    { id: "d4", name: "ProtheusLocalRest" },
    { id: "e5", name: "SemAmbiente", token: "tok-livre" },
  ],
  savedTokens: [["c3TESTE", { token: "tok-salvo-teste" }]],
};

let falhas = 0;
function check(nome, condicao, detalhe = "") {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}

// findServer
check("id exato", findServer(cfg, "b2")?.name === "CLIENTE_HML");
check("nome exato sem diferenciar maiúsculas", findServer(cfg, "protheuslocal")?.name === "ProtheusLocal");
check("nome exato vence parte do nome de outro", findServer(cfg, "ProtheusLocal")?.name === "ProtheusLocal");
check("parte única do nome", findServer(cfg, "rest")?.name === "ProtheusLocalRest");
check("nenhum servidor", findServer(cfg, "inexistente") === undefined);
let erro = "";
try {
  findServer(cfg, "cliente");
} catch (e) {
  erro = e.message;
}
check("parte do nome ambígua é recusada listando os candidatos", /CLIENTE_PROD/.test(erro) && /CLIENTE_HML/.test(erro), erro);

// savedTokenFor
const def = (name) => cfg.configurations.find((s) => s.name === name);
check("token da configuração no mesmo ambiente", savedTokenFor(cfg, def("ProtheusLocal"), "DESENVOLVIMENTO") === "tok-local");
check("ambiente comparado sem diferenciar maiúsculas", savedTokenFor(cfg, def("ProtheusLocal"), "desenvolvimento") === "tok-local");
check("savedTokens por <id><ambiente>", savedTokenFor(cfg, def("ProtheusLocal"), "TESTE") === "tok-salvo-teste");
check("token de outro ambiente não é usado", savedTokenFor(cfg, def("CLIENTE_PROD"), "HML") === undefined);
check("configuração sem ambiente registrado usa o token", savedTokenFor(cfg, def("SemAmbiente"), "QUALQUER") === "tok-livre");

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DE SESSAO PASSARAM");
