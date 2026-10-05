// E2E de execução e depuração pelo servidor MCP real. COMPILA test/zTstDbg1.prw
// no RPO e executa as funções dele (inofensivas, não gravam dados). Use só em
// ambiente de desenvolvimento.
// Uso: node test/e2e-debug.mjs <servidor> [ambiente]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HeadlessWebapp, resolveChromiumPath } from "../dist/webapp.js";

const serverName = process.argv[2] ?? process.env.TDS_MCP_TEST_SERVER;
const environment = process.argv[3] ?? process.env.TDS_MCP_TEST_ENV;
// Credenciais opcionais (sem elas vale o token salvo pelo TDS ou o config do tds-mcp)
const credenciais = process.env.TDS_MCP_TEST_USER
  ? { usuario: process.env.TDS_MCP_TEST_USER, senha: process.env.TDS_MCP_TEST_PASSWORD ?? "" }
  : {};
if (!serverName) {
  console.error("Uso: node test/e2e-debug.mjs <servidor> [ambiente]");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "zTstDbg1.prw");
// Linhas do fonte de teste achadas pelo conteúdo: editar o cabeçalho não quebra o E2E.
const FONTE = fs.readFileSync(SRC, "latin1").split(/\r?\n/);
const lineOf = (trecho) => {
  const n = FONTE.findIndex((l) => l.includes(trecho)) + 1;
  if (!n) throw new Error(`zTstDbg1.prw sem a linha "${trecho}"`);
  return n;
};
const L_SOMA = lineOf("nTotal += zTstSoma(nI)");
const L_NEXT = lineOf("Next nI");
const L_NOME = lineOf("cNome := cNome");
const L_PRIV = lineOf("nPriv += 1");
const L_ERRO = lineOf("nVarNaoExisteE2e");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, "..", "dist", "index.js")],
});
const mcp = new Client({ name: "e2e-debug", version: "0.0.1" });
await mcp.connect(transport);

async function call(name, args = {}) {
  const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  let parsed;
  try {
    parsed = JSON.parse(r.content?.[0]?.text ?? "");
  } catch {
    parsed = r.content?.[0]?.text;
  }
  return { isError: !!r.isError, data: parsed };
}

const inicioE2e = Date.now();
let falhas = 0;
function check(nome, condicao, detalhe) {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}
const short = (v) => String(JSON.stringify(v)).slice(0, 300);

