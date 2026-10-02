// Teste E2E através do servidor MCP real (stdio), usando o cliente do SDK.
// Fluxo: list tools -> use_server -> syntax_check -> compile -> rpo_objects ->
// patch_generate -> patch_validate -> patch_info.
//
// ATENÇÃO: este teste COMPILA no RPO do servidor informado. Use apenas um
// ambiente de desenvolvimento descartável. Depois rode test/cleanup.mjs.
//
// Uso: node test/e2e-mcp.mjs <servidor> [ambiente]
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
  console.error("Informe o servidor: node test/e2e-mcp.mjs <servidor> [ambiente]");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "..", "dist", "index.js");
const testSource = path.join(here, "zTstMcp1.prw");

const transport = new StdioClientTransport({ command: process.execPath, args: [serverJs] });
const mcp = new Client({ name: "e2e-test", version: "0.0.1" });
await mcp.connect(transport);

function text(result) {
  const t = result.content?.[0]?.text ?? "";
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

async function call(name, args = {}) {
  console.log(`\n=== ${name} ${JSON.stringify(args).substring(0, 120)}`);
  const result = await mcp.callTool({ name, arguments: args });
  const parsed = text(result);
  const s = JSON.stringify(parsed, null, 2);
  console.log(s.length > 1500 ? s.substring(0, 1500) + "\n...(cortado)" : s);
  if (result.isError) throw new Error(`Tool ${name} retornou erro`);
  return parsed;
}

const tools = await mcp.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

await call("tds_use_server", { servidor: serverName, ambiente: environment, ...credenciais });
await call("tds_syntax_check", { arquivos: [testSource] });
await call("tds_compile", { arquivos: [testSource], recompile: true });
await call("tds_rpo_objects", { filtro: "ZTSTMCP" });
await call("tds_rpo_functions", { filtro: "ZTSTMCP" });

const gen = await call("tds_patch_generate", {
  fontes: ["ZTSTMCP1.PRW"],
  cliente: "Testes",
  ticket: "mcp-e2e",
  customizacao: "teste_e2e",
  tituloTcloud: "mcp-e2e Teste E2E do tds-mcp",
  descricao: "Teste E2E do tds-mcp: compilacao + geracao de patch",
});

await call("tds_patch_validate", { arquivoPatch: gen.patch });
await call("tds_patch_info", { arquivoPatch: gen.patch });

await mcp.close();
console.log("\nE2E OK");
process.exit(0);
