/**
 * Sessão com o AppServer: lê o servers.json do TDS (~/.totvsls) e mantém a
 * conexão autenticada ativa (connect -> reconnect por token salvo -> ou
 * authentication com credenciais do config do MCP).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AdvplsClient, CONN_TYPE } from "./advpls.js";
import type { TdsMcpConfig, ServerCredentials } from "./config.js";

export interface TdsServerDef {
  id: string;
  type: string;
  name: string;
  address: string;
  port: number;
  buildVersion?: string;
  secure: boolean;
  includes?: string[];
  environments?: string[];
  environment?: string;
  username?: string;
  token?: string;
  patchGenerateDir?: string;
}

export interface ServersJson {
  version: string;
  includes: string[];
  permissions?: { authorizationtoken?: string };
  connectedServer?: TdsServerDef;
  configurations: TdsServerDef[];
  savedTokens?: [string, { id: string; token: string }][];
}

export interface ActiveSession {
  def: TdsServerDef;
  environment: string;
  connectionToken: string;
  user: string;
  authMethod: "none" | "saved-token" | "credentials";
  /** Conexão de monitor aberta sob demanda (ver SessionManager.monitorToken). */
  monitorToken?: string;
}

/**
 * Localiza o servers.json na mesma ordem que o TDS:
 * override explícito > servers.json do workspace (opção
 * `totvsLanguageServer.workspaceServerConfig`) > global em ~/.totvsls.
 */
export function serversJsonPath(): string {
  const override = process.env.TDS_MCP_SERVERS_JSON;
  if (override && fs.existsSync(override)) return override;

  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, ".vscode", "servers.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return path.join(os.homedir(), ".totvsls", "servers.json");
}

/** Código do tipo de servidor esperado pelo protocolo: Protheus/Logix/TotvsTec. */
export function serverTypeCode(type: string | undefined): number {
  switch (type) {
    case "totvs_server_logix":
      return 2;
    case "totvs_server_totvstec":
      return 3;
    default:
      return 1; // totvs_server_protheus
  }
}

export function readServersJson(): ServersJson {
  const raw = fs.readFileSync(serversJsonPath(), "utf-8");
  return JSON.parse(raw) as ServersJson;
}

/**
 * Servidor por id, nome exato (sem diferenciar maiúsculas) ou parte única do
 * nome. Parte do nome que casa com mais de um servidor é recusada: conectar no
 * primeiro da lista poderia levar um patch para o ambiente errado.
 */
export function findServer(cfg: ServersJson, nameOrId: string): TdsServerDef | undefined {
  const needle = nameOrId.toLowerCase();
  const exact =
    cfg.configurations.find((s) => s.id === nameOrId) ??
    cfg.configurations.find((s) => s.name.toLowerCase() === needle);
  if (exact) return exact;
  const partial = cfg.configurations.filter((s) => s.name.toLowerCase().includes(needle));
  if (partial.length > 1) {
    throw new Error(
      `"${nameOrId}" casa com ${partial.length} servidores: ${partial.map((s) => s.name).join(", ")}. ` +
        `Informe o nome completo.`
    );
  }
  return partial[0];
}

/** Token global de autorização de compilação (compile key/token) do TDS, se houver. */
export function authorizationToken(cfg: ServersJson): string {
  return cfg.permissions?.authorizationtoken ?? "";
}

/** Includes efetivos: do servidor, senão os globais do servers.json. */
export function effectiveIncludes(cfg: ServersJson, def: TdsServerDef): string[] {
  const list = def.includes?.length ? def.includes : cfg.includes;
  return (list ?? []).filter((i) => !!i);
}

/**
 * Token de reconexão salvo pelo TDS para um servidor: campo `token` da própria
 * configuração ou entrada em `savedTokens` (chave "<id><environment>").
 */
export function savedTokenFor(cfg: ServersJson, def: TdsServerDef, environment: string): string | undefined {
  if (Array.isArray(cfg.savedTokens)) {
    for (const entry of cfg.savedTokens) {
      const [key, value] = entry;
      if (key === def.id + environment && value?.token) return value.token;
    }
  }
  // O token da própria configuração é o da última conexão do TDS, no ambiente
  // registrado em def.environment.
  if (def.token && (!def.environment || def.environment.toLowerCase() === environment.toLowerCase())) {
    return def.token;
  }
  return undefined;
}

export class SessionManager {
  private client: AdvplsClient;
  private config: TdsMcpConfig;
  current?: ActiveSession;

  constructor(client: AdvplsClient, config: TdsMcpConfig) {
    this.client = client;
    this.config = config;
  }

