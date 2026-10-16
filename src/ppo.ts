/**
 * PPO (fonte pré-processado) pelo modo `appre` do advpls: roda o pré-processador
 * local, sem AppServer, sem sessão e sem tocar o RPO. É o mesmo pré-processador
 * que gera o texto do PPO numa compilação no servidor.
 *
 * O appre grava a saída ao lado do fonte (`<nome>.ppx_<ext>`, `<nome>.ppo` e,
 * no erro, `<nome>.err<ext>`), então ele roda numa cópia em pasta temporária. A
 * pasta original do fonte entra como primeira pasta de include: rodando no
 * lugar, o appre acha ali os `.ch` do próprio fonte, e a cópia precisa achar os
 * mesmos.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CP1252 = new TextDecoder("windows-1252");
const TIMEOUT_MS = 60_000;

export interface PpoResult {
  /** Texto pré-processado; ausente quando o pré-processador acusou erro. */
  ppo?: string;
  /** Erros do pré-processador, com o nome do fonte original. */
  erros: string[];
}

export async function gerarPpo(advplsPath: string, arquivo: string, includes: string[]): Promise<PpoResult> {
  const original = path.resolve(arquivo);
  const base = path.join(os.tmpdir(), "tds-mcp");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "ppo-"));
  try {
    const copia = path.join(dir, path.basename(original));
    fs.copyFileSync(original, copia);
    const args = ["appre", "-I", path.dirname(original), ...includes.flatMap((i) => ["-I", i]), copia];
    const stderr = await executar(advplsPath, args);

    const saidas = fs.readdirSync(dir);
    const ler = (nome: string) => CP1252.decode(fs.readFileSync(path.join(dir, nome)));
    const nomeOriginal = path.basename(original);
    const erros = saidas
      .filter((n) => /\.err[^.]*$/i.test(n))
      .flatMap((n) => ler(n).split(/\r?\n/))
      .map((l) => l.trim())
      .filter(Boolean)
      // O appre troca o nome do fonte por APPRE<n>.<ext>; a linha está certa.
      .map((l) => l.replace(/\bAPPRE\d+\.[A-Za-z]+/g, nomeOriginal));
    const texto = saidas
      .filter((n) => /\.(ppx_[^.]+|ppo)$/i.test(n))
      .map(ler)
      .find((t) => t.trim().length > 0);
    if (erros.length === 0 && !texto) {
      erros.push(`O advpls appre não gerou o PPO${stderr ? `: ${stderr.trim().slice(0, 500)}` : "."}`);
    }
    if (erros.length > 0) return { erros };
    return { ppo: trocarCaminho(texto!, dir, path.dirname(original)), erros: [] };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Troca a pasta temporária pela pasta original nos #line (o appre grava o caminho em minúsculas). */
function trocarCaminho(texto: string, temporaria: string, original: string): string {
  const variantes = [temporaria, temporaria.replace(/\\/g, "/")];
  let saida = texto;
  for (const v of variantes) {
    const escapado = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    saida = saida.replace(new RegExp(escapado, "gi"), original);
  }
  return saida;
}

function executar(exe: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr!.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`O advpls appre não terminou em ${TIMEOUT_MS / 1000} s.`));
    }, TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // O código de saída não serve de veredito (erro de pré-processamento sai com
    // 127 ou -1): quem decide são os arquivos gerados.
    proc.on("close", () => {
      clearTimeout(timer);
      resolve(stderr);
    });
  });
}
