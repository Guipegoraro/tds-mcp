// Abrir o navegador headless não pode contar tentativa de senha errada na conta do Windows — precisa do
// navegador instalado, não precisa de AppServer. Só mede em conta local desbloqueada e com o contador em zero;
// navegador aberto com perfil novo por outro programa durante o teste também soma no contador.
// Uso: node test/e2e-senha-windows.mjs
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removerPerfil } from "../dist/perfil.js";
import { HeadlessWebapp, resolveChromiumPath } from "../dist/webapp.js";
import { lerConta, motivoParaPular } from "./conta-windows.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const motivo = motivoParaPular(2);
if (motivo) {
  console.log(`SKIP  ${motivo}`);
  process.exit(0);
}

const navegador = resolveChromiumPath();
const base = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-e2e-senha-"));
try {
  const pagina = await HeadlessWebapp.open(navegador, "about:blank", base);
  await sleep(8000);
  await pagina.close();
  const depois = lerConta();
  const ok = typeof depois !== "string" && depois.erros === 0;
  console.log(`${ok ? "PASS" : "FAIL"}  abrir o navegador headless não conta senha errada (0 -> ${depois.erros ?? depois})`);
  process.exitCode = ok ? 0 : 1;
} finally {
  removerPerfil(base);
}
