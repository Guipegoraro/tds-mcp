// E2E do TOTVS WebAgent nas execuções do webapp. Exige o WebAgent compatível com o
// webapp do servidor instalado (ou TDS_MCP_WEBAGENT) e test/zTstDbg1.prw compilado
// (rode antes o e2e-debug). Opcional: TDS_MCP_TEST_WEBAGENT_RECUSADO = web-agent.exe
// de uma versão que o webapp recusa, para testar a volta sem agente.
// Uso: node test/e2e-webagent.mjs <servidor> [ambiente]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HeadlessWebapp, resolveChromiumPath } from "../dist/webapp.js";

const serverName = process.argv[2] ?? process.env.TDS_MCP_TEST_SERVER;
const environment = process.argv[3] ?? process.env.TDS_MCP_TEST_ENV;
const credenciais = process.env.TDS_MCP_TEST_USER
  ? { usuario: process.env.TDS_MCP_TEST_USER, senha: process.env.TDS_MCP_TEST_PASSWORD ?? "" }
  : {};
if (!serverName) {
  console.error("Uso: node test/e2e-webagent.mjs <servidor> [ambiente]");
  process.exit(1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "zTstDbg1.prw");
const L_SOMA = fs.readFileSync(SRC, "latin1").split(/\r?\n/).findIndex((l) => l.includes("nTotal += zTstSoma(nI)")) + 1;

let falhas = 0;
function check(nome, condicao, detalhe) {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}
const short = (v) => String(JSON.stringify(v)).slice(0, 300);
const agentesRodando = () => {
  try {
    return execSync('tasklist /FI "IMAGENAME eq web-agent.exe" /FO CSV /NH', { encoding: "utf8" })
      .split(/\r?\n/)
      .filter((l) => /web-agent\.exe/i.test(l)).length;
  } catch {
    return 0;
  }
};

async function abrirMcp(env = {}) {
  const mcp = new Client({ name: "e2e-webagent", version: "0.0.1" });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(here, "..", "dist", "index.js")],
      env: { ...process.env, ...env },
      stderr: "ignore",
    })
  );
  const call = async (name, args = {}) => {
    const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
    let data;
    try {
      data = JSON.parse(r.content?.[0]?.text ?? "");
    } catch {
      data = r.content?.[0]?.text;
    }
    return { isError: !!r.isError, data };
  };
  await call("tds_use_server", { servidor: serverName, ambiente: environment, ...credenciais });
  return { mcp, call };
}

