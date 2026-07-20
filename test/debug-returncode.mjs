// Levanta o returnCode CRU do $totvsserver/compilation em cenários distintos.
// Usa syntaxOnly (não grava no RPO). Uso: node test/debug-returncode.mjs <servidor> [ambiente]
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "vscode-uri";
import { AdvplsClient, resolveAdvplsPath } from "../dist/advpls.js";
import {
  SessionManager,
  readServersJson,
  effectiveIncludes,
  authorizationToken,
} from "../dist/session.js";
import { loadConfig } from "../dist/config.js";

const serverName = process.argv[2] ?? process.env.TDS_MCP_TEST_SERVER;
const environment = process.argv[3] ?? process.env.TDS_MCP_TEST_ENV;
if (!serverName) {
  console.error("Uso: node test/debug-returncode.mjs <servidor> [ambiente]");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const okFile = path.join(here, "zTstMcp1.prw");
const badFile = path.join(here, "zTstRetCode.prw");
const missingFile = path.join(here, "zNaoExiste.prw");

// fonte com erro de sintaxe (CP1252 puro ASCII)
fs.writeFileSync(
  badFile,
  '#include "protheus.ch"\n\nUser Function zTstRetCode()\n    Local cX := "aberta\n    nY := Soma(1,\nReturn cX\n',
  "latin1"
);

const config = loadConfig();
const client = await AdvplsClient.start(resolveAdvplsPath(config.advplsPath));
const session = new SessionManager(client, config);

function opts(extra = {}) {
  return {
    recompile: false,
    debugAphInfo: true,
    gradualSending: true,
    generatePpoFile: false,
    showPreCompiler: false,
    priorVelocity: true,
    returnPpo: false,
    commitWithErrorOrWarning: false,
    syntaxOnly: true,
    ...extra,
  };
}

try {
  const active = await session.useServer(serverName, environment);
  const cfg = readServersJson();
  const includes = effectiveIncludes(cfg, active.def).map((i) => URI.file(i).toString());
  console.log(`conectado: ${active.def.name}/${active.environment}\n`);

  async function probe(label, files) {
    try {
      const r = await client.compile({
        connectionToken: active.connectionToken,
        authorizationToken: authorizationToken(cfg),
        environment: active.environment,
        includeUris: includes,
        fileUris: files.map((f) => URI.file(f).toString()),
        options: opts(),
        includeUrisRequired: true,
      });
      const infos = r.compileInfos ?? [];
      const errs = infos.filter((i) => i.status === "ERROR" || i.status === "FATAL");
      console.log(`[${label}]`);
      console.log(`  returnCode      : ${r.returnCode}`);
      console.log(`  compileInfos    : ${infos.length} -> ${infos.map((i) => i.status).join(",") || "(vazio)"}`);
      console.log(`  erros ERROR/FATAL: ${errs.length}`);
      console.log(`  >> logica ATUAL diria sucesso = ${errs.length === 0}`);
      console.log(`  >> returnCode !== 0 diria falha = ${r.returnCode !== 0}\n`);
    } catch (e) {
      console.log(`[${label}] EXCECAO: ${e.message}\n`);
    }
  }

  await probe("fonte OK", [okFile]);
  await probe("fonte com erro de sintaxe", [badFile]);
  await probe("arquivo inexistente", [missingFile]);

  await client.disconnect(active.def.name, active.connectionToken).catch(() => {});
} catch (e) {
  console.error("ERRO:", e.message);
  for (const l of client.serverLog.slice(-15)) console.error("  ", l);
  process.exitCode = 1;
} finally {
  client.dispose();
  fs.rmSync(badFile, { force: true });
}
process.exit(process.exitCode ?? 0);
