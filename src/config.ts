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
import { z } from "zod";

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
  /** Caminho explícito do debugAdapter.exe (opcional; padrão: ao lado do advpls) */
  debugAdapterPath?: string;
  /** Navegador para o webapp (opcional; padrão: Chromium, Chrome ou Edge instalados) */
  chromiumPath?: string;
  /**
   * URL do webapp por NOME de servidor, quando não for a padrão
   * http(s)://<endereço>:<porta>/webapp/ (porta multiprotocolo).
   */
  webappUrls?: Record<string, string>;
  /** Minutos sem uso até uma sessão de depuração ser encerrada (padrão 10). */
  debugIdleMinutes?: number;
}

const CONFIG_DIR = path.join(os.homedir(), ".tds-mcp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const DEFAULTS: TdsMcpConfig = {
  patchesRoot: "C:\\TOTVS\\patches",
  credentials: {},
};

const CREDENTIAL_SCHEMA = z.object({ user: z.string(), password: z.string() });

/** Validação por campo: um campo inválido é descartado sem perder os demais. */
const FIELD_SCHEMAS: Record<keyof TdsMcpConfig, z.ZodTypeAny> = {
  patchesRoot: z.string().min(1),
  advplsPath: z.string().min(1),
  credentials: z.record(CREDENTIAL_SCHEMA),
  debugAdapterPath: z.string().min(1),
  chromiumPath: z.string().min(1),
  webappUrls: z.record(z.string().min(1)),
  debugIdleMinutes: z.number().positive(),
};

/** Problemas encontrados ao ler o config.json (mostrados em tds_server_log). */
export const configWarnings: string[] = [];

export function loadConfig(file = CONFIG_FILE): TdsMcpConfig {
  configWarnings.length = 0;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return { ...DEFAULTS, credentials: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    warn(`${file} não é JSON válido e foi ignorado (${err instanceof Error ? err.message : err}).`);
    return { ...DEFAULTS, credentials: {} };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn(`${file} precisa ser um objeto JSON; foi ignorado.`);
    return { ...DEFAULTS, credentials: {} };
  }
  const result: TdsMcpConfig = { ...DEFAULTS, credentials: {} };
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "credentials" && value && typeof value === "object" && !Array.isArray(value)) {
      // Cada servidor vale por si: uma credencial malformada não descarta as demais.
      for (const [servidor, cred] of Object.entries(value)) {
        const check = CREDENTIAL_SCHEMA.safeParse(cred);
        if (check.success) result.credentials[servidor] = check.data;
        else warn(`${file}: credencial de "${servidor}" inválida e ignorada (precisa de user e password).`);
      }
      continue;
    }
    const schema = FIELD_SCHEMAS[key as keyof TdsMcpConfig];
    if (!schema) continue;
    // Vazio conta como não informado (o config.example.json traz "advplsPath": "").
    if (value === null || value === undefined || value === "") continue;
    const check = schema.safeParse(value);
    if (check.success) (result as unknown as Record<string, unknown>)[key] = check.data;
    else warn(`${file}: campo "${key}" inválido e ignorado (${check.error.issues[0]?.message ?? "formato"}).`);
  }
  return result;
}

function warn(message: string): void {
  configWarnings.push(message);
  console.error(`tds-mcp: ${message}`);
}

export function configFilePath(): string {
  return CONFIG_FILE;
}

export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}
