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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chromium: config > TDS_MCP_CHROMIUM > Chromium do usuário > Chrome > Edge. */
export function resolveChromiumPath(configured?: string): string {
  const candidates = [
    configured,
    process.env.TDS_MCP_CHROMIUM,
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

export class HeadlessWebapp {
  private proc: ChildProcess;
  private ws?: WebSocket;
  private id = 0;
  private pending = new Map<number, (msg: any) => void>();

  private constructor(proc: ChildProcess) {
    this.proc = proc;
  }

  static async open(chromiumPath: string, url: string, profileDir: string): Promise<HeadlessWebapp> {
    fs.mkdirSync(profileDir, { recursive: true });
    const portFile = path.join(profileDir, "DevToolsActivePort");
    fs.rmSync(portFile, { force: true });
    const proc = spawn(
      chromiumPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        url,
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const page = new HeadlessWebapp(proc);
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      try {
        port = Number(fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0]);
      } catch {
        await sleep(100);
      }
    }
    if (!port) {
      page.close();
      throw new Error("O navegador headless não abriu a porta de depuração (CDP).");
    }
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
    const target = targets.find((t) => t.type === "page");
    if (!target) {
      page.close();
      throw new Error("O navegador headless não abriu a página do webapp.");
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Falha ao conectar no CDP do navegador headless."));
    });
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id && page.pending.has(msg.id)) {
        page.pending.get(msg.id)!(msg);
        page.pending.delete(msg.id);
      }
    };
    page.ws = ws;
    return page;
  }

  private send(method: string, params: unknown = {}): Promise<any> {
    return new Promise((resolve) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(undefined);
      }, 5000);
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

  close(): void {
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
}
