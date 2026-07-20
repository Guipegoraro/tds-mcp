/**
 * Cliente JSON-RPC para o advpls (TDS Language Server) em modo language-server.
 *
 * O advpls é o mesmo binário usado pela extensão tds-vscode. A comunicação é
 * LSP padrão via stdio + requests proprietários ($totvsserver/*).
 * Especificação viva: https://github.com/totvs/tds-vscode/blob/master/src/protocolMessages.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";

// ---------------------------------------------------------------------------
// Tipos do protocolo (extraídos de protocolMessages.ts / CompileResult.ts)
// ---------------------------------------------------------------------------

export interface ValidationResult {
  id?: unknown;
  build: string;
  secure: number;
}

export interface ConnectResult {
  id?: unknown;
  osType: number;
  connectionToken: string;
  needAuthentication: boolean;
}

export interface AuthenticationResult {
  id?: unknown;
  osType?: number;
  connectionToken: string;
  isOidcAuth?: boolean;
}

export interface ReconnectResult {
  connectionToken: string;
  environment: string;
  user: string;
}

export interface CompileInfo {
  status: string; // SUCCESS | WARN | ERROR | FATAL | APPRE | SKIP...
  filePath: string;
  message: string;
  detail: string;
}

export interface CompileResult {
  returnCode: number; // 40840 = token de autorização expirado
  compileInfos: CompileInfo[];
}

export interface CompileOptions {
  recompile: boolean;
  debugAphInfo: boolean;
  gradualSending: boolean;
  generatePpoFile: boolean;
  showPreCompiler: boolean;
  priorVelocity: boolean;
  returnPpo: boolean;
  commitWithErrorOrWarning: boolean;
  syntaxOnly: boolean;
}

export interface PatchGenerateResult {
  returnCode: number;
  message?: string;
}

export interface PatchValidateEntry {
  file: string;
  datePatch: string;
  dateRpo: string;
}

export interface PatchApplyResult {
  error: number | boolean;
  errorCode: number;
  message: string;
  patchValidates: PatchValidateEntry[];
}

export interface RpoProgramApp {
  name: string;
  date: string;
}

export interface RpoPatchInfo {
  dateFileGeneration: string;
  buildFileGeneration: string;
  dateFileApplication: string;
  buildFileApplication: string;
  skipOld: boolean;
  typePatch: number;
  programsApp: RpoProgramApp[];
}

export interface RpoInfoResult {
  rpoVersion: string;
  dateGeneration: string;
  environment: string;
  rpoPatchs: RpoPatchInfo[];
}

export interface RpoObject {
  source: string;
  date: string;
  rpo_status: string;
  source_status: string;
}

export interface RpoFunction {
  function: string;
  source: string;
  line: number;
  rpo_status: string;
  source_status: string;
}

export const CONN_TYPE = { DEBUGGER: 3, MONITOR: 13 } as const;

// ---------------------------------------------------------------------------
// Localização do binário
// ---------------------------------------------------------------------------

/**
 * Resolve o caminho do advpls: config explícita > variável de ambiente >
 * extensão tds-vscode instalada (maior versão).
 */
