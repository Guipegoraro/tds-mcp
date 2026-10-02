/**
 * Cliente DAP (Debug Adapter Protocol) para o debugAdapter da TOTVS (tds-da).
 *
 * O adaptador fala DAP por stdio, com o mesmo enquadramento do LSP
 * (Content-Length). Além dos eventos padrão, emite `TDA/log` com o nível
 * (INFO/WARN/ERROR/CONSOLE): logpoints chegam como WARN e o erro de execução
 * chega como ERROR quando a thread termina.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface DapEvent {
  event: string;
  body?: any;
  /** Já entregue a algum waitFor. */
  consumed?: boolean;
}

export interface DapResponse {
  success: boolean;
  message?: string;
  body?: any;
}

/**
 * Binário do debugAdapter: config explícita > ao lado do advpls em uso
 * (<ext>/node_modules/@totvs/tds-ls/bin/windows -> .../@totvs/tds-da/bin/windows).
 */
export function resolveDebugAdapterPath(advplsPath: string, configured?: string): string {
  if (configured && fs.existsSync(configured)) return configured;
  const fromEnv = process.env.TDS_MCP_DEBUG_ADAPTER;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const totvsDir = path.resolve(path.dirname(advplsPath), "..", "..", "..");
  const candidate = path.join(totvsDir, "tds-da", "bin", "windows", "debugAdapter.exe");
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(
    `debugAdapter.exe não encontrado (procurado em ${candidate}). Informe debugAdapterPath no ` +
      `config do tds-mcp ou TDS_MCP_DEBUG_ADAPTER.`
  );
}

export class DapClient {
  readonly proc: ChildProcess;
  /** Log interno do adaptador (--log-file): é onde ele registra a URL do webapp. Apagado quando o adaptador sai. */
  readonly internalLog: string;
  readonly events: DapEvent[] = [];
  private seq = 1;
  private buf = Buffer.alloc(0);
  private pending = new Map<number, (r: DapResponse) => void>();
  private waiters: { names: string[]; resolve: (e: DapEvent) => void }[] = [];
  private exited = false;

  constructor(adapterPath: string, internalLog: string) {
    this.internalLog = internalLog;
    fs.rmSync(internalLog, { force: true });
    this.proc = spawn(adapterPath, [`--log-file=${internalLog}`], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr!.on("data", () => {
      /* o adaptador escreve diagnóstico no --log-file */
    });
    // O log interno só serve enquanto o adaptador vive e contém o token da
    // conexão com o AppServer: sai junto com o processo.
    this.proc.on("exit", () => {
      this.exited = true;
      try {
        fs.rmSync(internalLog, { force: true });
      } catch {
        /* ainda bloqueado pelo Windows; a varredura do próximo start remove */
      }
      this.deliver({ event: "terminated", body: { adapterExited: true } });
      for (const resolve of this.pending.values()) resolve({ success: false, message: "debugAdapter encerrado" });
      this.pending.clear();
    });
  }

  get alive(): boolean {
    return !this.exited;
  }

  request(command: string, args: unknown = {}, timeoutMs = 30000): Promise<DapResponse> {
    if (this.exited) return Promise.resolve({ success: false, message: "debugAdapter encerrado" });
    const seq = this.seq++;
    const body = Buffer.from(JSON.stringify({ seq, type: "request", command, arguments: args }), "utf8");
    this.proc.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin!.write(body);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        resolve({ success: false, message: `sem resposta do debugAdapter em ${timeoutMs / 1000}s` });
      }, timeoutMs);
      this.pending.set(seq, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
  }

  /** Próximo evento (não consumido) com um dos nomes; TIMEOUT vira undefined. */
  waitFor(names: string[], timeoutMs: number): Promise<DapEvent | undefined> {
    const queued = this.events.find((e) => !e.consumed && names.includes(e.event));
    if (queued) {
      queued.consumed = true;
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => {
      const waiter = {
        names,
        resolve: (e: DapEvent) => {
          clearTimeout(timer);
          resolve(e);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(undefined);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Mensagens TDA/log a partir de um índice de evento (logpoints, erros). */
  logsSince(index: number): { nivel: string; mensagem: string }[] {
    return this.events
      .slice(index)
      .filter((e) => e.event === "TDA/log" && e.body?.level && e.body.level !== "INFO")
      .map((e) => ({ nivel: String(e.body.level), mensagem: String(e.body.message ?? "").trim() }));
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {
      /* já encerrado */
    }
  }

  private deliver(event: DapEvent): void {
    const waiter = this.waiters.find((w) => w.names.includes(event.event));
    if (waiter) {
      event.consumed = true;
      this.waiters = this.waiters.filter((w) => w !== waiter);
      waiter.resolve(event);
    }
    this.events.push(event);
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const head = this.buf.indexOf("\r\n\r\n");
      if (head < 0) return;
      const match = /Content-Length: (\d+)/i.exec(this.buf.subarray(0, head).toString());
      if (!match) {
        this.buf = this.buf.subarray(head + 4);
        continue;
      }
      const len = Number(match[1]);
      if (this.buf.length < head + 4 + len) return;
      const msg = JSON.parse(this.buf.subarray(head + 4, head + 4 + len).toString("utf8"));
      this.buf = this.buf.subarray(head + 4 + len);
      if (msg.type === "response") {
        this.pending.get(msg.request_seq)?.({ success: !!msg.success, message: msg.message, body: msg.body });
        this.pending.delete(msg.request_seq);
      } else if (msg.type === "event") {
        this.deliver({ event: msg.event, body: msg.body });
      } else if (msg.type === "request") {
        // Pedidos reversos (ex.: runInTerminal) não são usados no modo web.
        const body = Buffer.from(
          JSON.stringify({ seq: this.seq++, type: "response", request_seq: msg.seq, command: msg.command, success: false }),
          "utf8"
        );
        this.proc.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`);
        this.proc.stdin!.write(body);
      }
    }
  }
}
