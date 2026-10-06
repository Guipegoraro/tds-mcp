// Teste do TOTVS WebAgent (localização, porta no localStorage, encerramento) — não precisa de AppServer nem de agente instalado.
// Uso: node test/webagent.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { comAgente, resolveWebAgentPath, SCRIPT_PORTA_AGENTE, WebAgentInstance } from "../dist/webagent.js";

let falhas = 0;
function check(nome, condicao, detalhe = "") {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vivo = (p) => p.exitCode === null && p.signalCode === null;

/** Roda o script da porta como o navegador, com a URL dada; devolve o localStorage gravado. */
function rodarScriptPorta(search) {
  const gravado = {};
  vm.runInNewContext(SCRIPT_PORTA_AGENTE, {
    location: { search },
    URLSearchParams,
    localStorage: { setItem: (k, v) => (gravado[k] = v) },
  });
  return gravado;
}

/** Instância sobre um processo qualquer, com o web-agent.log dado (o construtor só é privado no TypeScript). */
function agenteFalso(dir, log) {
  const pasta = fs.mkdtempSync(path.join(dir, "wa-"));
  fs.writeFileSync(path.join(pasta, "web-agent.log"), log);
  const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  return { agente: new WebAgentInstance("web-agent.exe", 1, pasta, proc), proc, pasta };
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

  // O webapp informa ao AppServer a porta do agente lida do localStorage; o script a grava antes da página carregar.
  check("script grava a porta do AGENT-PORT", rodarScriptPorta("?DEBUG=1&P=x&AGENT-PORT=21031").desktopagentport === "21031");
  check("script aceita o parâmetro em minúsculas", rodarScriptPorta("?agent-port=21031").desktopagentport === "21031");
  check("url sem AGENT-PORT não mexe no localStorage", Object.keys(rodarScriptPorta("?DEBUG=1&P=x")).length === 0);
  check("porta inválida não é gravada", Object.keys(rodarScriptPorta("?AGENT-PORT=abc")).length === 0);

  // Encerramento do agente da sessão do modo navegador.
  const HANDSHAKE = "WebAgent has just started on port 1!\n[x] Handshake success!\n";
  const SAIU = "[x]  Sz 0000064\tRCV Action (stop-broker)\nstop-broker\n[x]  Sz 0000005\tSND Action (stop-broker)\n";

  const semPagina = agenteFalso(dir, "WebAgent has just started on port 1!\n");
  semPagina.agente.encerrarAoSairDaPagina(60000);
  await sleep(500);
  check("agente sem página conectada encerra na hora e apaga a pasta", !vivo(semPagina.proc) && !fs.existsSync(semPagina.pasta));

  const comPagina = agenteFalso(dir, HANDSHAKE + "[x] TMAIN_THREAD RCV (MS_GETRMTINFO)\n");
  comPagina.agente.encerrarAoSairDaPagina(60000);
  await sleep(5000);
  check("agente com a página ligada continua vivo", vivo(comPagina.proc) && fs.existsSync(comPagina.pasta));
  fs.appendFileSync(path.join(comPagina.pasta, "web-agent.log"), SAIU);
  await sleep(6000);
  check("depois do stop-broker o agente encerra e a pasta sai", !vivo(comPagina.proc) && !fs.existsSync(comPagina.pasta));

  const semFim = agenteFalso(dir, HANDSHAKE);
  semFim.agente.encerrarAoSairDaPagina(1500);
  await sleep(3500);
  check("espera limitada: o agente encerra no prazo mesmo com a página ligada", !vivo(semFim.proc));
} finally {
  for (const [k, v] of Object.entries(envAntes)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DO WEBAGENT PASSARAM");
