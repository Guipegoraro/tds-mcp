// E2E de propriedades de objeto no depurador: dentro de método, ::prop, self:prop,
// chamada de método e atribuição pelo tds_debug_evaluate. COMPILA test/zTstCls1.prw
// e test/zTstCls2.tlpp como temporários e os remove do RPO no fim. Inofensivos, não
// gravam dados. Use só em ambiente de desenvolvimento.
// Uso: node test/e2e-debug-classe.mjs <servidor> [ambiente]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const serverName = process.argv[2] ?? process.env.TDS_MCP_TEST_SERVER;
const environment = process.argv[3] ?? process.env.TDS_MCP_TEST_ENV;
const credenciais = process.env.TDS_MCP_TEST_USER
  ? { usuario: process.env.TDS_MCP_TEST_USER, senha: process.env.TDS_MCP_TEST_PASSWORD ?? "" }
  : {};
if (!serverName) {
  console.error("Uso: node test/e2e-debug-classe.mjs <servidor> [ambiente]");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
// [programa, fonte, nome no RPO, nValor no ponto de parada]
const CASOS = [
  ["u_zTstCls1", path.join(here, "zTstCls1.prw"), "ZTSTCLS1.PRW", 10],
  ["u_zTstCls2", path.join(here, "zTstCls2.tlpp"), "ZTSTCLS2.TLPP", 20],
];
const linhaDe = (arq, trecho) => {
  const n = fs.readFileSync(arq, "latin1").split(/\r?\n/).findIndex((l) => l.includes(trecho)) + 1;
  if (!n) throw new Error(`${path.basename(arq)} sem a linha "${trecho}"`);
  return n;
};

const mcp = new Client({ name: "e2e-debug-classe", version: "0.0.1" });
await mcp.connect(
  new StdioClientTransport({ command: process.execPath, args: [path.join(here, "..", "dist", "index.js")] })
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
const avaliar = async (expressao) => (await call("tds_debug_evaluate", { expressao })).data?.resultado;

try {
  const conn = await call("tds_use_server", { servidor: serverName, ambiente: environment, ...credenciais });
  check("conecta no servidor", conn.data?.conectado === true, short(conn.data));
  const comp = await call("tds_compile", { arquivos: CASOS.map((c) => c[1]), temporario: true });
  check("compila os fontes com classe", comp.data?.sucesso === true, short(comp.data?.resultados ?? comp.data));

  for (const [programa, fonte, , nValor] of CASOS) {
    const ext = path.extname(fonte);
    const linha = linhaDe(fonte, "::nValor := nAntes + nQtd");
    const st = await call("tds_debug_start", { programa, breakpoints: [{ arquivo: fonte, linha }], aguardarSeg: 90 });
    try {
      check(`${ext}: para dentro do método`, st.data?.estado === "parado", short(st.data));
      if (st.data?.estado !== "parado") continue;
      const lidos = {
        dois: await avaliar("::nValor"),
        self: await avaliar("self:nValor"),
        metodo: await avaliar("::Dobro()"),
      };
      check(
        `${ext}: ::prop, self:prop e ::Metodo() devolvem o valor`,
        lidos.dois === `N ${nValor}` && lidos.self === `N ${nValor}` && lidos.metodo === `N ${nValor * 2}`,
        short(lidos)
      );
      const locais = (await call("tds_debug_variables", { escopo: "Local" })).data?.itens ?? {};
      check(`${ext}: o objeto aparece no escopo Local como SELF`, /^O /.test(locais.SELF ?? ""), short(locais));
      await avaliar("::nValor := 88");
      check(`${ext}: atribuição com :: altera a propriedade`, (await avaliar("self:nValor")) === "N 88");
    } finally {
      await call("tds_debug_stop");
    }
  }
} finally {
  await call("tds_debug_stop").catch(() => {});
  // Só os que estão no RPO: um nome ausente faria o tds_rpo_delete recusar a lista inteira.
  const temp = await call("tds_rpo_temporarios").catch(() => ({ data: {} }));
  const noRpo = new Set((temp.data?.temporarios ?? []).filter((t) => t.noRpo).map((t) => t.fonte));
  const fontes = CASOS.map((c) => c[2]).filter((f) => noRpo.has(f));
  const rm = fontes.length
    ? await call("tds_rpo_delete", { fontes }).catch((e) => ({ isError: true, data: String(e) }))
    : { isError: false, data: "nada no RPO" };
  check("remove os temporários do RPO", !rm.isError, short(rm.data));
  await mcp.close();
}

console.log(falhas === 0 ? "\nE2E CLASSE OK" : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
