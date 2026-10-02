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

/** Sessão (thread) do AppServer como o monitor a reporta. */
export interface MonitorUser {
  username: string;
  computerName: string;
  threadId: number;
  server: string;
  mainName: string;
  environment: string;
  loginTime: string;
  elapsedTime: string;
  totalInstrCount: number;
  instrCountPerSec: number;
  remark: string;
  memUsed: number;
  sid: string;
  ctreeTaskId: number;
  clientType: string;
  inactiveTime: string;
}

/** Sessão-alvo das ações do monitor (mensagem, desconexão). */
export type MonitorTarget = Pick<
  MonitorUser,
  "username" | "computerName" | "threadId" | "server" | "environment"
>;

export interface ServerPermissionsResult {
  message: string;
  serverPermissions: { operation: string[]; text: string[] };
}

export const CONN_TYPE = { DEBUGGER: 3, MONITOR: 13 } as const;

/** Requests que podem levar minutos (pasta grande, patch grande): prazo de 30 min; os demais, 5 min. */
const LONG_REQUESTS = new Set([
  "$totvsserver/compilation",
  "$totvsserver/patchGenerate",
  "$totvsserver/patchApply",
  "$totvsserver/patchInfo",
]);

// ---------------------------------------------------------------------------
// Localização do binário
// ---------------------------------------------------------------------------

/** Compara versões "a.b.c" numericamente (2.1.10 > 2.1.9); partes ausentes valem 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Resolve o caminho do advpls: config explícita > variável de ambiente >
 * extensão tds-vscode instalada (maior versão, comparada numericamente — o
 * VS Code mantém a versão anterior na pasta por um tempo após atualizar).
 */