const antes = agentesRodando();
const { mcp, call } = await abrirMcp();
try {
  // --- modo navegador: WebAgent ligado por padrão, a URL já leva a porta do agente
  const nav = await call("tds_debug_start", {
    programa: "u_zTstDbg1",
    modo: "navegador",
    argumentos: ["wa"],
    breakpoints: [{ arquivo: SRC, linha: L_SOMA }],
  });
  check(
    "navegador: WebAgent ligado por padrão e AGENT-PORT na url",
    nav.data?.webAgent?.ativo === true && /AGENT-PORT=\d+/.test(nav.data?.abrirCom?.url ?? ""),
    short({ webAgent: nav.data?.webAgent, url: nav.data?.abrirCom?.url })
  );
  check(
    "navegador: abrirCom traz o initScript da porta e o proximoPasso abre em duas chamadas",
    /desktopagentport/.test(nav.data?.abrirCom?.initScript ?? "") &&
      /navigate_page/.test(nav.data?.proximoPasso ?? "") &&
      nav.data?.webAgent?.conectado === undefined,
    short({ initScript: nav.data?.abrirCom?.initScript, proximoPasso: nav.data?.proximoPasso, webAgent: nav.data?.webAgent })
  );
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-e2e-wa-"));
  const pagina = await HeadlessWebapp.open(resolveChromiumPath(), nav.data.abrirCom.url, base);
  try {
    const parou = await call("tds_debug_wait", { timeoutSeg: 90 });
    const rt = await call("tds_debug_evaluate", { expressao: "GetRemoteType()" });
    check(
      "navegador com WebAgent: para no breakpoint com GetRemoteType() = 1",
      parou.data?.estado === "parado" && rt.data?.resultado === "N 1",
      short({ estado: parou.data?.estado, remoteType: rt.data?.resultado })
    );
  } finally {
    await call("tds_debug_stop");
    await pagina.close();
    fs.rmSync(base, { recursive: true, force: true });
  }

  // Funções que vão à estação (ExecInClient, GetTempPath(.T.)) só chegam ao agente se o
  // AppServer o registrou na abertura da conexão: a porta precisa estar no localStorage.
  const L_TMP = fs.readFileSync(SRC, "latin1").split(/\r?\n/).findIndex((l) => l.includes("Return cTmp")) + 1;
  const est = await call("tds_debug_start", {
    programa: "u_zTstDbgW",
    modo: "navegador",
    breakpoints: [{ arquivo: SRC, linha: L_TMP }],
  });
  const base2 = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-e2e-wa-"));
  const pagina2 = await HeadlessWebapp.open(resolveChromiumPath(), est.data.abrirCom.url, base2);
  try {
    const parou = await call("tds_debug_wait", { timeoutSeg: 90 });
    const cTmp = String(parou.data?.variaveis?.Local?.CTMP ?? "").replace(/^C "|"$/g, "");
    // A pasta do usuário nesta máquina (o TEMP pode vir no nome curto, GUILHE~1); sem o agente
    // registrado, o webapp devolve uma pasta dele no servidor.
    const doUsuario = cTmp.toLowerCase().startsWith(path.dirname(os.homedir()).toLowerCase() + path.sep);
    check(
      "navegador com WebAgent: GetTempPath(.T.) devolve a pasta temporária desta máquina",
      parou.data?.estado === "parado" && doUsuario,
      short({ estado: parou.data?.estado, cTmp, webAgent: parou.data?.webAgent })
    );
  } finally {
    await call("tds_debug_stop");
    await pagina2.close();
    fs.rmSync(base2, { recursive: true, force: true });
  }

  const semAgente = await call("tds_debug_start", { programa: "u_zTstDbg1", modo: "navegador", webAgent: false });
  check(
    "navegador com webAgent: false: url sem AGENT-PORT",
    !/AGENT-PORT/.test(semAgente.data?.abrirCom?.url ?? "x") && !semAgente.data?.webAgent,
    short(semAgente.data?.abrirCom?.url)
  );
  await call("tds_debug_stop");

  // --- headless: desligado por padrão; webAgent: true liga
  const hd = await call("tds_debug_start", {
    programa: "u_zTstDbg1",
    webAgent: true,
    breakpoints: [{ arquivo: SRC, linha: L_SOMA }],
    aguardarSeg: 90,
  });
  const rtHd = await call("tds_debug_evaluate", { expressao: "GetRemoteType()" });
  check(
    "headless com webAgent: true: conecta e GetRemoteType() = 1",
    hd.data?.estado === "parado" && hd.data?.webAgent?.ativo === true && rtHd.data?.resultado === "N 1",
    short({ estado: hd.data?.estado, webAgent: hd.data?.webAgent, remoteType: rtHd.data?.resultado })
  );
  await call("tds_debug_stop");

  const run = await call("tds_run", { programa: "u_zTstDbg1", timeoutSeg: 60 });
  check("tds_run sem webAgent: roda e não liga o agente", run.data?.resultado === "concluido" && !run.data?.webAgent, short(run.data));
} finally {
  await call("tds_debug_stop").catch(() => {});
  await mcp.close();
}

// --- versão recusada pelo webapp: a página recomeça sem agente e o programa roda
const recusado = process.env.TDS_MCP_TEST_WEBAGENT_RECUSADO;
if (recusado) {
  const r = await abrirMcp({ TDS_MCP_WEBAGENT: recusado });
  try {
    const st = await r.call("tds_debug_start", {
      programa: "u_zTstDbg1",
      webAgent: true,
      breakpoints: [{ arquivo: SRC, linha: L_SOMA }],
      aguardarSeg: 90,
    });
    const rt = await r.call("tds_debug_evaluate", { expressao: "GetRemoteType()" });
    check(
      "agente recusado: segue sem WebAgent, para no breakpoint e informa o motivo",
      st.data?.estado === "parado" && st.data?.webAgent?.ativo === false && /recusou/.test(st.data?.webAgent?.motivo ?? "") && rt.data?.resultado !== "N 1",
      short({ estado: st.data?.estado, webAgent: st.data?.webAgent, remoteType: rt.data?.resultado })
    );
  } finally {
    await r.call("tds_debug_stop").catch(() => {});
    await r.mcp.close();
  }
} else {
  console.log("SKIP  agente recusado (defina TDS_MCP_TEST_WEBAGENT_RECUSADO)");
}

// --- máquina sem WebAgent: navegador segue sem ele e diz por quê
const vazio = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-e2e-semwa-"));
const s = await abrirMcp({ LOCALAPPDATA: vazio, TDS_MCP_WEBAGENT: "" });
try {
  const st = await s.call("tds_debug_start", { programa: "u_zTstDbg1", modo: "navegador" });
  check(
    "sem WebAgent na máquina: url sem AGENT-PORT e motivo informado",
    !/AGENT-PORT/.test(st.data?.abrirCom?.url ?? "x") && st.data?.webAgent?.ativo === false && /nenhum TOTVS WebAgent/.test(st.data?.webAgent?.motivo ?? ""),
    short(st.data?.webAgent ?? st.data)
  );
} finally {
  await s.call("tds_debug_stop").catch(() => {});
  await s.mcp.close();
  fs.rmSync(vazio, { recursive: true, force: true });
}

await new Promise((r) => setTimeout(r, 2000));
check("nenhuma instância de WebAgent sobrando", agentesRodando() <= antes, `antes=${antes} depois=${agentesRodando()}`);

console.log(falhas === 0 ? "\nE2E WEBAGENT OK" : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
