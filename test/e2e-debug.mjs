// E2E de execução e depuração pelo servidor MCP real. COMPILA test/zTstDbg1.prw
// no RPO e executa as funções dele (inofensivas, não gravam dados). Use só em
// ambiente de desenvolvimento.
// Uso: node test/e2e-debug.mjs <servidor> [ambiente]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
      /ZTSTDBG1\.PRW\(39\)/i.test(err.data?.erro ?? "") && /STACK U_ZTSTDBGE/i.test(err.data?.detalhes ?? ""),
    short({ erro: err.data?.erro, temDetalhes: !!err.data?.detalhes })
  );

  // --- depuração
  const start = await call("tds_debug_start", {
    programa: "u_zTstDbg1",
    argumentos: ["arg-e2e"],
    breakpoints: [
      { arquivo: SRC, linha: 23, condicao: "nI == 2" },
      { arquivo: SRC, linha: 26, rastro: ["cArg", "nTotal", "Len(aItens)", "oJson['cliente']"] },
      { arquivo: SRC, linha: 31, log: "logpoint nPriv={nPriv}" },
      { arquivo: SRC, linha: 24 }, // Next: aceito pelo depurador, mas nunca para
    ],
    aguardarSeg: 60,
  });
  const st = start.data;
  check(
    "debug_start: para no breakpoint condicional (nI == 2)",
    st?.estado === "parado" && st?.local?.linha === 23 && st?.variaveis?.Local?.NI === "N 2",
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
    (st?.avisos ?? []).some((a) => /zTstDbg1.prw:24/.test(a) && /Next/.test(a)),
    short(st?.avisos)
  );
  const again = await call("tds_debug_wait", { timeoutSeg: 5 });
  check("debug_wait parado: devolve a parada atual", again.data?.estado === "parado" && again.data?.local?.linha === 23, short(again.data?.local));

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

  // --- pausa por breakpoint incluído com o programa rodando (modo navegador = sem navegador próprio)
  const nav = await call("tds_debug_start", { programa: "u_zTstDbg1", modo: "navegador" });
  check(
    "debug_start navegador: devolve a URL do webapp com DEBUG",
    /\?DEBUG=\d+&E=.+&P=u_zTstDbg1/i.test(nav.data?.url ?? "") && nav.data?.estado === "executando",
    nav.data?.url
  );
  const wait = await call("tds_debug_wait", { timeoutSeg: 5 });
  check("debug_wait sem navegador aberto: continua executando", wait.data?.estado === "executando", short(wait.data));
  await call("tds_debug_stop");

  // --- sem threads presas no servidor
  const users = await call("tds_monitor_users", { programa: "ZTSTDBG" });
  check("nenhuma thread de teste presa no servidor", (users.data?.totalFiltrado ?? 1) === 0, short(users.data?.sessoes));
} finally {
  await call("tds_debug_stop").catch(() => {});
  await mcp.close();
}

console.log(falhas === 0 ? "\nE2E DEBUG OK" : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
