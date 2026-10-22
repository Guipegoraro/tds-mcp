// As tools tds_monitor_* só aparecem com TDS_MCP_MONITOR=1 (ou enableMonitor no config); sem elas, nenhuma
// descrição cita tds_monitor_users — não precisa de AppServer.
// Uso: node test/monitor-opcional.test.mjs
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let falhas = 0;
function check(nome, condicao, detalhe = "") {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}

/** Lista as tools de um tds-mcp com o ambiente e o HOME informados. */
async function tools(env) {
  const mcp = new Client({ name: "monitor-opcional", version: "0.0.1" });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, "..", "dist", "index.js")], env }));
  const { tools } = await mcp.listTools();
  await mcp.close();
  return tools;
}

// HOME temporário: o config.json da máquina (que pode ter enableMonitor) não entra no teste.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-mon-"));
const base = { ...process.env, USERPROFILE: home, HOME: home };
delete base.TDS_MCP_MONITOR;
try {
  const sem = await tools(base);
  const nomesSem = sem.map((t) => t.name);
  check("padrão: nenhuma tool tds_monitor_*", !nomesSem.some((n) => n.startsWith("tds_monitor_")), nomesSem.filter((n) => n.startsWith("tds_monitor_")).join(", "));
  const citam = sem.filter((t) => /tds_monitor_/.test(JSON.stringify(t)));
  check("padrão: nenhuma descrição cita tds_monitor_*", citam.length === 0, citam.map((t) => t.name).join(", "));

  const com = await tools({ ...base, TDS_MCP_MONITOR: "1" });
  const nomesCom = com.map((t) => t.name);
  check(
    "TDS_MCP_MONITOR=1: as quatro tools de monitor",
    ["tds_monitor_users", "tds_monitor_send_message", "tds_monitor_kill_user", "tds_monitor_app_kill_user"].every((n) => nomesCom.includes(n))
  );

  fs.mkdirSync(path.join(home, ".tds-mcp"), { recursive: true });
  fs.writeFileSync(path.join(home, ".tds-mcp", "config.json"), JSON.stringify({ enableMonitor: true }));
  const peloConfig = (await tools(base)).map((t) => t.name);
  check("enableMonitor: true no config também liga", peloConfig.includes("tds_monitor_users"));
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DO MONITOR OPCIONAL PASSARAM");
