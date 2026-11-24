// Iniciador do chrome-devtools: um navegador por sessão, sem deixar perfil para trás nem contar senha errada na
// conta do Windows — precisa do chrome-devtools-mcp global e do navegador, não precisa de AppServer. Abre janelas.
// Uso: node test/e2e-chrome-devtools.mjs [--headless]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveChromiumPath } from "../dist/webapp.js";
import { lerConta, motivoParaPular } from "./conta-windows.mjs";

const iniciador = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "chrome-devtools.js");
const base = path.join(os.tmpdir(), "tds-mcp", "chrome-devtools");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let falhas = 0;
function check(nome, condicao, detalhe = "") {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}
const ps = (c) => execFileSync("powershell.exe", ["-NoProfile", "-Command", c], { encoding: "utf8" }).trim();

// Só os perfis e navegadores deste teste: outra sessão pode estar usando o iniciador.
const perfis = (s) => fs.readdirSync(base).filter((n) => n.startsWith(`perfil-${s.pid}-`));
const navegadores = (s) =>
  ps(
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'perfil-${s.pid}-' -and $_.CommandLine -match 'user-data-dir' -and ` +
      "$_.CommandLine -notmatch '--type=' -and $_.Name -match 'chrome|msedge' } | ForEach-Object { $_.ProcessId }"
  )
    .split(/\s+/)
    .filter(Boolean);

const sessoes = [];
async function abrir(nome) {
  const transporte = new StdioClientTransport({
    command: process.execPath,
    args: [iniciador, "--executablePath", resolveChromiumPath(), "--isolated", "--no-usage-statistics", ...process.argv.slice(2)],
    env: { ...getDefaultEnvironment(), APPDATA: process.env.APPDATA },
    stderr: "ignore",
  });
  const mcp = new Client({ name: nome, version: "0.0.1" });
  await mcp.connect(transporte);
  const sessao = { mcp, pid: transporte.pid };
  sessoes.push(sessao);
  return sessao;
}
async function chamar(s, name, args = {}) {
  const r = await s.mcp.callTool({ name, arguments: args });
  return { texto: r.content[0].text, erro: r.isError };
}
const pagina = (s, titulo) => chamar(s, "new_page", { url: `data:text/html,<title>${titulo}</title>` });

// Sem a marcação, cada abertura deste teste contaria uma senha errada.
const motivo = motivoParaPular(5);
if (motivo) {
  console.log(`SKIP  ${motivo}`);
  process.exit(0);
}

try {
  const a = await abrir("A");
  const b = await abrir("B");
  check("as duas sessões abrem página", !(await pagina(a, "sessaoA")).erro && !(await pagina(b, "sessaoB")).erro);
  await sleep(8000);
  check("um navegador e um perfil por sessão", [a, b].every((s) => navegadores(s).length === 1 && perfis(s).length === 1));
  check(
    "uma sessão não vê as páginas da outra",
    !(await chamar(a, "list_pages")).texto.includes("sessaoB") && !(await chamar(b, "list_pages")).texto.includes("sessaoA")
  );

  await b.mcp.close();
  await sleep(6000);
  check("sessão fechada não deixa navegador", navegadores(b).length === 0);
  check("sessão fechada não deixa perfil", perfis(b).length === 0);
  check("a outra sessão continua", (await chamar(a, "list_pages")).texto.includes("sessaoA"));

  for (const p of navegadores(a)) ps(`Stop-Process -Id ${p} -Force`);
  await sleep(2000);
  check("navegador morto à força reabre", !(await pagina(a, "sessaoA2")).erro);
  await sleep(3000);

  ps(`Stop-Process -Id ${a.pid} -Force`);
  await sleep(6000);
  check("sessão morta à força não deixa navegador", navegadores(a).length === 0);
  const sobra = perfis(a);
  const c = await abrir("C");
  check("o próximo início remove o perfil da sessão morta", perfis(a).length === 0, `havia ${sobra.length}`);
  const [perfilC] = perfis(c);
  check("sessão sem página aberta só tem a marcação no perfil", !!perfilC && fs.readdirSync(path.join(base, perfilC)).join() === "Local State");
  await c.mcp.close();
  await sleep(4000);
  check("sessão sem página aberta não deixa perfil", perfis(c).length === 0);
  check("nenhuma senha errada contada", lerConta().erros === 0);
} finally {
  for (const s of sessoes) await s.mcp.close().catch(() => {});
}

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nE2E CHROME-DEVTOOLS OK");
