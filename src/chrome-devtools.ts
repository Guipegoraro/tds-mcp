/**
 * Inicia o chrome-devtools-mcp com um perfil de navegador próprio da sessão, no
 * lugar do --isolated: o perfil já sai marcado para o Chromium não testar a
 * senha do Windows e é apagado no fim, ou no próximo início quando a sessão é
 * encerrada à força.
 * Uso: node dist/chrome-devtools.js [argumentos do chrome-devtools-mcp]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { criarPerfil, manterPerfil, prepararArgumentos, removerPerfil, removerPerfisOrfaos } from "./perfil.js";

/** Executável do pacote global chrome-devtools-mcp; o caminho interno muda entre versões e vem do package.json dele. */
function localizarMcp(): string {
  const raizes = [path.join(path.dirname(process.execPath), "node_modules")];
  if (process.env.APPDATA) raizes.unshift(path.join(process.env.APPDATA, "npm", "node_modules"));
  let raiz = raizes.find((r) => fs.existsSync(path.join(r, "chrome-devtools-mcp", "package.json")));
  if (!raiz) {
    try {
      raiz = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
    } catch {
      /* sem npm no PATH */
    }
  }
  const pacote = path.join(raiz ?? "", "chrome-devtools-mcp");
  const manifesto = path.join(pacote, "package.json");
  const bin = raiz && fs.existsSync(manifesto) ? JSON.parse(fs.readFileSync(manifesto, "utf8")).bin : undefined;
  const relativo = typeof bin === "string" ? bin : bin?.["chrome-devtools-mcp"];
  if (!relativo) throw new Error("chrome-devtools-mcp não encontrado. Instale com: npm install -g chrome-devtools-mcp");
  return path.join(pacote, relativo);
}

const entrada = localizarMcp();
const base = path.join(os.tmpdir(), "tds-mcp", "chrome-devtools");
removerPerfisOrfaos(base);
const { args, usaPerfil } = prepararArgumentos(process.argv.slice(2));
if (usaPerfil) {
  const perfil = criarPerfil(base);
  manterPerfil(perfil);
  args.push(`--userDataDir=${perfil}`);
  const limpar = () => void removerPerfil(perfil);
  process.on("exit", limpar);
  // O Puppeteer encerra o navegador no próprio "exit", registrado a cada abertura:
  // a limpeza volta para o fim da fila, senão roda com o perfil ainda em uso.
  process.on("newListener", (evento, ouvinte) => {
    if (evento !== "exit" || ouvinte === limpar) return;
    queueMicrotask(() => process.off("exit", limpar).on("exit", limpar));
  });
}
process.argv = [process.argv[0], entrada, ...args];
await import(pathToFileURL(entrada).href);
