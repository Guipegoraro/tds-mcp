// Teste da escolha de servidor, do token salvo, das mensagens de autenticação, do TLS usado pela sessão e da
// URL do webapp — não precisa de AppServer.
// Uso: node test/session.test.mjs
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { conexaoPerdida, findServer, portaAceita, savedTokenFor, SessionManager, webappUrlFor } from "../dist/session.js";

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
    check("'non numeric value' explica que o ambiente não abriu e aponta o console.log", /não conseguiu abrir o ambiente "AMB"/.test(e1) && /-35/.test(e1) && /SpecialKey diferente/.test(e1) && /console.log/.test(e1), e1);
    const e2 = await erroDe(falha("Invalid user or password"));
    check("outra falha de autenticação passa sem acréscimo", e2 === "Invalid user or password", e2);
  } finally {
    if (antes === undefined) delete process.env.TDS_MCP_SERVERS_JSON;
    else process.env.TDS_MCP_SERVERS_JSON = antes;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// TLS da sessão: o detectado na validação vale sobre o `secure` do servers.json (appserver.ini trocado depois do cadastro).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-sess-"));
  const servers = path.join(dir, "servers.json");
  fs.writeFileSync(
    servers,
    JSON.stringify({ configurations: [{ id: "x1", name: "Dev", address: "localhost", port: 1, environment: "AMB", secure: false, buildVersion: "7.00.240223P" }] })
  );
  const antes = process.env.TDS_MCP_SERVERS_JSON;
  process.env.TDS_MCP_SERVERS_JSON = servers;
  const cliente = (validation) => ({
    validation,
    connect: async (info) => ({ connectionToken: `c-${info.secure ? "tls" : "tcp"}`, needAuthentication: true }),
    authenticate: async (info) => ({ connectionToken: `a-${info.connectionToken}` }),
  });
  const config = { credentials: { Dev: { user: "u", password: "p" } } };
  try {
    const tls = await new SessionManager(cliente(async () => ({ build: "7.00.240223P", secure: 1 })), config).useServer("Dev");
    check("servidor passou a TLS: sessão com secure detectado e conexão segura", tls.secure === true && tls.connectionToken === "a-c-tls", JSON.stringify(tls));
    const semValidacao = await new SessionManager(
      cliente(async () => {
        throw new Error("timeout");
      }),
      config
    ).useServer("Dev");
    check("validação sem resposta: vale o secure do servers.json", semValidacao.secure === false, JSON.stringify(semValidacao));
  } finally {
    if (antes === undefined) delete process.env.TDS_MCP_SERVERS_JSON;
    else process.env.TDS_MCP_SERVERS_JSON = antes;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Troca de servidor: a sessão anterior só cai depois que a nova conecta; reconexão refaz o último pedido.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-sess-"));
  const servers = path.join(dir, "servers.json");
  // Porta 1 em localhost não aceita conexão: a falha de conexão diz isso.
  fs.writeFileSync(
    servers,
    JSON.stringify({
      configurations: [
        { id: "a1", name: "Bom", address: "localhost", port: 1, environment: "AMB" },
        { id: "b2", name: "Fora", address: "localhost", port: 1, environment: "AMB" },
        { id: "c3", name: "Outro", address: "localhost", port: 1, environment: "AMB" },
      ],
    })
  );
  const antes = process.env.TDS_MCP_SERVERS_JSON;
  process.env.TDS_MCP_SERVERS_JSON = servers;
  let seq = 0;
  const desconectados = [];
  const cliente = {
    validation: async () => ({ build: "7.00.240223P", secure: 0 }),
    connect: async (info) => {
      if (info.serverName === "Fora") throw new Error("An error ocurred while connection.");
      return { connectionToken: `c${++seq}`, needAuthentication: false };
    },
    disconnect: async (name, token) => desconectados.push(`${name}:${token}`),
  };
  try {
    const sm = new SessionManager(cliente, { credentials: {} });
    await sm.useServer("Bom");
    let erroTroca = "";
    try {
      await sm.useServer("Fora");
    } catch (e) {
      erroTroca = e.message;
    }
    check("nova conexão falha: a sessão anterior continua ativa", sm.current?.def.name === "Bom" && sm.current.connectionToken === "c1" && desconectados.length === 0, JSON.stringify({ atual: sm.current?.def.name, desconectados }));
    check("falha de conexão com porta fechada aponta servidor, VPN ou porta", /não aceita conexão/.test(erroTroca) && /VPN/.test(erroTroca), erroTroca);
    await sm.useServer("Bom");
    // O advpls desconecta pelo nome: no mesmo servidor, a anterior não é desconectada (derrubaria a nova).
    check("mesmo servidor de novo: a anterior não é desconectada", sm.current.connectionToken === "c2" && desconectados.length === 0, desconectados.join());
    const refeita = await sm.reconnect();
    check("reconexão refaz o último pedido", refeita.connectionToken === "c3" && refeita.environment === "AMB" && desconectados.length === 0, JSON.stringify({ refeita, desconectados }));
    await sm.useServer("Outro");
    check("outro servidor conecta: a anterior é desconectada depois", sm.current.def.name === "Outro" && desconectados.join() === "Bom:c3", desconectados.join());
    const antesConcorrente = seq;
    const [r1, r2] = await Promise.all([sm.reconnect(), sm.reconnect()]);
    check("duas reconexões ao mesmo tempo viram uma só", r1 === r2 && seq === antesConcorrente + 1 && sm.current === r1, JSON.stringify({ seq, antesConcorrente }));
  } finally {
    if (antes === undefined) delete process.env.TDS_MCP_SERVERS_JSON;
    else process.env.TDS_MCP_SERVERS_JSON = antes;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Autenticação recusada em outro servidor: a conexão aberta para ela é desconectada; no nome da ativa, não.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-sess-"));
  const servers = path.join(dir, "servers.json");
  fs.writeFileSync(
    servers,
    JSON.stringify({
      configurations: [
        { id: "a1", name: "Ativo", address: "localhost", port: 1, environment: "AMB" },
        { id: "b2", name: "Senha", address: "localhost", port: 1, environment: "AMB" },
      ],
    })
  );
  const antes = process.env.TDS_MCP_SERVERS_JSON;
  process.env.TDS_MCP_SERVERS_JSON = servers;
  let seq = 0;
  const desconectados = [];
  const cliente = {
    validation: async () => ({ build: "7.00.240223P", secure: 0 }),
    connect: async () => ({ connectionToken: `c${++seq}`, needAuthentication: true }),
    authenticate: async (info) => {
      if (info.password !== "certa") throw new Error("Invalid user and/or password.");
      return { connectionToken: `a-${info.connectionToken}` };
    },
    disconnect: async (name, token) => desconectados.push(`${name}:${token}`),
  };
  try {
    const sm = new SessionManager(cliente, { credentials: {} });
    await sm.useServer("Ativo", undefined, { user: "u", password: "certa" });
    await sm.useServer("Senha", undefined, { user: "u", password: "errada" }).catch(() => undefined);
    check("senha errada em outro servidor: a conexão dele é desconectada, a ativa fica", desconectados.join() === "Senha:c2" && sm.current.def.name === "Ativo", desconectados.join());
    await sm.useServer("Ativo", undefined, { user: "u", password: "errada" }).catch(() => undefined);
    check("senha errada no nome da ativa: nada é desconectado", desconectados.join() === "Senha:c2" && sm.current.def.name === "Ativo", desconectados.join());
  } finally {
    if (antes === undefined) delete process.env.TDS_MCP_SERVERS_JSON;
    else process.env.TDS_MCP_SERVERS_JSON = antes;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Conexão perdida: as mensagens do advpls que pedem reconexão.
check("autoReconnect é conexão perdida", conexaoPerdida("An error ocurred while autoReconnect.\n\rServer: h:1614 [Dev]"));
check("40820 é conexão perdida", conexaoPerdida("returnCode 40820"));
check("outra falha não é conexão perdida", !conexaoPerdida("Invalid user or password") && !conexaoPerdida("porta 408201"));

// Porta: aberta e fechada.
{
  const net = await import("node:net");
  const srv = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const porta = srv.address().port;
  check("porta que escuta aceita conexão", await portaAceita("127.0.0.1", porta));
  srv.close();
  check("porta 1 não aceita conexão", !(await portaAceita("127.0.0.1", 1, 2000)));
}

// URL do webapp: config > endereço com esquema > TLS da sessão.
{
  const sessao = (secure, address = "srv") => ({ def: { name: "Dev", address, port: 1234 }, secure });
  check("TLS na sessão: https", webappUrlFor(sessao(true)) === "https://srv:1234/webapp/");
  check("sem TLS: http", webappUrlFor(sessao(false)) === "http://srv:1234/webapp/");
  check("webappUrls do config vence, com a barra final", webappUrlFor(sessao(true), { Dev: "http://h:8080/webapp" }) === "http://h:8080/webapp/");
  check("endereço com esquema é usado como está", webappUrlFor(sessao(false, "https://nuvem.x")) === "https://nuvem.x:1234/webapp/");
}

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DE SESSAO PASSARAM");
