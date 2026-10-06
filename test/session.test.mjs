// Teste da escolha de servidor, do token salvo e das mensagens de autenticação — não precisa de AppServer.
// Uso: node test/session.test.mjs
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findServer, savedTokenFor, SessionManager } from "../dist/session.js";

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

// Falha de autenticação em que o AppServer não abriu o ambiente: o erro aponta a causa provável.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-sess-"));
  const servers = path.join(dir, "servers.json");
  fs.writeFileSync(servers, JSON.stringify({ configurations: [{ id: "x1", name: "Dev", address: "localhost", port: 1, environment: "AMB" }] }));
  const antes = process.env.TDS_MCP_SERVERS_JSON;
  process.env.TDS_MCP_SERVERS_JSON = servers;
  const falha = (msg) => ({
    validation: async () => ({ build: "7.00.240223P", secure: 0 }),
    connect: async () => ({ connectionToken: "c1", needAuthentication: true }),
    authenticate: async () => {
      throw new Error(msg);
    },
  });
  const erroDe = async (client) => {
    try {
      await new SessionManager(client, { credentials: { Dev: { user: "u", password: "p" } } }).useServer("Dev");
      return "";
    } catch (e) {
      return e.message;
    }
  };
  try {
    const e1 = await erroDe(falha("Authentication error: Server returned a non numeric value. See AppServer log console for details."));
    check("'non numeric value' explica que o ambiente não abriu e aponta o console.log", /não conseguiu abrir o ambiente "AMB"/.test(e1) && /-35/.test(e1) && /console.log/.test(e1), e1);
    const e2 = await erroDe(falha("Invalid user or password"));
    check("outra falha de autenticação passa sem acréscimo", e2 === "Invalid user or password", e2);
  } finally {
    if (antes === undefined) delete process.env.TDS_MCP_SERVERS_JSON;
    else process.env.TDS_MCP_SERVERS_JSON = antes;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DE SESSAO PASSARAM");
