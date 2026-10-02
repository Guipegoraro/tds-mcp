// Teste da leitura do config.json do tds-mcp — usa arquivos temporários, não o config real.
// Uso: node test/config.test.mjs
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, configWarnings } from "../dist/config.js";

let falhas = 0;
function check(nome, condicao, detalhe = "") {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-config-"));
const file = path.join(dir, "config.json");
// O loader avisa no stderr; aqui o aviso é conferido em configWarnings.
const stderrWrite = console.error;
console.error = () => {};
try {
  let c = loadConfig(path.join(dir, "nao-existe.json"));
  check("sem arquivo: padrões e sem aviso", c.patchesRoot === "C:\\TOTVS\\patches" && configWarnings.length === 0);

  fs.writeFileSync(file, '{ "patchesRoot": "D:\\\\patches", ');
  c = loadConfig(file);
  check("JSON inválido: padrões e aviso", c.patchesRoot === "C:\\TOTVS\\patches" && configWarnings.length === 1, configWarnings[0]);

  fs.writeFileSync(
    file,
    "\uFEFF" +
      JSON.stringify({
        patchesRoot: null,
        credentials: { Srv: { user: "u", password: "p" } },
        debugIdleMinutes: "dez",
        chromiumPath: "C:\\chrome.exe",
        advplsPath: "",
        desconhecido: 1,
      })
  );
  c = loadConfig(file);
  check("campo nulo mantém o padrão", c.patchesRoot === "C:\\TOTVS\\patches");
  check("credenciais válidas são mantidas", c.credentials.Srv?.user === "u");
  check("campo de tipo errado é descartado com aviso", c.debugIdleMinutes === undefined && configWarnings.some((w) => /debugIdleMinutes/.test(w)), configWarnings.join(" | "));
  check("demais campos válidos são mantidos", c.chromiumPath === "C:\\chrome.exe");
  check("caminho vazio conta como não informado, sem aviso", c.advplsPath === undefined && configWarnings.every((w) => !/advplsPath/.test(w)));
  check("BOM no início é aceito", configWarnings.every((w) => !/JSON válido/.test(w)));

  fs.writeFileSync(file, JSON.stringify({ credentials: { Ruim: { user: "u" }, Boa: { user: "b", password: "s" } } }));
  c = loadConfig(file);
  check(
    "credencial sem senha é descartada com aviso, sem perder as demais",
    !c.credentials.Ruim && c.credentials.Boa?.password === "s" && configWarnings.length === 1 && /Ruim/.test(configWarnings[0]),
    configWarnings[0]
  );
} finally {
  console.error = stderrWrite;
  fs.rmSync(dir, { recursive: true, force: true });
}

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DE CONFIG PASSARAM");
