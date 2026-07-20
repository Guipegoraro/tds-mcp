// Teste de fumaça read-only usando o SessionManager real:
// useServer (connect + auth) -> inspectorObjects -> inspectorFunctions -> rpoInfo.
// Não compila nem altera nada.
import { AdvplsClient, resolveAdvplsPath } from "../dist/advpls.js";
import { SessionManager } from "../dist/session.js";
import { loadConfig } from "../dist/config.js";

// Uso: node test/smoke.mjs <servidor> [ambiente]
//      (ou defina TDS_MCP_TEST_SERVER / TDS_MCP_TEST_ENV)
const serverName = process.argv[2] ?? process.env.TDS_MCP_TEST_SERVER;
const environment = process.argv[3] ?? process.env.TDS_MCP_TEST_ENV; // opcional

if (!serverName) {
  console.error(
    "Informe o servidor: node test/smoke.mjs <servidor> [ambiente]\n" +
      "O nome deve existir no servers.json do TDS (~/.totvsls/servers.json)."
  );
  process.exit(1);
}

const config = loadConfig();
const advplsPath = resolveAdvplsPath(config.advplsPath);
console.log("[1] advpls:", advplsPath);

const client = await AdvplsClient.start(advplsPath);
console.log("[2] advpls iniciado (handshake LSP ok)");

const session = new SessionManager(client, config);

try {
  const active = await session.useServer(serverName, environment);
  console.log(
    "[3] conectado: servidor=%s ambiente=%s usuario=%s via=%s",
    active.def.name,
    active.environment,
    active.user,
    active.authMethod
  );

  const objects = await client.inspectorObjects(active.connectionToken, active.environment, false);
  console.log("[4] inspectorObjects: %d objetos no RPO", objects.length);
  console.log(
    "    exemplos:",
    objects.slice(0, 5).map((o) => `${o.source} (${o.date})`).join("; ")
  );

  const funcs = await client.inspectorFunctions(active.connectionToken, active.environment, true);
  console.log("[5] inspectorFunctions: %d funcoes publicas", funcs.length);
  const userFuncs = funcs.filter((f) => f.function.toUpperCase().startsWith("U_"));
  console.log(
    "    U_*: %d | exemplos: %s",
    userFuncs.length,
    userFuncs.slice(0, 5).map((f) => `${f.function} (${f.source}:${f.line})`).join("; ")
  );

  try {
    const info = await client.rpoInfo(active.connectionToken, active.environment);
    console.log(
      "[6] rpoInfo: versao=%s geracao=%s patchesAplicados=%d",
      info.rpoVersion,
      info.dateGeneration,
      (info.rpoPatchs ?? []).length
    );
  } catch (e) {
    console.log("[6] rpoInfo FALHOU:", e.message);
  }

  await client.disconnect(active.def.name, active.connectionToken).catch(() => {});
  console.log("[7] desconectado");
} catch (e) {
  console.error("ERRO:", e.message);
  console.error("--- log do advpls ---");
  for (const line of client.serverLog.slice(-20)) console.error(" ", line);
  process.exitCode = 1;
} finally {
  client.dispose();
}
console.log("FIM");
process.exit(process.exitCode ?? 0);
