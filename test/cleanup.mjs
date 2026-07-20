// Remove o fonte de teste ZTSTMCP1.PRW do RPO (request cru deletePrograms).
// Uso: node test/cleanup.mjs <servidor> [ambiente]
import { AdvplsClient, resolveAdvplsPath } from "../dist/advpls.js";
import { SessionManager, readServersJson, authorizationToken } from "../dist/session.js";
import { loadConfig } from "../dist/config.js";

const serverName = process.argv[2] ?? process.env.TDS_MCP_TEST_SERVER;
const environment = process.argv[3] ?? process.env.TDS_MCP_TEST_ENV;

if (!serverName) {
  console.error("Informe o servidor: node test/cleanup.mjs <servidor> [ambiente]");
  process.exit(1);
}

const config = loadConfig();
const client = await AdvplsClient.start(resolveAdvplsPath(config.advplsPath));
const session = new SessionManager(client, config);

try {
  const active = await session.useServer(serverName, environment);
  const cfg = readServersJson();
  const result = await client.request("$totvsserver/deletePrograms", {
    deleteProgramsInfo: {
      connectionToken: active.connectionToken,
      authorizationToken: authorizationToken(cfg),
      environment: active.environment,
      programs: ["ZTSTMCP1.PRW"],
    },
  });
  console.log("deletePrograms:", JSON.stringify(result));

  const objs = await client.inspectorObjects(active.connectionToken, active.environment, false);
  const still = objs.filter((o) => o.source.toUpperCase().includes("ZTSTMCP"));
  console.log(still.length === 0 ? "ZTSTMCP1.PRW removido do RPO" : "AINDA NO RPO: " + JSON.stringify(still));
} finally {
  client.dispose();
}
process.exit(0);