try {
  const conn = await call("tds_use_server", { servidor: serverName, ambiente: environment, ...credenciais });
  check("conecta no servidor", conn.data?.conectado === true, `${conn.data?.servidor}/${conn.data?.ambiente}`);

  const comp = await call("tds_compile", { arquivos: [SRC] });
  check("compila o fonte de teste", comp.data?.sucesso === true, short(comp.data?.resultados));

  // --- tds_run
  const ok = await call("tds_run", { programa: "u_zTstDbg1", timeoutSeg: 60 });
  check("tds_run: programa sem erro -> concluido", !ok.isError && ok.data?.resultado === "concluido", short(ok.data));

  const err = await call("tds_run", { programa: "u_zTstDbgE", timeoutSeg: 60 });
  check(
    "tds_run: erro de execução -> resultado erro com fonte/linha e detalhes",
    err.isError && err.data?.resultado === "erro" && /NVARNAOEXISTEE2E/i.test(err.data?.erro ?? "") &&
      new RegExp(`ZTSTDBG1\\.PRW\\(${L_ERRO}\\)`, "i").test(err.data?.erro ?? "") && /STACK U_ZTSTDBGE/i.test(err.data?.detalhes ?? ""),
    short({ erro: err.data?.erro, temDetalhes: !!err.data?.detalhes })
  );

  // --- depuração
  const start = await call("tds_debug_start", {
    programa: "u_zTstDbg1",
    argumentos: ["arg-e2e"],
    breakpoints: [
      { arquivo: SRC, linha: L_SOMA, condicao: "nI == 2" },
      { arquivo: SRC, linha: L_NOME, rastro: ["cArg", "nTotal", "Len(aItens)", "oJson['cliente']"] },
      { arquivo: SRC, linha: L_PRIV, log: "logpoint nPriv={nPriv}" },
      { arquivo: SRC, linha: L_NEXT }, // Next: aceito pelo depurador, mas nunca para
    ],
    aguardarSeg: 60,
  });
  const st = start.data;
  check(
    "debug_start: para no breakpoint condicional (nI == 2)",
    st?.estado === "parado" && st?.local?.linha === L_SOMA && st?.variaveis?.Local?.NI === "N 2",
    short({ estado: st?.estado, local: st?.local, NI: st?.variaveis?.Local?.NI, avisos: st?.avisos })
  );
  check("debug_start: breakpoints verificados", (st?.breakpoints?.["zTstDbg1.prw"] ?? []).every((b) => b.verificado), short(st?.breakpoints));
  check(
    "debug_start: Private e Static aparecem",
    st?.variaveis?.Private?.NPRIV === "N 43" && /valor estatico/.test(st?.variaveis?.Static?.CSTATICO ?? ""),
    short({ Private: st?.variaveis?.Private, Static: st?.variaveis?.Static })
  );
  check("debug_start: argumento chega ao programa", /arg-e2e/.test(st?.variaveis?.Local?.CARG ?? ""), st?.variaveis?.Local?.CARG);
  check(
    "debug_start: avisa breakpoint em linha que não para (Next)",
    (st?.avisos ?? []).some((a) => a.includes(`zTstDbg1.prw:${L_NEXT}`) && /Next/.test(a)),
    short(st?.avisos)
  );
  const again = await call("tds_debug_wait", { timeoutSeg: 5 });
  check("debug_wait parado: devolve a parada atual", again.data?.estado === "parado" && again.data?.local?.linha === L_SOMA, short(again.data?.local));

  const watch = await call("tds_debug_watch", { adicionar: ["nPriv", "oJson['valor']", "Len(aItens)"] });
  check("debug_watch: registra watches", watch.data?.watches?.length === 3, short(watch.data));

  const into = await call("tds_debug_step", { acao: "entrar" });
  check(
    "step entrar: vai para zTstSoma com nValor = 2",
    /ZTSTSOMA/i.test(into.data?.local?.funcao ?? "") && into.data?.variaveis?.Local?.NVALOR === "N 2" && into.data?.pilha?.length === 2,
    short({ local: into.data?.local, vars: into.data?.variaveis?.Local })
  );

  const caller = await call("tds_debug_variables", { frame: 1, escopo: "Local" });
  check("variables frame 1: vê locais do chamador", caller.data?.itens?.NTOTAL === "N 2", short(caller.data));

  const arr = await call("tds_debug_variables", { frame: 1, escopo: "Local", caminho: ["AITENS", "AITENS[3]"] });
  check("variables: expande array aninhado", /tres/.test(JSON.stringify(arr.data?.itens ?? {})), short(arr.data));

  const next = await call("tds_debug_step", { acao: "proxima" });
  check(
    "step proxima: executa a linha e aponta a alteração (NDOBRO NIL -> 4); watch nPriv ainda 43",
    next.data?.watches?.nPriv === "N 43" && (next.data?.alteradas ?? []).some((a) => /NDOBRO: U NIL -> N 4/.test(a)),
    short({ watches: next.data?.watches, alteradas: next.data?.alteradas })
  );

  const out = await call("tds_debug_step", { acao: "sair" });
  check("step sair: volta para U_ZTSTDBG1", /U_ZTSTDBG1/i.test(out.data?.local?.funcao ?? ""), short(out.data?.local));

  const ev = await call("tds_debug_evaluate", { expressao: "nPriv := 1000" });
  check("evaluate: atribuição altera o programa", ev.data?.resultado === "N 1000", short(ev.data));

  const ev2 = await call("tds_debug_evaluate", { expressao: "oJson['cliente']" });
  check("evaluate: JSON", /000001/.test(ev2.data?.resultado ?? ""), short(ev2.data));

  const cont = await call("tds_debug_step", { acao: "continuar" });
  check(
    "continuar: rastro (texto, função, JSON) e logpoint numérico registrados; programa termina",
    cont.data?.estado === "encerrado" &&
      (cont.data?.mensagens ?? []).some(
        (m) => m.nivel === "RASTRO" && /cArg = C "arg-e2e"/.test(m.mensagem) && /nTotal = N 12/.test(m.mensagem) &&
          /Len\(aItens\) = N 3/.test(m.mensagem) && /000001/.test(m.mensagem)
      ) &&
      (cont.data?.mensagens ?? []).some((m) => /logpoint nPriv=1000/.test(m.mensagem)),
    short(cont.data)
  );

  const stop = await call("tds_debug_stop");
  check("debug_stop encerra", stop.data?.encerrada === true, short(stop.data));

  // --- tds_debug_breakpoints: troca os breakpoints com o programa parado
  const bp = await call("tds_debug_start", {
    programa: "u_zTstDbg1",
    breakpoints: [{ arquivo: SRC, linha: L_SOMA }],
    aguardarSeg: 60,
  });
  check("breakpoints: para na primeira volta", bp.data?.estado === "parado" && bp.data?.local?.linha === L_SOMA, short(bp.data?.local));
  const troca = await call("tds_debug_breakpoints", { arquivo: SRC, breakpoints: [{ linha: L_PRIV }, { linha: L_NEXT }] });
  check(
    "tds_debug_breakpoints substitui os do fonte e avisa linha que não para",
    !troca.isError && troca.data?.breakpoints?.length === 2 && (troca.data?.avisos ?? []).some((a) => a.includes(`:${L_NEXT}`)),
    short(troca.data)
  );
  // Com o breakpoint antigo ainda ativo, a segunda parada seria em L_SOMA (a
  // volta seguinte do For passa nela antes de chamar zTstSoma).
  const p1 = await call("tds_debug_step", { acao: "continuar" });
  const v1 = (await call("tds_debug_evaluate", { expressao: "nPriv" })).data?.resultado;
  const p2 = await call("tds_debug_step", { acao: "continuar" });
  const v2 = (await call("tds_debug_evaluate", { expressao: "nPriv" })).data?.resultado;
  check(
    "duas paradas seguidas no breakpoint novo (zTstSoma), nenhuma no antigo",
    [p1, p2].every((p) => p.data?.estado === "parado" && p.data?.local?.linha === L_PRIV && /ZTSTSOMA/i.test(p.data?.local?.funcao ?? "")) &&
      v1 === "N 42" && v2 === "N 43",
    short({ p1: p1.data?.local, p2: p2.data?.local, v1, v2 })
  );
  const limpa = await call("tds_debug_breakpoints", { arquivo: SRC, breakpoints: [] });
  const fim = await call("tds_debug_step", { acao: "continuar" });
  check(
    "lista vazia remove os breakpoints e o programa termina",
    !limpa.isError && (limpa.data?.breakpoints ?? []).length === 0 && fim.data?.estado === "encerrado",
    short({ limpa: limpa.data, fim: fim.data?.estado })
  );
  await call("tds_debug_stop");

  // --- arquivo enviado ao navegador (CpyS2TW): vem em arquivosBaixados, sem sobrescrever
  const pastaDl = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-e2e-dl-"));
  try {
    const dl1 = await call("tds_run", { programa: "u_zTstDbgD", pastaDownloads: pastaDl, timeoutSeg: 90 });
    const dl2 = await call("tds_run", { programa: "u_zTstDbgD", pastaDownloads: pastaDl, timeoutSeg: 90 });
    const a1 = dl1.data?.arquivosBaixados?.[0];
    const a2 = dl2.data?.arquivosBaixados?.[0];
    check(
      "tds_run: arquivo enviado ao navegador vem em arquivosBaixados com o conteúdo",
      dl1.data?.resultado === "concluido" &&
        a1?.estado === "concluido" &&
        /ztstdbgd\.txt$/i.test(a1?.arquivo ?? "") &&
        fs.readFileSync(a1.arquivo, "latin1").includes("conteudo do teste de download"),
      short(dl1.data)
    );
    check(
      "segundo download de mesmo nome não sobrescreve o primeiro",
      /ztstdbgd \(2\)\.txt$/i.test(a2?.arquivo ?? "") && fs.existsSync(a1?.arquivo ?? ""),
      short(a2)
    );
  } finally {
    fs.rmSync(pastaDl, { recursive: true, force: true });
  }
  const padrao = await call("tds_run", { programa: "u_zTstDbg1", timeoutSeg: 60 });
  const raizDl = path.join(os.tmpdir(), "tds-mcp", "downloads");
  const sobras = (fs.existsSync(raizDl) ? fs.readdirSync(raizDl) : []).filter(
    (n) => fs.statSync(path.join(raizDl, n)).mtimeMs > inicioE2e && fs.readdirSync(path.join(raizDl, n)).length === 0
  );
  check("pasta padrão de downloads sem arquivo não fica para trás", padrao.data?.resultado === "concluido" && sobras.length === 0, sobras.join(", "));

  // --- headless com diálogo aberto: o wait devolve a tela e os botões
  await call("tds_debug_start", { programa: "u_zTstDbgT", aguardarSeg: 0 });
  const dlg = await call("tds_debug_wait", { timeoutSeg: 20 });
  check(
    "debug_wait headless com diálogo: executando com tela e botões",
    dlg.data?.estado === "executando" && /Tela de teste do E2E/.test(dlg.data?.tela ?? "") && (dlg.data?.botoes ?? []).length > 0,
    short({ tela: dlg.data?.tela, botoes: dlg.data?.botoes })
  );
  await call("tds_debug_stop");

  // --- modo navegador: URL para o agente abrir e sinal de conexão do webapp
  const nav = await call("tds_debug_start", {
    programa: "u_zTstDbg1",
    modo: "navegador",
    breakpoints: [{ arquivo: SRC, linha: L_SOMA }],
  });
  const abrir = nav.data?.abrirCom ?? {};
  check(
    "debug_start navegador: devolve url com DEBUG e contexto isolado",
    /\?DEBUG=\d+&E=.+&P=u_zTstDbg1/i.test(abrir.url ?? "") && /^tds-\d+$/.test(abrir.isolatedContext ?? "") && nav.data?.estado === "executando",
    short(abrir)
  );
  const wait = await call("tds_debug_wait", { timeoutSeg: 5 });
  check(
    "debug_wait sem webapp aberto: executando com conectado=false",
    wait.data?.estado === "executando" && wait.data?.conectado === false,
    short(wait.data)
  );
  // Abre a URL como o agente faria no chrome-devtools: navegador com perfil limpo.
  const baseNav = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-e2e-nav-"));
  const pagina = await HeadlessWebapp.open(resolveChromiumPath(), abrir.url, baseNav);
  try {
    const parou = await call("tds_debug_wait", { timeoutSeg: 60 });
    check(
      "webapp aberto pela url: para no breakpoint",
      parou.data?.estado === "parado" && parou.data?.local?.linha === L_SOMA,
      short(parou.data?.local ?? parou.data)
    );
  } finally {
    const fim = await call("tds_debug_stop");
    check(
      "debug_stop navegador: devolve fecharAba com o contexto isolado",
      fim.data?.encerrada === true && (fim.data?.fecharAba ?? "").includes(abrir.isolatedContext),
      short(fim.data)
    );
    await pagina.close();
    fs.rmSync(baseNav, { recursive: true, force: true });
  }

  // --- modulo: abre pelo SIGABPM; combinações erradas são recusadas antes de iniciar
  const mod = await call("tds_debug_start", { programa: "u_zTstDbg1", modulo: "SIGAEST", modo: "navegador" });
  check(
    "modulo: url pelo SIGABPM com código do módulo e a rotina",
    /&P=SIGABPM&M=1&A=04&A=u_zTstDbg1$/i.test(mod.data?.abrirCom?.url ?? "") && /módulo 04/.test(mod.data?.sessao?.programa ?? ""),
    short(mod.data?.abrirCom?.url ?? mod.data)
  );
  await call("tds_debug_stop");
  const recusas = await Promise.all([
    call("tds_debug_start", { programa: "u_zTstDbg1", modulo: "04" }),
    call("tds_debug_start", { programa: "u_zTstDbg1", modulo: "04", modo: "navegador", argumentos: ["x"] }),
    call("tds_debug_start", { programa: "SIGAMDI", modo: "navegador" }),
    call("tds_run", { programa: "SIGABPM", argumentos: ["04", "u_zTstDbg1"] }),
  ]);
  check(
    "modulo: headless, argumentos e programa SIGAxxx são recusados",
    recusas.every((r) => r.isError) &&
      /modo 'navegador'/.test(recusas[0].data?.erro ?? "") &&
      /sem argumentos/.test(recusas[1].data?.erro ?? "") &&
      /use|modulo/.test(recusas[2].data?.erro ?? "") &&
      /modulo/.test(recusas[3].data?.erro ?? ""),
    short(recusas.map((r) => r.data?.erro))
  );

  // --- concorrência: duas execuções ao mesmo tempo -> uma roda, a outra recebe "ocupado"
  const [r1, r2] = await Promise.all([
    call("tds_run", { programa: "u_zTstDbg1", timeoutSeg: 60 }),
    call("tds_run", { programa: "u_zTstDbg1", timeoutSeg: 60 }),
  ]);
  const resultados = [r1, r2];
  check(
    "concorrência: uma execução conclui e a outra recebe erro de ocupado",
    resultados.filter((r) => r.data?.resultado === "concluido").length === 1 &&
      resultados.filter((r) => r.isError && /Depurador ocupado/.test(r.data?.erro ?? "")).length === 1,
    short(resultados.map((r) => r.data?.resultado ?? r.data?.erro))
  );
  const r3 = await call("tds_run", { programa: "u_zTstDbg1", timeoutSeg: 60 });
  check("concorrência: depois disso a vaga fica livre", r3.data?.resultado === "concluido", short(r3.data));

  // --- dois processos do tds-mcp (duas sessões do Claude) executando ao mesmo tempo
  const outro = new Client({ name: "e2e-debug-2", version: "0.0.1" });
  await outro.connect(
    new StdioClientTransport({ command: process.execPath, args: [path.join(here, "..", "dist", "index.js")] })
  );
  try {
    const callOutro = async (name, args = {}) => {
      const r = await outro.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
      let parsed;
      try {
        parsed = JSON.parse(r.content?.[0]?.text ?? "");
      } catch {
        parsed = r.content?.[0]?.text;
      }
      return { isError: !!r.isError, data: parsed };
    };
    await callOutro("tds_use_server", { servidor: serverName, ambiente: environment, ...credenciais });
    const [p1, p2] = await Promise.all([
      call("tds_run", { programa: "u_zTstDbg1", timeoutSeg: 60 }),
      callOutro("tds_run", { programa: "u_zTstDbg1", timeoutSeg: 60 }),
    ]);
    check(
      "dois processos do tds-mcp: as duas execuções simultâneas concluem",
      p1.data?.resultado === "concluido" && p2.data?.resultado === "concluido",
      short([p1.data?.resultado ?? p1.data?.erro, p2.data?.resultado ?? p2.data?.erro])
    );
  } finally {
    await outro.close().catch(() => {});
  }

  // --- sem threads presas no servidor
  const users = await call("tds_monitor_users", { programa: "ZTSTDBG" });
  check("nenhuma thread de teste presa no servidor", (users.data?.totalFiltrado ?? 1) === 0, short(users.data?.sessoes));

  // --- sem sobras locais: logs do debugAdapter (têm o token) e perfis do Chromium
  await new Promise((r) => setTimeout(r, 2000));
  const tmp = path.join(os.tmpdir(), "tds-mcp");
  const recentes = (fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).filter(
    (n) => /^(debugAdapter-|chromium-profile-)/.test(n) && fs.statSync(path.join(tmp, n)).mtimeMs > inicioE2e
  );
  check("nenhum log de debugAdapter nem perfil de Chromium sobrando", recentes.length === 0, recentes.join(", "));
} finally {
  await call("tds_debug_stop").catch(() => {});
  await mcp.close();
}

console.log(falhas === 0 ? "\nE2E DEBUG OK" : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
