/**
 * Rastreabilidade de patches: nomenclatura padrão, título/descrição
 * recomendados (data+hora em destaque no título), manifesto por patch e
 * histórico append-only por pasta de ticket + global.
 *
 * Organização: <patchesRoot>/<cliente>/<ticket>/
 *   AAAAMMDD_HHMMSS_<slug>.ptm
 *   AAAAMMDD_HHMMSS_<slug>.manifest.json
 *   historico.jsonl
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export interface PatchSourceEntry {
  name: string;
  rpoDate: string;
}

export interface PatchManifest {
  titulo: string;
  descricao: string;
  patchFile: string;
  sha256: string;
  sizeBytes: number;
  patchType: string;
  cliente: string;
  ticket: string;
  server: {
    name: string;
    address: string;
    port: number;
    environment: string;
    build: string;
  };
  sources: PatchSourceEntry[];
  author: string;
  createdAt: string;
  git?: { commit: string; dirty: boolean; repo: string };
}

export interface HistoryEvent {
  ts: string;
  op: "generate" | "validate" | "apply";
  patchFile: string;
  server: string;
  environment: string;
  author: string;
  ok: boolean;
  detail?: string;
}

function two(n: number): string {
  return n.toString().padStart(2, "0");
}

export interface PatchStamp {
  /** DDMMAA_HHMM (padrão brasileiro) — usado no nome do arquivo */
  fileStamp: string;
  /** DDMMAA_HHMMSS — variante com segundos, para evitar colisão no mesmo minuto */
  fileStampSeconds: string;
  /** DD/MM/AAAA HH:MM — usado no título */
  humanStamp: string;
  iso: string;
}

export function nowStamp(date: Date = new Date()): PatchStamp {
  const y = date.getFullYear();
  const yy = String(y).slice(2);
  const mo = two(date.getMonth() + 1);
  const d = two(date.getDate());
  const h = two(date.getHours());
  const mi = two(date.getMinutes());
  const s = two(date.getSeconds());
  return {
    fileStamp: `${d}${mo}${yy}_${h}${mi}`,
    fileStampSeconds: `${d}${mo}${yy}_${h}${mi}${s}`,
    humanStamp: `${d}/${mo}/${y} ${h}:${mi}`,
    iso: date.toISOString(),
  };
}

/** Slug seguro para nome de arquivo/pasta. */
export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** Nome-base do patch: data/hora primeiro (informação mais importante), DDMMAA_HHMM. */
export function patchBaseName(stamp: PatchStamp, slug: string, withSeconds = false): string {
  const prefix = withSeconds ? stamp.fileStampSeconds : stamp.fileStamp;
  return `${prefix}_${slugify(slug)}`;
}

/** Título recomendado: data e hora lideram, depois contexto. */
export function recommendedTitle(
  stamp: PatchStamp,
  cliente: string,
  ticket: string,
  sources: string[]
): string {
  const srcPart =
    sources.length <= 3 ? sources.join(", ") : `${sources.slice(0, 3).join(", ")} +${sources.length - 3}`;
  return `${stamp.humanStamp} — ${cliente} ${ticket} — ${srcPart}`;
}

/** Descrição recomendada com tudo que importa para auditoria. */
export function recommendedDescription(args: {
  stamp: PatchStamp;
  cliente: string;
  ticket: string;
  descricao: string;
  serverName: string;
  environment: string;
  build: string;
  sources: PatchSourceEntry[];
  author: string;
}): string {
  const lines = [
    `Patch gerado em ${args.stamp.humanStamp} por ${args.author}.`,
    `Cliente: ${args.cliente} | Ticket: ${args.ticket}`,
    `Origem: ${args.serverName} / ambiente ${args.environment} (build ${args.build})`,
    `Fontes (${args.sources.length}):`,
    ...args.sources.map((s) => `  - ${s.name}${s.rpoDate ? ` (RPO: ${s.rpoDate})` : ""}`),
  ];
  if (args.descricao) lines.push(`Motivo: ${args.descricao}`);
  return lines.join("\n");
}

export function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

/** Informações git do diretório dos fontes locais, se for um repositório. */
export function gitInfo(dir: string): PatchManifest["git"] | undefined {
  try {
    const opts = { cwd: dir, stdio: ["ignore", "pipe", "ignore"] as ("ignore" | "pipe")[] };
    const commit = execFileSync("git", ["rev-parse", "HEAD"], opts).toString().trim();
    const status = execFileSync("git", ["status", "--porcelain"], opts).toString().trim();
    const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], opts).toString().trim();
    return { commit, dirty: status.length > 0, repo };
  } catch {
    return undefined;
  }
}

export function currentAuthor(): string {
  return os.userInfo().username;
}

export function ensurePatchDir(patchesRoot: string, cliente: string, ticket: string): string {
  const dir = path.join(patchesRoot, slugify(cliente), slugify(ticket));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeManifest(dir: string, baseName: string, manifest: PatchManifest): string {
  const file = path.join(dir, `${baseName}.manifest.json`);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), "utf-8");
  return file;
}

/** Acrescenta evento no historico.jsonl da pasta e no histórico global da raiz. */
export function appendHistory(patchesRoot: string, dir: string | undefined, event: HistoryEvent): void {
  const line = JSON.stringify(event) + "\n";
  if (dir) {
    fs.appendFileSync(path.join(dir, "historico.jsonl"), line, "utf-8");
  }
  fs.mkdirSync(patchesRoot, { recursive: true });
  fs.appendFileSync(path.join(patchesRoot, "historico-global.jsonl"), line, "utf-8");
}
