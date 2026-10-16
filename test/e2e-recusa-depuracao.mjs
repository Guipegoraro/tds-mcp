// E2E da recusa de compilação, patch e remoção do RPO enquanto um programa roda sob o
// depurador; o PPO (appre local, sem RPO) continua livre. Exige test/zTstDbg1.prw compilado (rode antes o e2e-debug). Compila o
// zTstDbg1 de novo (fora da depuração), o que derruba sessões de usuário no servidor
// com BUILDKILLUSERS=1.
// Uso: node test/e2e-recusa-depuracao.mjs <servidor> [ambiente]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const serverName = process.argv[2] ?? process.env.TDS_MCP_TEST_SERVER;
const environment = process.argv[3] ?? process.env.TDS_MCP_TEST_ENV;
const credenciais = process.env.TDS_MCP_TEST_USER
  ? { usuario: process.env.TDS_MCP_TEST_USER, senha: process.env.TDS_MCP_TEST_PASSWORD ?? "" }
  : {};
if (!serverName) {
  console.error("Uso: node test/e2e-recusa-depuracao.mjs <servidor> [ambiente]");
  process.exit(1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "zTstDbg1.prw");
const L_SOMA = fs.readFileSync(SRC, "latin1").split(/\r?\n/).findIndex((l) => l.includes("nTotal += zTstSoma(nI)")) + 1;
// Patch inexistente: a recusa vem antes da conferência do arquivo, e sem depuração o erro é outro.
const PATCH = path.join(os.tmpdir(), `tdsmcp-recusa-inexistente-${process.pid}.ptm`);
fs.rmSync(PATCH, { force: true });

const mcp = new Client({ name: "e2e-recusa-depuracao", version: "0.0.1" });
await mcp.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "..", "dist", "index.js")],
    stderr: "ignore",
  })
);
async function call(name, args = {}) {
  const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  let data;
  try {
    data = JSON.parse(r.content?.[0]?.text ?? "");
  } catch {
    data = r.content?.[0]?.text;
  }
  return { isError: !!r.isError, data };
}
let falhas = 0;
function check(nome, condicao, detalhe) {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}
const short = (v) => String(JSON.stringify(v)).slice(0, 300);
const erro = (r) => String(r.data?.erro ?? "");
const recusada = (r) => r.isError && /Recusado durante a depuração/.test(erro(r));

// Cada operação com o resultado esperado fora da depuração: segue até o erro (ou o sucesso) dela.
const operacoes = [
  ["tds_compile", { arquivos: [SRC] }, (r) => !r.isError || /COMPILEERROR-300/.test(erro(r))],
  [
    "tds_patch_generate",
    // Fonte ausente do RPO: a geração para antes de gravar o patch.
    { fontes: ["ZTSTNAOEXISTE.PRW"], cliente: "e2e", ticket: "0", customizacao: "recusa", tituloTcloud: "e2e recusa" },
    (r) => /não encontrados no RPO/.test(erro(r)),
  ],
  ["tds_patch_validate", { arquivoPatch: PATCH }, (r) => /Patch não encontrado/.test(erro(r))],
  ["tds_patch_apply", { arquivoPatch: PATCH }, (r) => /Patch não encontrado/.test(erro(r))],
  ["tds_rpo_delete", { fontes: ["ZTSTNAOEXISTE.PRW"] }, (r) => /Não são temporários registrados/.test(erro(r))],
];

async function nenhumaRecusa(quando) {
  for (const [tool, args, esperado] of operacoes) {
    const r = await call(tool, args);
    check(`${quando}: ${tool} segue até o resultado dela`, !recusada(r) && esperado(r), short(r.data));
  }
}

try {
  await call("tds_use_server", { servidor: serverName, ambiente: environment, ...credenciais });

  // --- programa parado num breakpoint
  const st = await call("tds_debug_start", {
    programa: "u_zTstDbg1",
    breakpoints: [{ arquivo: SRC, linha: L_SOMA }],
    aguardarSeg: 90,
  });
  check("depuração parada no breakpoint", st.data?.estado === "parado", short(st.data?.estado ?? st.data));
  for (const [tool, args] of operacoes) {
    const r = await call(tool, args);
    check(
      `${tool} recusada com a sessão aberta, citando o programa e o tds_debug_stop`,
      recusada(r) && /u_zTstDbg1/i.test(erro(r)) && /tds_debug_stop/.test(erro(r)),
      short(r.data)
    );
  }
  const ppo = await call("tds_generate_ppo", { arquivo: SRC });
  check("tds_generate_ppo livre com a sessão aberta (appre local, não toca o RPO)", !ppo.isError, short(ppo.data));
  const ainda = await call("tds_debug_evaluate", { expressao: "nTotal" });
  check("a sessão segue de pé depois das recusas", !ainda.isError, short(ainda.data));
  await call("tds_debug_stop");
  await nenhumaRecusa("depois do stop");

  // --- tds_run em andamento também conta: o diálogo segura a execução até o prazo
  const run = call("tds_run", { programa: "u_zTstDbgT", timeoutSeg: 25 });
  await new Promise((r) => setTimeout(r, 12000));
  const comp = await call("tds_compile", { arquivos: [SRC] });
  check(
    "tds_compile recusado com tds_run em andamento, mandando esperar (sem tds_debug_stop)",
    recusada(comp) && /tds_run de u_zTstDbgT/i.test(erro(comp)) && !/tds_debug_stop/.test(erro(comp)),
    short(comp.data)
  );
  const fim = await run;
  check("o tds_run termina no prazo", fim.data?.resultado === "tempoEsgotado", short(fim.data));
  await nenhumaRecusa("terminado o tds_run");
} finally {
  await call("tds_debug_stop").catch(() => {});
  await mcp.close();
}

console.log(falhas === 0 ? "\nE2E RECUSA NA DEPURACAO OK" : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