  /**
   * Conecta e autentica em um servidor/ambiente.
   * Ordem de autenticação: credenciais informadas na chamada (só para esta
   * sessão; não são gravadas) -> token salvo do TDS -> credenciais do config.
   */
  async useServer(
    nameOrId: string,
    environment?: string,
    explicit?: ServerCredentials
  ): Promise<ActiveSession> {
    const cfg = readServersJson();
    const def = findServer(cfg, nameOrId);
    if (!def) {
      const known = cfg.configurations.map((s) => s.name).join(", ");
      throw new Error(`Servidor "${nameOrId}" não encontrado no servers.json. Conhecidos: ${known}`);
    }

    const env = environment ?? def.environment;
    if (!env) {
      throw new Error(
        `Ambiente não informado e servidor "${def.name}" não tem ambiente padrão. ` +
          `Ambientes conhecidos: ${(def.environments ?? []).join(", ") || "(nenhum)"}`
      );
    }

    // Encerra sessão anterior (e a conexão de monitor dela), se houver
    if (this.current) {
      const previous = this.current;
      const tokens: [string, string][] = [[previous.def.name, previous.connectionToken]];
      if (previous.monitorToken) tokens.push([`${previous.def.name}_monitor`, previous.monitorToken]);
      for (const [name, token] of tokens) {
        try {
          await this.client.disconnect(name, token);
        } catch {
          /* melhor esforço */
        }
      }
      this.current = undefined;
    }

    // Detecta build/secure atuais (também valida que o servidor está no ar)
    let build = def.buildVersion ?? "";
    let secure = def.secure;
    try {
      const v = await this.client.validation(def.address, def.port, def.type);
      if (v.build) build = v.build;
      secure = !!v.secure;
    } catch {
      if (!build || build === "TIMEOUT") {
        throw new Error(`Servidor "${def.name}" (${def.address}:${def.port}) não respondeu à validação.`);
      }
    }

    const conn = await this.client.connect({
      serverName: def.name,
      identification: def.id,
      server: def.address,
      port: def.port,
      build,
      secure,
      environment: env,
      serverType: serverTypeCode(def.type),
    });

    if (!conn.connectionToken) {
      throw new Error(`Falha ao conectar em "${def.name}" (${def.address}:${def.port}).`);
    }

    if (!conn.needAuthentication) {
      this.current = {
        def,
        environment: env,
        connectionToken: conn.connectionToken,
        user: def.username ?? "",
        authMethod: "none",
      };
      return this.current;
    }

    // 1) Token de reconexão salvo pelo TDS (zero-config quando o VS Code já conectou antes)
    const saved = explicit ? undefined : savedTokenFor(cfg, def, env);
    if (saved) {
      try {
        const rec = await this.client.reconnect(def.name, saved);
        if (rec.connectionToken && (!rec.environment || rec.environment.toLowerCase() === env.toLowerCase())) {
          this.current = {
            def,
            environment: env,
            connectionToken: rec.connectionToken,
            user: rec.user || def.username || "",
            authMethod: "saved-token",
          };
          return this.current;
        }
      } catch {
        /* token expirado/ambiente diferente: cai para credenciais */
      }
    }

    // 2) Credenciais informadas na chamada, senão as do config do MCP
    const creds = explicit ?? this.config.credentials[def.name];
    if (creds) {
      // A tentativa de reconnect frustrada pode invalidar o token da conexão
      // original; abre uma conexão nova antes de autenticar.
      let authConnToken = conn.connectionToken;
      if (saved) {
        const fresh = await this.client.connect({
          serverName: def.name,
          identification: def.id,
          server: def.address,
          port: def.port,
          build,
          secure,
          environment: env,
          serverType: serverTypeCode(def.type),
        });
        if (fresh.connectionToken) authConnToken = fresh.connectionToken;
      }
      const auth = await this.client
        .authenticate({
          connectionToken: authConnToken,
          environment: env,
          user: creds.user,
          password: creds.password,
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          // O AppServer devolve essa mensagem quando falha ao abrir o ambiente,
          // e o motivo fica só no console.log dele.
          if (/non numeric value/i.test(msg)) {
            throw new Error(
              `${msg} O AppServer não conseguiu abrir o ambiente "${env}": a causa costuma ser o banco ` +
                "fora do ar (TOPConnect/DBAccess erro -35, ex.: SQL Server sem memória) ou o RPO em uso " +
                "travado; o motivo exato está no console.log do AppServer."
            );
          }
          throw err;
        });
      if (auth.connectionToken) {
        this.current = {
          def,
          environment: env,
          connectionToken: auth.connectionToken,
          user: creds.user,
          authMethod: "credentials",
        };
        return this.current;
      }
      throw new Error(`Autenticação recusada em "${def.name}" para o usuário "${creds.user}".`);
    }

    throw new Error(
      `Servidor "${def.name}" exige autenticação. O token de reconexão do TDS não funcionou ` +
        `(conecte pelo VS Code para renová-lo) ou cadastre credenciais em ~/.tds-mcp/config.json: ` +
        `{"credentials": {"${def.name}": {"user": "...", "password": "..."}}}`
    );
  }

  /** Sessão ativa ou erro orientando o uso de tds_use_server. */
  required(): ActiveSession {
    if (!this.current) {
      throw new Error(
        "Nenhum servidor conectado. Use a tool tds_use_server primeiro (veja tds_list_servers)."
      );
    }
    return this.current;
  }

  /**
   * Token da conexão de monitor do servidor ativo. As requests $totvsmonitor/*
   * só valem numa conexão do tipo MONITOR; ela nasce de um
   * reconnect com o token da sessão ativa e o nome "<servidor>_monitor",
   * como faz o monitor do tds-vscode.
   */
  async monitorToken(): Promise<string> {
    const active = this.required();
    if (active.monitorToken) return active.monitorToken;
    const rec = await this.client.reconnect(
      `${active.def.name}_monitor`,
      active.connectionToken,
      CONN_TYPE.MONITOR
    );
    if (!rec?.connectionToken) {
      throw new Error(
        `Não foi possível abrir a conexão de monitor em "${active.def.name}". ` +
          `Confira se o usuário tem privilégio de monitor (tds_server_permissions).`
      );
    }
    active.monitorToken = rec.connectionToken;
    return active.monitorToken;
  }
}
