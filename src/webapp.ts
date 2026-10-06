/**
 * Chromium headless que faz o papel do SmartClient HTML (webapp) nas execuções
 * e depurações do tds-mcp, controlado por CDP (Chrome DevTools Protocol).
 *
 * Os componentes do webapp (wa-dialog, wa-button, wa-multi-get...) desenham o
 * conteúdo em shadow DOM: `document.body.innerText` vem vazio, então o texto e
 * os botões são lidos percorrendo as shadow roots.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isFile } from "./advpls.js";
import { SCRIPT_PORTA_AGENTE } from "./webagent.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chromium: config > TDS_MCP_CHROMIUM > Chromium do usuário > Chrome > Edge. */
export function resolveChromiumPath(configured?: string): string {
  // Navegador escolhido explicitamente e ausente é erro, não motivo para usar outro.
  for (const [origem, escolhido] of [
    ["chromiumPath do config do tds-mcp", configured],
    ["TDS_MCP_CHROMIUM", process.env.TDS_MCP_CHROMIUM],
  ] as const) {
    if (!escolhido) continue;
    if (isFile(escolhido)) return escolhido;
    throw new Error(`${origem} não existe ou não é arquivo: ${escolhido}`);
  }
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Chromium", "Application", "chrome.exe"),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error(
    "Navegador para o webapp não encontrado (Chromium, Chrome ou Edge). Informe chromiumPath no " +
      "config do tds-mcp ou TDS_MCP_CHROMIUM."
  );
}

/** Funções injetadas na página para ler e acionar o webapp através do shadow DOM. */
const PAGE_HELPERS = `(() => {
  const each = (root, fn) => { for (const el of root.querySelectorAll('*')) { fn(el); if (el.shadowRoot) each(el.shadowRoot, fn); } };
  const label = (el) => ((el.shadowRoot ? el.shadowRoot.textContent : '') || el.textContent ||
    (el.getAttribute('caption') || '').replace(/<[^>]+>/g, '')).replace(/\\s+/g, '').toLowerCase();
  window.__tdsMcp = {
    screenText() {
      const out = [];
      const walk = (node) => {
        for (const n of node.childNodes) {
          if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) out.push(t); }
          if (n.shadowRoot) walk(n.shadowRoot);
          if (n.childNodes && n.childNodes.length) walk(n);
        }
      };
      if (document.body) walk(document.body);
      return [...new Set(out)].join('\\n');
    },
    buttons() {
      const out = [];
      each(document, (el) => { if (/^WA-BUTTON$/i.test(el.tagName) && !el.hasAttribute('hidden')) out.push(label(el)); });
      return out;
    },
    click(text) {
      const wanted = String(text).replace(/\\s+/g, '').toLowerCase();
      let hit;
      each(document, (el) => { if (!hit && /^WA-BUTTON$/i.test(el.tagName) && label(el) === wanted) hit = el; });
      if (!hit) return false;
      const inner = hit.shadowRoot && hit.shadowRoot.querySelector('button');
      (inner || hit).click();
      return true;
    },
    textareas() {
      const out = [];
      each(document, (el) => { if (el.tagName === 'TEXTAREA' && el.value) out.push(el.value); });
      const inRoots = (root) => { for (const t of root.querySelectorAll('textarea')) if (t.value) out.push(t.value); };
      inRoots(document);
      return [...new Set(out)].join('\\n');
    },
  };
  return true;
})()`;

/** Texto do diálogo padrão de erro de execução do SmartClient. */
const ERROR_DIALOG = /problema foi encontrado na execu[cç][aã]o/i;

export interface WebappErrorCapture {
  /** Primeira linha útil: mensagem + fonte/linha. */
  resumo: string;
  /** Conteúdo de "Detalhes": mensagem, pilha com variáveis locais, ambiente. */
  detalhes: string;
}

/** Arquivo que o programa mandou ao navegador (CpyS2TW, PDF do FWMSPrinter sem WebAgent). */
export interface ArquivoBaixado {
  arquivo: string;
  bytes?: number;
  estado: "baixando" | "concluido" | "cancelado";
}

/** Caminho livre na pasta: "rel.pdf", depois "rel (2).pdf", "rel (3).pdf"... */
function caminhoLivre(dir: string, nome: string): string {
  const base = path.basename(nome) || "download";
  const ext = path.extname(base);
  const raiz = base.slice(0, base.length - ext.length);
  let alvo = path.join(dir, base);
  for (let n = 2; fs.existsSync(alvo); n++) alvo = path.join(dir, `${raiz} (${n})${ext}`);
  return alvo;
}