export function resolveAdvplsPath(configured?: string): string {
  if (configured && fs.existsSync(configured)) return configured;

  const fromEnv = process.env.TDS_MCP_ADVPLS;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const extDir = path.join(os.homedir(), ".vscode", "extensions");
  const binRel = path.join("node_modules", "@totvs", "tds-ls", "bin", "windows", "advpls.exe");
  if (fs.existsSync(extDir)) {
    const candidates = fs
      .readdirSync(extDir)
      .filter((d) => d.startsWith("totvs.tds-vscode-"))
      .sort()
      .reverse();
    for (const dir of candidates) {
      const p = path.join(extDir, dir, binRel);
      if (fs.existsSync(p)) return p;
    }
  }

  throw new Error(
    "advpls.exe não encontrado. Instale a extensão totvs.tds-vscode no VS Code, " +
      "ou informe o caminho em TDS_MCP_ADVPLS / config advplsPath."
  );
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

export class AdvplsClient {
  private proc: ChildProcess;
  private conn: MessageConnection;
  private disposed = false;
  /** Últimas mensagens de log/console enviadas pelo servidor (janela circular). */
  readonly serverLog: string[] = [];

  private constructor(proc: ChildProcess, conn: MessageConnection) {
    this.proc = proc;
    this.conn = conn;
  }

  static async start(advplsPath: string): Promise<AdvplsClient> {
    const proc = spawn(advplsPath, ["language-server", "--notification-level=none"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const conn = createMessageConnection(
      new StreamMessageReader(proc.stdout!),
      new StreamMessageWriter(proc.stdin!)
    );

    const client = new AdvplsClient(proc, conn);

    // Requests/notifications que o servidor pode enviar; respondemos de forma neutra
    conn.onRequest("window/showMessageRequest", () => null);
    conn.onRequest("client/registerCapability", () => null);
    conn.onRequest("workspace/configuration", (params: { items?: unknown[] }) =>
      (params?.items ?? []).map(() => null)
    );
    conn.onNotification("window/showMessage", (p: { message?: string }) => client.pushLog(p?.message));
    conn.onNotification("window/logMessage", (p: { message?: string }) => client.pushLog(p?.message));
    conn.onNotification(() => {
      /* demais notificações (diagnostics, progress...) são ignoradas */
    });

    conn.listen();

    proc.on("exit", (code) => {
      client.disposed = true;
      client.pushLog(`advpls encerrou com código ${code}`);
    });

    // Sem handshake LSP: o advpls aceita os requests $totvsserver/* diretamente
    // (mesmo comportamento do @totvs/tds-languageclient oficial). Enviar um
    // initialize com params mínimos derruba o processo (0xC0000409).
    return client;
  }

  private pushLog(message?: string): void {
    if (!message) return;
    this.serverLog.push(message);
    if (this.serverLog.length > 200) this.serverLog.shift();
  }

  get alive(): boolean {
    return !this.disposed;
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("advpls não está em execução"));
    return this.conn.sendRequest(method, params) as Promise<T>;
  }

  // ------------------------------------------------------------------
  // Requests $totvsserver/*
  // ------------------------------------------------------------------

  validation(server: string, port: number): Promise<ValidationResult> {
    return this.request("$totvsserver/validation", {
      validationInfo: { server, port, serverType: "totvs_server_protheus" },
    });
  }

  connect(info: {
    serverName: string;
    identification: string;
    server: string;
    port: number;
    build: string;
    secure: boolean;
    environment: string;
    connType?: number;
  }): Promise<ConnectResult> {
    return this.request("$totvsserver/connect", {
      connectionInfo: {
        connType: info.connType ?? CONN_TYPE.DEBUGGER,
        serverName: info.serverName,
        identification: info.identification,
        serverType: 1, // totvs_server_protheus
        server: info.server,
        port: info.port,
        build: info.build,
        bSecure: info.secure ? 1 : 0,
        environment: info.environment,
        autoReconnect: true,
      },
    });
  }

  authenticate(info: {
    connectionToken: string;
    environment: string;
    user: string;
    password: string;
  }): Promise<AuthenticationResult> {
    return this.request("$totvsserver/authentication", {
      authenticationInfo: {
        connectionToken: info.connectionToken,
        environment: info.environment,
        user: info.user,
        password: info.password,
        encoding: "CP1252",
      },
    });
  }

  reconnect(serverName: string, connectionToken: string): Promise<ReconnectResult> {
    return this.request("$totvsserver/reconnect", {
      reconnectInfo: {
        connectionToken,
        serverName,
        connType: CONN_TYPE.DEBUGGER,
      },
    });
  }

  disconnect(serverName: string, connectionToken: string): Promise<unknown> {
    return this.request("$totvsserver/disconnect", {
      disconnectInfo: { connectionToken, serverName },
    });
  }

  compile(info: {
    connectionToken: string;
    authorizationToken: string;
    environment: string;
    includeUris: string[];
    fileUris: string[];
    options: CompileOptions;
    includeUrisRequired: boolean;
  }): Promise<CompileResult> {
    return this.request("$totvsserver/compilation", {
      compilationInfo: {
        connectionToken: info.connectionToken,
        authorizationToken: info.authorizationToken,
        environment: info.environment,
        includeUris: info.includeUris,
        fileUris: info.fileUris,
        compileOptions: info.options,
        extensionsAllowed: undefined,
        includeUrisRequired: info.includeUrisRequired,
        syntaxOnly: info.options.syntaxOnly,
      },
    });
  }

  patchGenerate(info: {
    connectionToken: string;
    authorizationToken: string;
    environment: string;
    patchDestUri: string;
    patchName: string;
    patchFiles: string[];
    patchType?: number;
  }): Promise<PatchGenerateResult> {
    return this.request("$totvsserver/patchGenerate", {
      patchGenerateInfo: {
        connectionToken: info.connectionToken,
        authorizationToken: info.authorizationToken,
        environment: info.environment,
        patchMaster: "",
        patchDest: info.patchDestUri,
        isLocal: true,
        patchType: info.patchType ?? 3, // 3 = PTM
        name: info.patchName,
        patchFiles: info.patchFiles,
      },
    });
  }

  patchApply(info: {
    connectionToken: string;
    authorizationToken: string;
    environment: string;
    patchUri: string;
    validateOnly: boolean;
    applyOld?: boolean;
  }): Promise<PatchApplyResult> {
    return this.request("$totvsserver/patchApply", {
      patchApplyInfo: {
        connectionToken: info.connectionToken,
        authorizationToken: info.authorizationToken,
        environment: info.environment,
        patchUri: info.patchUri,
        isLocal: true,
        isValidOnly: info.validateOnly,
        applyScope: info.validateOnly ? "none" : info.applyOld ? "all" : "only_new",
      },
    });
  }

  patchInfo(info: {
    connectionToken: string;
    authorizationToken: string;
    environment: string;
    patchUri: string;
  }): Promise<{ patchInfos: unknown }> {
    return this.request("$totvsserver/patchInfo", {
      patchInfoInfo: {
        connectionToken: info.connectionToken,
        authorizationToken: info.authorizationToken,
        environment: info.environment,
        patchUri: info.patchUri,
        isLocal: true,
      },
    });
  }

  rpoInfo(connectionToken: string, environment: string): Promise<RpoInfoResult> {
    return this.request("$totvsserver/rpoInfo", {
      rpoInfo: { connectionToken, environment },
    });
  }

  async inspectorObjects(
    connectionToken: string,
    environment: string,
    includeTres: boolean
  ): Promise<RpoObject[]> {
    const response = await this.request<{ objects: string[] }>("$totvsserver/inspectorObjects", {
      inspectorObjectsInfo: { connectionToken, environment, includeTres },
    });
    // Formato de cada linha: "FONTE.PRW (DD/MM/AAAA HH:MM:SS) XY"
    const regexp = /(.*)\s\((.*)\)\s(.)(.)/i;
    return (response.objects ?? []).map((line) => {
      const groups = regexp.exec(line);
      return groups
        ? { source: groups[1], date: groups[2], source_status: groups[3], rpo_status: groups[4] }
        : { source: line, date: "", source_status: "", rpo_status: "" };
    });
  }

  async inspectorFunctions(
    connectionToken: string,
    environment: string,
    includeOnlyPublic: boolean
  ): Promise<RpoFunction[]> {
    const response = await this.request<{ functions: string[] }>(
      "$totvsserver/inspectorFunctions",
      { inspectorFunctionsInfo: { connectionToken, environment } }
    );
    const regexp = /(#NONE#)?(.*)(#NONE#)?\s\((.*):(\d+)\)\s?(.)(.)/i;
    return (response.functions ?? [])
      .filter((line) => !(includeOnlyPublic && line.startsWith("#NONE")))
      .map((line) => {
        const groups = regexp.exec(line);
        if (!groups) {
          return { function: line, source: "", line: 0, source_status: "", rpo_status: "" };
        }
        return {
          function: groups[1]
            ? "#" + groups[2].substring(0, groups[2].indexOf("#"))
            : groups[2],
          source: groups[4],
          line: Number.parseInt(groups[5]),
          source_status: groups[6],
          rpo_status: groups[7],
        };
      });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.conn.dispose();
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
  }
}
