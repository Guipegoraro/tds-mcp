// Teste da localização do TOTVS WebAgent — não precisa de AppServer nem de agente instalado.
// Uso: node test/webagent.test.mjs
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { comAgente, resolveWebAgentPath } from "../dist/webagent.js";

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-wa-"));
const envAntes = { LOCALAPPDATA: process.env.LOCALAPPDATA, TDS_MCP_WEBAGENT: process.env.TDS_MCP_WEBAGENT };
try {
  const pastaAgente = path.join(dir, "agente");
  fs.mkdirSync(pastaAgente);
  const exe = path.join(pastaAgente, "web-agent.exe");
  fs.writeFileSync(exe, "");
  delete process.env.TDS_MCP_WEBAGENT;
  process.env.LOCALAPPDATA = path.join(dir, "vazio");

  check("config com o executável", resolveWebAgentPath(exe) === exe);
  check("config com a pasta do agente", resolveWebAgentPath(pastaAgente) === exe);
  check("config inexistente é erro, não troca de agente", /não aponta/.test(erroDe(() => resolveWebAgentPath(path.join(dir, "nada")))));
  check("sem config nem instalação: nenhum agente", resolveWebAgentPath() === undefined);

  process.env.TDS_MCP_WEBAGENT = pastaAgente;
  check("TDS_MCP_WEBAGENT vale quando não há config", resolveWebAgentPath() === exe);
  delete process.env.TDS_MCP_WEBAGENT;

  const instalado = path.join(dir, "local", "Programs", "web-agent");
  fs.mkdirSync(instalado, { recursive: true });
  fs.writeFileSync(path.join(instalado, "web-agent.exe"), "");
  process.env.LOCALAPPDATA = path.join(dir, "local");
  check("agente instalado do usuário é achado", resolveWebAgentPath() === path.join(instalado, "web-agent.exe"));
  check("config vence a instalação", resolveWebAgentPath(exe) === exe);

  check("porta acrescentada à url com parâmetros", comAgente("http://h/webapp/?DEBUG=1&P=x", 21031) === "http://h/webapp/?DEBUG=1&P=x&AGENT-PORT=21031");
  check("porta acrescentada à url sem parâmetros", comAgente("http://h/webapp/", 21031) === "http://h/webapp/?AGENT-PORT=21031");
} finally {
  for (const [k, v] of Object.entries(envAntes)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DO WEBAGENT PASSARAM");