export class HeadlessWebapp {
  private proc: ChildProcess;
  private ws?: WebSocket;
  private id = 0;
  private pending = new Map<number, (msg: any) => void>();
  private downloadDir?: string;
  /** Por guid do download do Chromium. */
  private downloads = new Map<string, ArquivoBaixado & { nome: string }>();

  private constructor(proc: ChildProcess, profileDir: string) {
    this.proc = proc;
    // Perfil descartável: removido quando o navegador sai (antes disso o
    // Windows mantém os arquivos bloqueados).
    proc.on("exit", () => {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch {
        /* ainda bloqueado; a varredura do próximo start remove */
      }
    });
  }

  /**
   * Abre o webapp num Chromium headless com perfil próprio em `baseDir`.
   * Dois Chromium no mesmo perfil não convivem (o segundo sai com código 21
   * sem abrir o CDP), então cada execução usa uma pasta nova: execuções
   * simultâneas em sessões diferentes do tds-mcp não se bloqueiam.
   * Com `downloadDir`, os arquivos que o programa manda ao navegador são
   * gravados ali com o nome sugerido pelo servidor.
   */
  static async open(chromiumPath: string, url: string, baseDir: string, downloadDir?: string): Promise<HeadlessWebapp> {
    fs.mkdirSync(baseDir, { recursive: true });
    const profileDir = fs.mkdtempSync(path.join(baseDir, "chromium-profile-"));
    const portFile = path.join(profileDir, "DevToolsActivePort");
    const proc = spawn(
      chromiumPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const page = new HeadlessWebapp(proc, profileDir);
    let spawnError: Error | undefined;
    proc.on("error", (err) => (spawnError = err));
    try {
      let port = 0;
      for (let i = 0; i < 100 && !port && !spawnError && proc.exitCode === null; i++) {
        try {
          port = Number(fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0]);
        } catch {
          await sleep(100);
        }
      }
      if (!port) {
        const motivo = spawnError
          ? `: ${spawnError.message}`
          : proc.exitCode !== null
            ? ` (o navegador saiu com código ${proc.exitCode})`
            : "";
        throw new Error(`O navegador headless não abriu a porta de depuração (CDP)${motivo}.`);
      }
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
      const target = targets.find((t) => t.type === "page");
      if (!target) throw new Error("O navegador headless não abriu a página do webapp.");
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      page.ws = ws;
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("Falha ao conectar no CDP do navegador headless."));
      });
      ws.onmessage = (m) => {
        let msg: any;
        try {
          msg = JSON.parse(String(m.data));
        } catch {
          return;
        }
        if (msg.id && page.pending.has(msg.id)) {
          page.pending.get(msg.id)!(msg);
          page.pending.delete(msg.id);
        }
        if (msg.method) page.onEvent(msg.method, msg.params ?? {});
      };
      if (downloadDir) {
        fs.mkdirSync(downloadDir, { recursive: true });
        page.downloadDir = downloadDir;
        // allowAndName grava com o guid como nome; o arquivo é renomeado para
        // o nome sugerido ao concluir, sem sobrescrever outro de mesmo nome.
        await page.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloadDir, eventsEnabled: true });
      }
      // Sem Page.enable o script registrado não roda nas próximas navegações.
      await page.send("Page.enable");
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: SCRIPT_PORTA_AGENTE });
      await page.send("Page.navigate", { url });
      return page;
    } catch (err) {
      await page.close();
      throw err;
    }
  }

  private onEvent(method: string, params: any): void {
    if (!this.downloadDir) return;
    if (method === "Browser.downloadWillBegin") {
      const nome = String(params.suggestedFilename ?? "download");
      this.downloads.set(params.guid, { nome, arquivo: path.join(this.downloadDir, nome), estado: "baixando" });
    } else if (method === "Browser.downloadProgress") {
      const d = this.downloads.get(params.guid);
      if (!d || d.estado !== "baixando") return;
      if (params.state === "completed") {
        d.bytes = params.receivedBytes;
        d.estado = "concluido";
        try {
          d.arquivo = caminhoLivre(this.downloadDir, d.nome);
          fs.renameSync(path.join(this.downloadDir, params.guid), d.arquivo);
        } catch {
          d.arquivo = path.join(this.downloadDir, params.guid);
        }
      } else if (params.state === "canceled") {
        d.estado = "cancelado";
      }
    }
  }

  /**
   * Recarrega o webapp sem o WebAgent: o webapp guarda a porta do agente no
   * localStorage ao recebê-la pela URL, e a usaria de novo.
   */
  async reabrirSemAgente(url: string): Promise<void> {
    await this.send("Runtime.evaluate", {
      expression:
        "for (const k of Object.keys(localStorage)) if (/agentport/i.test(k)) localStorage.removeItem(k)",
    });
    await this.send("Page.navigate", { url });
  }

  /** Arquivos recebidos pelo navegador nesta execução. */
  get arquivosBaixados(): ArquivoBaixado[] {
    return [...this.downloads.values()].map(({ arquivo, bytes, estado }) => ({
      arquivo,
      ...(bytes !== undefined ? { bytes } : {}),
      estado,
    }));
  }

  /**
   * Espera os downloads terminarem, até `ms`. O arquivo enviado no fim do
   * programa (CpyS2TW) começa a chegar ao navegador depois de a thread
   * terminar: durante `inicioMs` ainda se espera um download começar.
   */
  async aguardarDownloads(ms: number, inicioMs = 2000): Promise<void> {
    if (!this.downloadDir) return;
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const baixando = [...this.downloads.values()].some((d) => d.estado === "baixando");
      if (!baixando && Date.now() - t0 >= inicioMs) return;
      await sleep(250);
    }
  }

  private send(method: string, params: unknown = {}, timeoutMs = 5000): Promise<any> {
    return new Promise((resolve) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(undefined);
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      try {
        this.ws!.send(JSON.stringify({ id, method, params }));
      } catch {
        clearTimeout(timer);
        resolve(undefined);
      }
    });
  }

  private async evaluate<T>(expression: string): Promise<T | undefined> {
    await this.send("Runtime.evaluate", { expression: PAGE_HELPERS, returnByValue: true });
    const msg = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    return msg?.result?.result?.value as T | undefined;
  }

  screenText(): Promise<string | undefined> {
    return this.evaluate<string>("window.__tdsMcp.screenText()");
  }

  buttons(): Promise<string[] | undefined> {
    return this.evaluate<string[]>("window.__tdsMcp.buttons()");
  }

  async click(label: string): Promise<boolean> {
    return !!(await this.evaluate<boolean>(`window.__tdsMcp.click(${JSON.stringify(label)})`));
  }

  /**
   * Se o diálogo de erro de execução estiver na tela, devolve o conteúdo de
   * "Detalhes" e fecha o diálogo — a thread então termina e o debugAdapter
   * reporta o erro (TDA/log ERROR).
   */
  async captureErrorDialog(): Promise<WebappErrorCapture | undefined> {
    const screen = await this.screenText();
    if (!screen || !ERROR_DIALOG.test(screen)) return undefined;
    await this.click("Detalhes");
    await sleep(500);
    const detalhes = ((await this.evaluate<string>("window.__tdsMcp.textareas()")) ?? "").trim();
    const resumo =
      detalhes
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("THREAD ERROR")) ?? screen;
    await this.click("Fechar");
    return { resumo, detalhes };
  }

  /** Encerra o navegador sem esperar (saída do processo do MCP). */
  kill(): void {
    try {
      this.ws?.close();
    } catch {
      /* já fechado */
    }
    try {
      this.proc.kill();
    } catch {
      /* já encerrado */
    }
  }

  /**
   * Sai da página do webapp e encerra o navegador, esperando ele sair (até
   * 3 s), quando o perfil é apagado. Com o processo morto sem sair da página,
   * o AppServer não percebe a desconexão e a thread que espera num diálogo
   * fica presa; saindo da página, ela termina em segundos.
   */
  async close(): Promise<void> {
    if (this.proc.exitCode === null && this.ws?.readyState === WebSocket.OPEN) {
      await this.send("Page.navigate", { url: "about:blank" }, 1000);
      await sleep(300);
    }
    this.kill();
    await waitExit(this.proc, 3000);
    // Download interrompido deixa o parcial com o guid como nome.
    for (const [guid, d] of this.downloads) {
      if (d.estado !== "baixando" || !this.downloadDir) continue;
      fs.rmSync(path.join(this.downloadDir, guid), { force: true });
      fs.rmSync(path.join(this.downloadDir, `${guid}.crdownload`), { force: true });
    }
  }
}

/** Resolve quando o processo sai, falha ao iniciar (sem pid) ou o prazo acaba. */
export function waitExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    proc.once("exit", done);
    proc.once("error", done);
  });
}
