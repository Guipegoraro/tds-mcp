/**
 * Perfil descartável do navegador aberto pelo tds-mcp e pelo iniciador do chrome-devtools.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Data na escala do Chromium: microssegundos desde 01/01/1601 UTC, como texto (int64 no JSON). */
function dataChromium(ms: number): string {
  return String(BigInt(ms + 11_644_473_600_000) * 1000n);
}

/**
 * Grava no perfil novo que a senha do Windows não é vazia. Sem essa resposta o
 * gerenciador de senhas do Chromium tenta um login com senha vazia
 * (password_manager_util_win.cc), o Windows conta como senha errada e a conta
 * local do usuário bloqueia depois de algumas aberturas. O Chromium só confia
 * na resposta gravada depois da última troca da senha: a hora atual sempre é.
 */
export function marcarSenhaNaoVazia(profileDir: string): void {
  const estado = { password_manager: { os_password_blank: false, os_password_last_changed: dataChromium(Date.now()) } };
  fs.writeFileSync(path.join(profileDir, "Local State"), JSON.stringify(estado));
}

function processoVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Perfil novo e já marcado em `base`, com o pid do dono no nome. */
export function criarPerfil(base: string): string {
  fs.mkdirSync(base, { recursive: true });
  const perfil = fs.mkdtempSync(path.join(base, `perfil-${process.pid}-`));
  marcarSenhaNaoVazia(perfil);
  return perfil;
}

/** Intervalo em que a sessão viva renova a data do perfil. */
const RENOVACAO_MS = 3600_000;
/** Perfil sem renovação há mais tempo que isto não tem dono, mesmo com o pid em uso por outro processo. */
const ABANDONO_MS = 24 * RENOVACAO_MS;

/** Renova a data do perfil enquanto a sessão vive, sem segurar o fim do processo. */
export function manterPerfil(perfil: string): void {
  setInterval(() => {
    try {
      const agora = new Date();
      fs.utimesSync(perfil, agora, agora);
    } catch {
      /* perfil removido */
    }
  }, RENOVACAO_MS).unref();
}

/**
 * Remove o perfil, insistindo enquanto o navegador que fecha ainda segura
 * arquivos. Espera sem o laço de eventos, para servir no "exit" do processo
 * (o maxRetries do rmSync não repete nesse caso).
 */
export function removerPerfil(perfil: string, esperaMs = 5000): boolean {
  const limite = Date.now() + esperaMs;
  for (;;) {
    try {
      fs.rmSync(perfil, { recursive: true, force: true });
      return true;
    } catch {
      if (Date.now() >= limite) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/**
 * Remove os perfis de `base` cujo processo dono terminou sem limpar (encerrado
 * à força). O navegador ainda vivo mantém o `lockfile` aberto: se ele não puder
 * ser removido, a pasta inteira fica para a próxima vez.
 */
export function removerPerfisOrfaos(base: string): void {
  if (!fs.existsSync(base)) return;
  const limite = Date.now() - ABANDONO_MS;
  for (const nome of fs.readdirSync(base)) {
    const dono = /^perfil-(\d+)-/.exec(nome);
    if (!dono) continue;
    const perfil = path.join(base, nome);
    try {
      if (processoVivo(Number(dono[1])) && fs.statSync(perfil).mtimeMs >= limite) continue;
      fs.rmSync(path.join(perfil, "lockfile"), { force: true });
      fs.rmSync(perfil, { recursive: true, force: true });
    } catch {
      /* navegador ainda aberto */
    }
  }
}

/** Tira o --isolated (o perfil próprio já isola) e diz se a sessão abre navegador com perfil nosso. */
export function prepararArgumentos(args: string[]): { args: string[]; usaPerfil: boolean } {
  const nome = (a: string) => /^--?([\w-]+)/.exec(a)?.[1].replace(/-/g, "").toLowerCase() ?? "";
  // Com estes o chrome-devtools usa um navegador ou um perfil que o usuário escolheu.
  const deOutro = ["browserurl", "u", "wsendpoint", "w", "autoconnect", "userdatadir"];
  if (args.some((a) => deOutro.includes(nome(a)))) return { args, usaPerfil: false };
  const resto = args.filter((a, i) => nome(a) !== "isolated" && !(args[i - 1] === "--isolated" && /^(true|false)$/i.test(a)));
  return { args: resto, usaPerfil: true };
}
