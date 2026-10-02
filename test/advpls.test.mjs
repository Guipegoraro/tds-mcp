// Teste da escolha do binario advpls — nao precisa de AppServer.
// Uso: node test/advpls.test.mjs
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compareVersions, advplsBinaryInfo } from "../dist/advpls.js";

let falhas = 0;
function caso(nome, ok) {
  if (!ok) falhas++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${nome}`);
}

caso("2.1.10 e mais nova que 2.1.9", compareVersions("2.1.10", "2.1.9") > 0);
caso("2.0.16 e mais antiga que 2.1.4", compareVersions("2.0.16", "2.1.4") < 0);
caso("versoes iguais empatam", compareVersions("2.1.4", "2.1.4") === 0);
caso("parte ausente vale zero", compareVersions("2.1", "2.1.0") === 0);

const pastas = ["totvs.tds-vscode-2.1.9", "totvs.tds-vscode-2.1.10", "totvs.tds-vscode-2.0.16"];
const prefixo = "totvs.tds-vscode-";
const ordenadas = [...pastas].sort((a, b) =>
  compareVersions(b.slice(prefixo.length), a.slice(prefixo.length))
);
caso("pasta da extensao mais nova vem primeiro", ordenadas[0] === "totvs.tds-vscode-2.1.10");

// Versoes lidas da arvore extensao/node_modules/@totvs/tds-ls/bin/windows
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-"));
const ext = path.join(raiz, "totvs.tds-vscode-2.1.4");
const tdsLs = path.join(ext, "node_modules", "@totvs", "tds-ls");
const bin = path.join(tdsLs, "bin", "windows");
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(ext, "package.json"), JSON.stringify({ version: "2.1.4" }));
fs.writeFileSync(path.join(tdsLs, "package.json"), JSON.stringify({ version: "2.2.6" }));
const exe = path.join(bin, "advpls.exe");
fs.writeFileSync(exe, "");
const info = advplsBinaryInfo(exe);
caso("le versao do tds-ls", info.versaoTdsLs === "2.2.6");
caso("le versao da extensao", info.versaoExtensao === "2.1.4");
const solto = advplsBinaryInfo(path.join(raiz, "advpls.exe"));
caso("binario fora da extensao nao inventa versao", !solto.versaoTdsLs && !solto.versaoExtensao);
fs.rmSync(raiz, { recursive: true, force: true });

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DO ADVPLS PASSARAM");