export function resolveAdvplsPath(configured?: string): string {
  // Caminho escolhido explicitamente e ausente é erro: cair na detecção
  // automática usaria outro binário sem o usuário saber.
  if (configured) {
    if (isFile(configured)) return configured;
    throw new Error(`advplsPath do config do tds-mcp não existe ou não é arquivo: ${configured}`);
  }

  const fromEnv = process.env.TDS_MCP_ADVPLS;
  if (fromEnv) {
    if (isFile(fromEnv)) return fromEnv;
    throw new Error(`TDS_MCP_ADVPLS não existe ou não é arquivo: ${fromEnv}`);
  }

  const extDir = path.join(os.homedir(), ".vscode", "extensions");
  const binRel = path.join("node_modules", "@totvs", "tds-ls", "bin", "windows", "advpls.exe");
  const prefix = "totvs.tds-vscode-";
  if (fs.existsSync(extDir)) {
    const candidates = fs
      .readdirSync(extDir)
      .filter((d) => d.startsWith(prefix))
      .sort((a, b) => compareVersions(b.slice(prefix.length), a.slice(prefix.length)));
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

/** Caminho existe e é arquivo (não pasta). */
export function isFile(p: string): boolean {
  return fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
}

export interface AdvplsBinaryInfo {
  caminho: string;
  /** Versão do pacote @totvs/tds-ls que traz o binário, quando identificável. */
  versaoTdsLs?: string;
  /** Versão da extensão tds-vscode que contém o binário, quando for o caso. */
  versaoExtensao?: string;
}

/**
 * Versões do binário em uso, lidas dos package.json vizinhos
 * (<ext>/node_modules/@totvs/tds-ls/bin/windows/advpls.exe). Correções de
 * conexão com releases novas do Protheus chegam por versão do tds-ls.
 */
export function advplsBinaryInfo(advplsPath: string): AdvplsBinaryInfo {
  const info: AdvplsBinaryInfo = { caminho: advplsPath };
  const readVersion = (pkg: string): string | undefined => {
    try {
      return JSON.parse(fs.readFileSync(pkg, "utf-8")).version;
    } catch {
      return undefined;
    }
  };
  const tdsLsDir = path.resolve(path.dirname(advplsPath), "..", "..");
  if (path.basename(tdsLsDir) === "tds-ls") {
    info.versaoTdsLs = readVersion(path.join(tdsLsDir, "package.json"));
    const extRoot = path.resolve(tdsLsDir, "..", "..", "..");
    if (path.basename(extRoot).startsWith("totvs.tds-vscode-")) {
      info.versaoExtensao = readVersion(path.join(extRoot, "package.json"));
    }
  }
  return info;
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

export class AdvplsClient {
  private proc: ChildProcess;
  private conn: MessageConnection;
  private disposed = false;
  /** Motivo de o advpls não estar disponível, devolvido nos requests seguintes. */
  private exitReason = "advpls não está em execução";
  /** Últimas mensagens de log/console enviadas pelo servidor (janela circular). */
  readonly serverLog: string[] = [];
  /** Total de mensagens já recebidas; marca de posição para logSince(). */
  logCount = 0;

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

    // Sem estes handlers, falha no spawn ou EPIPE na escrita derrubariam o
    // processo do MCP inteiro. O stderr é drenado para o pipe não encher.
    proc.on("error", (err) => {
      client.exitReason = `advpls não pôde ser executado: ${err.message}`;
      client.pushLog(client.exitReason);
      client.dispose();
    });
    proc.stdin!.on("error", () => {});
    proc.stderr!.on("data", () => {});
    // dispose() rejeita os requests pendentes; sem ele, a tool em andamento
    // ficaria esperando para sempre a resposta de um processo morto.
    proc.on("exit", (code) => {
      client.pushLog(`advpls encerrou com código ${code}`);
      client.dispose();
    });

    // Sem handshake LSP: o advpls aceita os requests $totvsserver/* diretamente
    // (mesmo comportamento do @totvs/tds-languageclient oficial). Enviar um
    // initialize com params mínimos derruba o processo (0xC0000409).
    return client;
  }

  private pushLog(message?: string): void {
    if (!message) return;
    this.logCount++;
    this.serverLog.push(message);
    if (this.serverLog.length > 200) this.serverLog.shift();
  }

  /** Mensagens recebidas depois da marca `logCount` informada (as que ainda estão na janela). */
  logSince(mark: number): string[] {
    const novas = this.logCount - mark;
    return novas > 0 ? this.serverLog.slice(-novas) : [];
  }

  get alive(): boolean {
    return !this.disposed;
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.disposed) return Promise.reject(new Error(this.exitReason));
    const longo = LONG_REQUESTS.has(method);
    const timeoutMs = longo ? 30 * 60_000 : 5 * 60_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `${method} sem resposta do advpls em ${timeoutMs / 60_000} min.` +
                (longo
                  ? " A operação pode continuar no servidor e ainda gravar no RPO: confira com " +
                    "tds_rpo_objects antes de repetir."
                  : "")
            )
          ),
        timeoutMs
      );
    });
    return Promise.race([this.conn.sendRequest(method, params) as Promise<T>, timeout]).finally(() =>
      clearTimeout(timer)
    );
  }

  // ------------------------------------------------------------------
  // Requests $totvsserver/*
  // ------------------------------------------------------------------

  validation(
    server: string,
    port: number,
    serverType = "totvs_server_protheus"
  ): Promise<ValidationResult> {
    return this.request("$totvsserver/validation", {
      validationInfo: { server, port, serverType },
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
    /** 1 = Protheus, 2 = Logix, 3 = TotvsTec (Harpia). */
    serverType?: number;
  }): Promise<ConnectResult> {
    return this.request("$totvsserver/connect", {
      connectionInfo: {
        connType: info.connType ?? CONN_TYPE.DEBUGGER,
        serverName: info.serverName,
        identification: info.identification,
        serverType: info.serverType ?? 1,
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

  reconnect(
    serverName: string,
    connectionToken: string,
    connType: number = CONN_TYPE.DEBUGGER
  ): Promise<ReconnectResult> {
    return this.request("$totvsserver/reconnect", {
      reconnectInfo: { connectionToken, serverName, connType },
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

  /** Pastas (includeDir=true) ou arquivos de uma pasta do servidor; "" = raiz. */
  async getPatchDir(
    connectionToken: string,
    environment: string,
    folder: string,
    includeDir: boolean
  ): Promise<string[]> {
    const response = await this.request<{ directory?: string[] }>("$totvsserver/getPatchDir", {
      pathDirListInfo: { connectionToken, environment, folder, includeDir },
    });
    return response?.directory ?? [];
  }

  serverPermissions(connectionToken: string): Promise<ServerPermissionsResult> {
    return this.request("$totvsserver/serverPermissions", {
      serverPermissionsInfo: { connectionToken },
    });
  }

  // ------------------------------------------------------------------
  // Monitor: exigem token de conexão do tipo MONITOR
  // ------------------------------------------------------------------

  async getUsers(monitorToken: string): Promise<MonitorUser[]> {
    const response = await this.request<{ mntUsers?: MonitorUser[] }>("$totvsmonitor/getUsers", {
      getUsersInfo: { connectionToken: monitorToken },
    });
    return response?.mntUsers ?? [];
  }

  /** Mensagem exibida ao usuário da sessão. Resposta do servidor em `message`. */
  async sendUserMessage(monitorToken: string, target: MonitorTarget, message: string): Promise<string> {
    const response = await this.request<{ message?: string }>("$totvsmonitor/sendUserMessage", {
      sendUserMessageInfo: {
        connectionToken: monitorToken,
        userName: target.username,
        computerName: target.computerName,
        threadId: target.threadId,
        server: target.server,
        environment: target.environment,
        message,
      },
    });
    return response?.message ?? "";
  }

  /** Encerra a sessão imediatamente. */
  async killUser(monitorToken: string, target: MonitorTarget): Promise<string> {
    const response = await this.request<{ message?: string }>("$totvsmonitor/killUser", {
      killUserInfo: {
        connectionToken: monitorToken,
        userName: target.username,
        computerName: target.computerName,
        threadId: target.threadId,
        serverName: target.server,
      },
    });
    return response?.message ?? "";
  }

  /** Pede à aplicação da sessão que se encerre (desconexão não imediata). */
  async appKillUser(monitorToken: string, target: MonitorTarget): Promise<string> {
    const response = await this.request<{ message?: string }>("$totvsmonitor/appKillUser", {
      appKillUserInfo: {
        connectionToken: monitorToken,
        userName: target.username,
        computerName: target.computerName,
        threadId: target.threadId,
        serverName: target.server,
      },
    });
    return response?.message ?? "";
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
