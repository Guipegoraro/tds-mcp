/**
 * Configuração própria do tds-mcp: ~/.tds-mcp/config.json
 *
 * Guarda o que NÃO vem do servers.json do TDS: raiz da organização de patches,
 * caminho alternativo do advpls e credenciais de fallback por servidor
 * (usadas apenas quando o token de reconexão do TDS não funcionar).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface ServerCredentials {
  user: string;
  password: string;
}

export interface TdsMcpConfig {
  /** Raiz da árvore de patches: <root>/<cliente>/<ticket>/ */
  patchesRoot: string;
  /** Caminho explícito do advpls.exe (opcional) */
  advplsPath?: string;
  /** Credenciais por NOME de servidor (como aparece no servers.json) */
  credentials: Record<string, ServerCredentials>;
}

const CONFIG_DIR = path.join(os.homedir(), ".tds-mcp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const DEFAULTS: TdsMcpConfig = {
  patchesRoot: "C:\\TOTVS\\patches",
  credentials: {},
};

export function loadConfig(): TdsMcpConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TdsMcpConfig>;
    return { ...DEFAULTS, ...parsed, credentials: parsed.credentials ?? {} };
  } catch {
    return { ...DEFAULTS };
  }
}

export function configFilePath(): string {
  return CONFIG_FILE;
}

export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}
