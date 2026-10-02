/**
 * Verificação de sintaxe pelo linter do advpls (TDS Language Server).
 *
 * No tds-ls 2.2.x o modo syntaxOnly da compilação não passa pelo AppServer:
 * a análise é do linter local, que só publica resultado
 * (textDocument/publishDiagnostics) para arquivo aberto num workspace LSP.
 * Por isso a verificação sobe um advpls próprio, com handshake LSP completo
 * — initialize com capacidades mínimas derruba o processo —, abre cada fonte
 * e colhe os diagnósticos. Não usa o AppServer nem a sessão.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node.js";
import { URI } from "vscode-uri";

export interface LintDiagnostic {
  arquivo: string;
  linha: number;
  severidade: "erro" | "aviso" | "info";
  mensagem: string;
}

/** Aviso do linter para arquivo fora do workspace: não é resultado da análise. */
const OUTSIDE_WORKSPACE = /outside the workspace/i;

/**
 * Mensagens que o linter marca como erro mas o compilador aceita com warning
 * (conferido compilando no AppServer): rebaixadas a aviso.
 */
const COMPILER_WARNINGS: { pattern: RegExp; codigo: string }[] = [
  { pattern: /variable is not Local/i, codigo: "W0004" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fontes AdvPL são Windows-1252: € e aspas curvas (0x80-0x9F) não existem em latin1. */
const CP1252 = new TextDecoder("windows-1252");

export async function lintFiles(
  advplsPath: string,
  files: string[],
  includes: string[],
  timeoutPerFileMs = 20000
): Promise<{ diagnosticos: LintDiagnostic[]; semResposta: string[] }> {
  const proc = spawn(advplsPath, ["language-server", "--notification-level=none"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // Falha no spawn e escrita depois que o processo saiu (EPIPE) não podem
  // derrubar o MCP; sem resposta, os fontes saem em semResposta.
  proc.on("error", () => {});
  proc.stdin!.on("error", () => {});
  proc.stderr!.on("data", () => {});
  const conn = createMessageConnection(new StreamMessageReader(proc.stdout!), new StreamMessageWriter(proc.stdin!));
  conn.onError(() => {});
  // A escrita da notificação é aguardada (o didClose sai antes do kill do
  // finally) e a falha é absorvida: só ocorre com o advpls já encerrado, e uma
  // rejeição sem tratamento derrubaria o MCP. Devolve false quando não escreveu.
  const notify = async (method: string, params: unknown): Promise<boolean> => {
    try {
      await conn.sendNotification(method, params);
      return true;
    } catch {
      return false; // inclui a conexão já fechada, que lança antes de escrever
    }
  };
  const received = new Map<string, { at: number; diagnostics: any[] }>();
  conn.onRequest("workspace/configuration", (p: { items?: unknown[] }) => (p?.items ?? []).map(() => null));
  conn.onRequest(() => null);
  conn.onNotification("textDocument/publishDiagnostics", (p: { uri: string; diagnostics: any[] }) => {
    const real = (p.diagnostics ?? []).filter((d) => !OUTSIDE_WORKSPACE.test(String(d.message)));
    // Só o aviso de "fora do workspace" não conta como análise concluída.
    if (real.length === 0 && (p.diagnostics ?? []).length > 0) return;
    received.set(URI.parse(p.uri).fsPath.toLowerCase(), { at: Date.now(), diagnostics: real });
  });
  conn.onNotification(() => {
    /* logs e demais notificações */
  });
  conn.listen();

  try {
    const folders = [...new Set(files.map((f) => path.dirname(f)))];
    const dyn = { dynamicRegistration: true };
    const kinds = { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) };
    await withTimeout(
      conn.sendRequest("initialize", {
        processId: process.pid,
        clientInfo: { name: "tds-mcp" },
        rootUri: URI.file(folders[0]).toString(),
        workspaceFolders: folders.map((f) => ({ uri: URI.file(f).toString(), name: path.basename(f) })),
        initializationOptions: {
          settings: [
            { scope: "advpls", key: "fsencoding", value: "CP1252" },
            { scope: "linter", key: "includes", value: includes.join(";") },
            { scope: "linter", key: "behavior", value: "enabled" },
            { scope: "editor", key: "indexCache", value: "onMemory" },
          ],
        },
        capabilities: {
          workspace: {
            applyEdit: true,
            workspaceEdit: { documentChanges: true },
            workspaceFolders: true,
            configuration: true,
            symbol: { ...dyn, symbolKind: kinds },
            fileOperations: { ...dyn, didCreate: true, didRename: true, willDelete: true, willRename: true },
            didChangeWatchedFiles: dyn,
          },
          textDocument: {
            synchronization: { ...dyn, didSave: true, willSave: false },
            documentSymbol: { ...dyn, hierarchicalDocumentSymbolSupport: true, symbolKind: kinds },
            definition: { ...dyn, linkSupport: true },
            references: dyn,
            hover: { ...dyn, contentFormat: ["markdown", "plaintext"] },
            publishDiagnostics: { relatedInformation: true },
          },
          window: { workDoneProgress: true, showMessage: { messageActionItem: { additionalPropertiesSupport: true } } },
        },
      }),
      30000,
      "O language server não respondeu ao initialize."
    );
    await notify("initialized", {});

    const diagnosticos: LintDiagnostic[] = [];
    const semResposta: string[] = [];
    for (const [i, file] of files.entries()) {
      const key = path.resolve(file).toLowerCase();
      const uri = URI.file(file).toString();
      const aberto = await notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "advpl", version: 1, text: CP1252.decode(fs.readFileSync(file)) },
      });
      // advpls encerrado: este e os demais fontes ficam sem resposta, e o que
      // já foi colhido é devolvido.
      if (!aberto) {
        semResposta.push(...files.slice(i));
        break;
      }
      const deadline = Date.now() + timeoutPerFileMs;
      const vivo = () => proc.exitCode === null && Date.now() < deadline;
      while (!received.has(key) && vivo()) await sleep(100);
      // O linter pode publicar mais de uma vez: espera a última assentar.
      while (received.has(key) && Date.now() - received.get(key)!.at < 600 && vivo()) await sleep(100);
      const got = received.get(key);
      await notify("textDocument/didClose", { textDocument: { uri } });
      if (!got) {
        semResposta.push(file);
        continue;
      }
      for (const d of got.diagnostics) {
        const mensagem = String(d.message).trim();
        const rebaixada = d.severity === 1 ? COMPILER_WARNINGS.find((w) => w.pattern.test(mensagem)) : undefined;
        diagnosticos.push({
          arquivo: file,
          linha: Number(d.range?.start?.line ?? 0) + 1,
          severidade: rebaixada ? "aviso" : d.severity === 1 ? "erro" : d.severity === 2 ? "aviso" : "info",
          mensagem: rebaixada ? `${mensagem} (o compilador aceita com warning ${rebaixada.codigo})` : mensagem,
        });
      }
    }
    return { diagnosticos, semResposta };
  } finally {
    try {
      conn.dispose();
    } catch {
      /* já encerrada */
    }
    proc.kill();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}
