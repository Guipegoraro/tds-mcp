/**
 * Sessão de depuração AdvPL/TLPP pelo debugAdapter da TOTVS (tds-da), sem o
 * VS Code.
 *
 * Fluxo: o adaptador conecta no AppServer com o token da sessão do tds-mcp,
 * monta a URL do webapp (`?DEBUG=<id>&E=<ambiente>&P=<programa>`) e a entrega
 * ao "navegador" configurado. O navegador informado ao adaptador é um processo
 * que só fica vivo — o adaptador encerra a sessão quando o navegador dele sai —
 * e a URL, lida do log interno do adaptador, é aberta pelo tds-mcp: num
 * Chromium headless próprio, ou devolvida para o agente abrir no navegador do
 * chrome-devtools e operar as telas do programa.
 *
 * Restrições do adaptador observadas (tds-da 1.4.x):
 * - `stackTrace` sem `startFrame` devolve a pilha vazia;
 * - `evaluate` avalia só no frame do topo; variáveis de outros frames vêm de
 *   `scopes`/`variables` do frame;
 * - `setVariable` não é suportado — alteração de valor é `evaluate("x := v")`;
 * - `pause` não interrompe thread parada em Sleep(); breakpoint incluído com o
 *   programa rodando interrompe;
 * - erro de execução não para o depurador: o SmartClient mostra o diálogo de
 *   erro e o adaptador só emite `TDA/log` ERROR quando a thread termina;
 * - `terminate`/`disconnect` não respondem; a thread parada num breakpoint só
 *   é liberada quando o processo do adaptador termina.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DapClient, type DapEvent } from "./dap.js";
import { HeadlessWebapp, type ArquivoBaixado, type WebappErrorCapture } from "./webapp.js";
import type { ActiveSession } from "./session.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type DebugMode = "headless" | "navegador" | "job";

export interface BreakpointSpec {
  linha: number;
  /** Expressão AdvPL; para só quando verdadeira. */
  condicao?: string;
  /** Logpoint: registra a mensagem ({expr} interpolado) sem parar. */
  log?: string;
  /** Hit count (ex.: "3"). */
  contagem?: string;
  /**
   * Ponto de rastro: ao passar na linha, o tds-mcp avalia estas expressões,
   * registra os valores e continua sozinho. Substitui o logpoint do adaptador,
   * que só interpola nome de variável e deixa valor caractere vazio.
   */
  rastro?: string[];
}

export interface StartOptions {
  active: ActiveSession;
  adapterPath: string;
  chromiumPath?: string;
  webappUrl: string;
  /** Programa inicial do webapp (a função, ou SIGABPM para rodar dentro de um módulo). */
  programa: string;
  argumentos: string[];
  /** Como a sessão é apresentada (ex.: "u_zRotina (módulo 04)"); padrão: programa. */
  descricao?: string;
  breakpoints: Record<string, BreakpointSpec[]>;
  modo: DebugMode;
  /** Pasta para o adaptador mapear nomes de fonte para arquivos locais. */
  pastaFontes: string;
  /** Pasta dos arquivos que o programa manda ao navegador headless. */
  pastaDownloads?: string;
}

interface Snapshot {
  estado: "parado" | "executando" | "encerrado";
  motivo?: string;
  local?: { funcao: string; fonte: string; linha: number };
  pilha?: { frame: number; funcao: string; fonte: string; linha: number }[];
  variaveis?: Record<string, Record<string, string>>;
  watches?: Record<string, string>;
  alteradas?: string[];
  mensagens?: { nivel: string; mensagem: string }[];
  erroDeExecucao?: WebappErrorCapture;
  conectado?: boolean;
  dica?: string;
  tela?: string;
  botoes?: string[];
  fecharAba?: string;
  arquivosBaixados?: ArquivoBaixado[];
}

/** Valor de variável no formato curto "<tipo> <valor>", com "(+)" quando expansível. */
function fmt(v: { type?: string; value?: string; result?: string; variablesReference?: number }): string {
  const raw = String(v.value ?? v.result ?? "");
  const value = raw.length > 300 ? raw.slice(0, 300) + "…" : raw;
  return `${v.type ?? "?"} ${value}${(v.variablesReference ?? 0) > 0 ? " (+)" : ""}`;
}

export class DebugSession {
  readonly dap: DapClient;
  readonly modo: DebugMode;
  readonly programa: string;
  readonly servidor: string;
  readonly ambiente: string;
  readonly iniciadaEm = new Date();
  readonly pastaDownloads?: string;
  url?: string;
  browser?: HeadlessWebapp;
  watches: string[] = [];
  breakpoints = new Map<string, BreakpointSpec[]>();
  lastActivity = Date.now();
  private threadId?: number;
  private logIndex = 0;
  private previous = new Map<string, string>();
  private errorCapture?: WebappErrorCapture;
  private ended = false;
  private conectado = false;
  private traces: { nivel: string; mensagem: string }[] = [];

  constructor(dap: DapClient, opts: StartOptions) {
    this.dap = dap;
    this.modo = opts.modo;
    this.programa = opts.descricao ?? opts.programa;
    this.pastaDownloads = opts.pastaDownloads;
    this.servidor = opts.active.def.name;
    this.ambiente = opts.active.environment;
  }

  get encerrada(): boolean {
    return this.ended || !this.dap.alive;
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  /** URL do webapp montada pelo adaptador, lida do log interno dele. */
  async readWebappUrl(timeoutMs = 15000): Promise<string | undefined> {
    for (let waited = 0; waited < timeoutMs; waited += 250) {
      try {
        const m = /smartClientUrl: (\S+)/.exec(fs.readFileSync(this.dap.internalLog, "utf8"));
        if (m) return m[1];
      } catch {
        /* log ainda não criado */
      }
      await sleep(250);
    }
    return undefined;
  }

  /**
   * O webapp abriu a URL com DEBUG e o programa está sob o depurador. O único
   * sinal do adaptador é a linha "GETACTION RECEBIDO" no log interno, gravada
   * quando o SmartClient se conecta; nenhum evento DAP acompanha.
   */
  clienteConectado(): boolean {
    if (this.conectado) return true;
    try {
      this.conectado = /GETACTION RECEBIDO/.test(fs.readFileSync(this.dap.internalLog, "utf8"));
    } catch {
      /* log ainda não criado ou já removido */
    }
    return this.conectado;
  }

  async setBreakpoints(file: string, specs: BreakpointSpec[]) {
    const abs = path.resolve(file);
    const r = await this.dap.request("setBreakpoints", {
      source: { name: path.basename(abs), path: abs },
      breakpoints: specs.map((b) => ({
        line: b.linha,
        ...(b.condicao ? { condition: b.condicao } : {}),
        ...(b.log ? { logMessage: b.log } : {}),
        ...(b.contagem ? { hitCondition: b.contagem } : {}),
      })),
    });
    if (specs.length) this.breakpoints.set(abs, specs);
    else this.breakpoints.delete(abs);
    return (r.body?.breakpoints ?? []).map((b: any) => ({
      linha: b.line,
      verificado: !!b.verified,
      ...(b.message ? { mensagem: b.message } : {}),
    }));
  }

  /**
   * Espera o programa parar ou terminar. Em modo headless/job, verifica a tela
   * a cada segundo: com o diálogo de erro aberto o adaptador não emite nada,
   * então o erro é capturado da tela e o diálogo é fechado.
   */
  async waitForStop(timeoutSeg: number): Promise<Snapshot> {
    const snap = await this.waitForStopInner(timeoutSeg);
    const baixados = this.browser?.arquivosBaixados ?? [];
    return baixados.length ? { ...snap, arquivosBaixados: baixados } : snap;
  }

  private async waitForStopInner(timeoutSeg: number): Promise<Snapshot> {
    this.touch();
    if (this.ended) return { estado: "encerrado", mensagens: this.takeLogs(), ...this.fecharAba() };
    // Já parado: devolve o estado atual em vez de esperar outra parada.
    if (this.threadId !== undefined) return this.snapshot();
    const deadline = Date.now() + timeoutSeg * 1000;
    while (Date.now() < deadline) {
      const ev = await this.dap.waitFor(["stopped", "terminated"], Math.min(1000, deadline - Date.now()));
      if (ev?.event === "stopped" && (await this.traceAndContinue(ev))) continue;
      if (ev) return this.handleEvent(ev);
      if (this.browser && !this.errorCapture) {
        const captured = await this.browser.captureErrorDialog().catch(() => undefined);
        if (captured) {
          this.errorCapture = captured;
          const end = await this.dap.waitFor(["stopped", "terminated"], 15000);
          if (end) return this.handleEvent(end);
        }
      }
    }
    return { estado: "executando", mensagens: this.takeLogs(), ...this.navegadorStatus(), ...(await this.telaHeadless()) };
  }

  /**
   * Texto e botões da tela do navegador headless: sem eles o agente não sabe
   * se o programa ainda processa ou espera um diálogo (ex.: "Deseja sobrescrever?").
   */
  private async telaHeadless(): Promise<{ tela?: string; botoes?: string[] }> {
    if (!this.browser) return {};
    const tela = ((await this.browser.screenText().catch(() => undefined)) ?? "").trim();
    const botoes = (await this.browser.buttons().catch(() => undefined)) ?? [];
    return {
      ...(tela ? { tela: tela.length > 2000 ? tela.slice(0, 2000) + "…" : tela } : {}),
      ...(botoes.length ? { botoes } : {}),
    };
  }

  /** Contexto isolado do chrome-devtools em que o agente abre a URL desta sessão. */
  get contextoIsolado(): string {
    return `tds-${/[?&]DEBUG=(\d+)/.exec(this.url ?? "")?.[1] ?? this.iniciadaEm.getTime()}`;
  }

  /**
   * No modo navegador a aba é do chrome-devtools e o tds-mcp não a fecha.
   * Encerrar o depurador derruba a thread parada num breakpoint; a que roda
   * ou espera um diálogo continua no AppServer enquanto a aba estiver aberta,
   * e cada sessão deixa uma janela a mais.
   */
  fecharAba(): { fecharAba?: string } {
    if (this.modo !== "navegador") return {};
    return {
      fecharAba:
        `Feche a aba desta sessão no chrome-devtools: list_pages, ache a aba com isolatedContext=${this.contextoIsolado} ` +
        "e chame close_page com o pageId dela. Programa que não estava parado num breakpoint (rodando ou " +
        "esperando um diálogo) continua no AppServer até a página sair.",
    };
  }

  /** Conexão do webapp e o que conferir no chrome-devtools, no modo navegador. */
  navegadorStatus(): { conectado?: boolean; dica?: string } {
    if (this.modo !== "navegador") return {};
    if (this.clienteConectado()) {
      return {
        conectado: true,
        dica:
          "O programa está sob o depurador, mas ainda não parou. Veja a tela no chrome-devtools " +
          "(take_snapshot): ele pode esperar login, confirmação de diálogo ou mostrar o diálogo de erro " +
          "(botões Detalhes/Fechar).",
      };
    }
    return {
      conectado: false,
      dica:
        "Nenhum webapp se conectou a esta sessão: abra a url com new_page e isolatedContext (abrirCom). " +
        "Se a página mostrar o formulário 'Parâmetros Iniciais', ela perdeu os parâmetros da URL e o " +
        "programa digitado ali roda fora do depurador: feche a aba e abra de novo com isolatedContext.",
    };
  }

  private async handleEvent(ev: DapEvent): Promise<Snapshot> {
    if (ev.event === "terminated") {
      this.ended = true;
      this.threadId = undefined;
      // O arquivo que o programa mandou ao navegador pode ainda estar chegando.
      await this.browser?.aguardarDownloads(20000);
      void this.browser?.close();
      this.dap.kill();
      return {
        estado: "encerrado",
        mensagens: this.takeLogs(),
        ...(this.errorCapture ? { erroDeExecucao: this.errorCapture } : {}),
        ...this.fecharAba(),
      };
    }
    this.threadId = ev.body?.threadId ?? 1;
    return this.snapshot(ev.body?.description || ev.body?.reason);
  }

  /**
   * Parada num ponto de rastro: avalia as expressões, registra e continua.
   * Devolve false quando a parada não é de rastro (o agente deve vê-la).
   */
  private async traceAndContinue(ev: DapEvent): Promise<boolean> {
    this.threadId = ev.body?.threadId ?? 1;
    const top = (await this.frames())[0];
    if (!top) return false;
    const spec = [...this.breakpoints.entries()]
      .filter(([file]) => path.basename(file).toLowerCase() === path.basename(top.source).toLowerCase())
      .flatMap(([, specs]) => specs)
      .find((b) => b.linha === top.line && b.rastro?.length);
    if (!spec) return false;
    const values: string[] = [];
    for (const expr of spec.rastro!) values.push(`${expr} = ${await this.evaluateRaw(expr, top.id)}`);
    this.traces.push({ nivel: "RASTRO", mensagem: `${path.basename(top.source)}(${top.line}) ${values.join("; ")}` });
    const threadId = this.threadId;
    this.threadId = undefined;
    await this.dap.request("continue", { threadId });
    return true;
  }

  private takeLogs() {
    const logs = [
      ...this.traces,
      ...this.dap.logsSince(this.logIndex).filter((l) => !/TDS-DA (being finalized|Finishing)/i.test(l.mensagem)),
    ];
    this.traces = [];
    this.logIndex = this.dap.events.length;
    return logs;
  }

  /** Estado parado: local, pilha, Local/Private/Static do topo, watches e o que mudou. */
  async snapshot(motivo?: string): Promise<Snapshot> {
    this.touch();
    if (this.threadId === undefined) {
      return this.encerrada
        ? { estado: "encerrado", mensagens: this.takeLogs(), ...this.fecharAba() }
        : { estado: "executando", mensagens: this.takeLogs() };
    }
    const frames = await this.frames();
    const top = frames[0];
    const variaveis: Record<string, Record<string, string>> = {};
    if (top) {
      for (const scope of await this.scopes(top.id)) {
        if (!["Local", "Private", "Static"].includes(scope.name)) continue;
        variaveis[scope.name] = await this.listVariables(scope.variablesReference);
      }
    }
    const watches: Record<string, string> = {};
    for (const w of this.watches) watches[w] = await this.evaluateRaw(w, top?.id);

    const current = new Map<string, string>();
    for (const [scope, vars] of Object.entries(variaveis)) {
      for (const [name, value] of Object.entries(vars)) current.set(`${top?.name}|${scope}|${name}`, value);
    }
    for (const [w, value] of Object.entries(watches)) current.set(`watch|${w}`, value);
    const alteradas = [...current.entries()]
      .filter(([k, v]) => this.previous.has(k) && this.previous.get(k) !== v)
      .map(([k, v]) => `${k.split("|").slice(1).join(" ")}: ${this.previous.get(k)} -> ${v}`);
    this.previous = current;

    return {
      estado: "parado",
      motivo,
      local: top ? { funcao: top.name, fonte: path.basename(top.source), linha: top.line } : undefined,
      pilha: frames.map((f) => ({ frame: f.index, funcao: f.name, fonte: path.basename(f.source), linha: f.line })),
      variaveis,
      ...(this.watches.length ? { watches } : {}),
      ...(alteradas.length ? { alteradas } : {}),
      mensagens: this.takeLogs(),
    };
  }

  private async frames() {
    const st = await this.dap.request("stackTrace", { threadId: this.threadId, startFrame: 0, levels: 50 });
    return ((st.body?.stackFrames ?? []) as any[]).map((f, index) => ({
      index,
      id: f.id as number,
      name: String(f.name),
      source: String(f.source?.path ?? f.source?.name ?? ""),
      line: Number(f.line),
    }));
  }

  private async scopes(frameId: number): Promise<{ name: string; variablesReference: number }[]> {
    const sc = await this.dap.request("scopes", { frameId });
    return sc.body?.scopes ?? [];
  }

  private async listVariables(ref: number): Promise<Record<string, string>> {
    const v = await this.dap.request("variables", { variablesReference: ref });
    const out: Record<string, string> = {};
    for (const item of (v.body?.variables ?? []) as any[]) out[item.name] = fmt(item);
    return out;
  }

  private requireStopped(): void {
    if (this.encerrada) throw new Error("A sessão de depuração já terminou.");
    if (this.threadId === undefined) {
      throw new Error("O programa não está parado. Use tds_debug_wait (ou inclua um breakpoint para interromper).");
    }
  }

  /**
   * Variáveis de um escopo num frame, opcionalmente descendo por um caminho de
   * nomes ("AITENS", "AITENS[3]", "SA1"). Frame 0 = topo da pilha.
   */
  async variables(frame: number, escopo: string, caminho: string[]) {
    this.touch();
    this.requireStopped();
    const frames = await this.frames();
    const f = frames[frame];
    if (!f) throw new Error(`Frame ${frame} não existe (pilha com ${frames.length}).`);
    const scopes = await this.scopes(f.id);
    const scope = scopes.find((s) => s.name.toLowerCase() === escopo.toLowerCase());
    if (!scope) throw new Error(`Escopo "${escopo}" não existe neste frame. Disponíveis: ${scopes.map((s) => s.name).join(", ")}`);
    let ref = scope.variablesReference;
    for (const name of caminho) {
      const v = await this.dap.request("variables", { variablesReference: ref });
      const hit = ((v.body?.variables ?? []) as any[]).find(
        (x) => String(x.name).toLowerCase() === name.toLowerCase() || String(x.evaluateName ?? "").toLowerCase() === name.toLowerCase()
      );
      if (!hit) throw new Error(`"${name}" não encontrado em ${[escopo, ...caminho].join(" > ")}.`);
      if (!(hit.variablesReference > 0)) return { frame, funcao: f.name, escopo: scope.name, caminho, valor: fmt(hit) };
      ref = hit.variablesReference;
    }
    return { frame, funcao: f.name, escopo: scope.name, caminho, itens: await this.listVariables(ref) };
  }

  private async evaluateRaw(expression: string, frameId?: number): Promise<string> {
    const r = await this.dap.request("evaluate", { expression, frameId, context: "watch" }, 15000);
    return r.success ? fmt(r.body ?? {}) : `ERRO ${r.message ?? ""}`.trim();
  }

  async evaluate(expression: string): Promise<string> {
    this.touch();
    this.requireStopped();
    const frames = await this.frames();
    return this.evaluateRaw(expression, frames[0]?.id);
  }

  async step(acao: "continuar" | "proxima" | "entrar" | "sair", timeoutSeg: number): Promise<Snapshot> {
    this.touch();
    this.requireStopped();
    const command = { continuar: "continue", proxima: "next", entrar: "stepIn", sair: "stepOut" }[acao];
    const threadId = this.threadId;
    this.threadId = undefined;
    const r = await this.dap.request(command, { threadId });
    if (!r.success) {
      this.threadId = threadId;
      throw new Error(`O depurador recusou "${acao}": ${r.message ?? "sem detalhe"}`);
    }
    return this.waitForStop(timeoutSeg);
  }

  /**
   * Encerra o adaptador (libera a thread no AppServer) e o navegador headless,
   * esperando os dois processos saírem: é na saída que o log do adaptador e o
   * perfil do navegador são apagados.
   */
  async stop(): Promise<void> {
    // O adaptador não responde ao terminate: o pedido vai com prazo curto, para
    // o encerramento caber nos ~2 s que o cliente MCP dá antes de matar o processo.
    if (this.dap.alive) await this.dap.request("terminate", {}, 300);
    this.ended = true;
    await Promise.all([this.dap.close(), this.browser?.close()]);
    // Pasta padrão sem nenhum download não fica para trás.
    const pasta = this.pastaDownloads;
    if (pasta && path.dirname(pasta) === path.join(os.tmpdir(), "tds-mcp", "downloads")) {
      try {
        fs.rmdirSync(pasta);
      } catch {
        /* tem arquivos ou já removida */
      }
    }
  }
}

/** Sequência do nome do log do adaptador dentro deste processo. */
let logSeq = 0;

/**
 * Remove sobras de processos que terminaram sem limpar, com mais de uma hora:
 * logs de adaptador e perfis do Chromium headless. O log de uma sessão viva
 * (deste ou de outro tds-mcp) está aberto pelo adaptador e o Windows recusa a
 * remoção. No perfil, o navegador vivo mantém o `lockfile` aberto: se ele não
 * puder ser removido, a pasta inteira fica.
 */
function removeStaleArtifacts(logDir: string): void {
  const limite = Date.now() - 3600_000;
  for (const name of fs.readdirSync(logDir)) {
    const alvo = path.join(logDir, name);
    try {
      if (fs.statSync(alvo).mtimeMs >= limite) continue;
      if (/^debugAdapter-[\d-]+\.log$/.test(name)) {
        fs.rmSync(alvo, { force: true });
      } else if (/^chromium-profile/.test(name)) {
        fs.rmSync(path.join(alvo, "lockfile"), { force: true });
        fs.rmSync(alvo, { recursive: true, force: true });
      }
    } catch {
      /* em uso ou já removido */
    }
  }
  // Downloads da pasta padrão ficam um dia, para o agente conferir o arquivo gerado.
  const downloads = path.join(logDir, "downloads");
  const limiteDownloads = Date.now() - 24 * 3600_000;
  for (const name of fs.existsSync(downloads) ? fs.readdirSync(downloads) : []) {
    const alvo = path.join(downloads, name);
    try {
      if (fs.statSync(alvo).mtimeMs < limiteDownloads) fs.rmSync(alvo, { recursive: true, force: true });
    } catch {
      /* em uso ou já removido */
    }
  }
}

/** Pasta padrão dos downloads de uma execução headless: %TEMP%\tds-mcp\downloads\<AAAAMMDD_HHMMSS>_<pid>. */
export function pastaDownloadsPadrao(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return path.join(os.tmpdir(), "tds-mcp", "downloads", `${stamp}_${process.pid}_${++logSeq}`);
}

/** Uma sessão por vez; encerra sozinha após inatividade e ao sair do processo. */
export class DebugManager {
  current?: DebugSession;
  private idleTimer?: NodeJS.Timeout;
  /** Vaga reservada por um start em andamento. */
  private starting?: { programa: string; servidor: string; desde: Date };

  /** Sessão retirada de `current` cujo encerramento ainda está em andamento. */
  private stopping?: DebugSession;
  /** Sessão em inicialização: o adaptador já existe, mas ainda não é `current`. */
  private launching?: DebugSession;
  /** Instrução de fechar a aba de uma sessão do modo navegador encerrada por inatividade. */
  private abaPendente?: string;

  constructor(private idleMinutes: number) {
    // Último recurso na saída do processo: só dá para mandar o kill.
    const cleanup = () => {
      for (const s of [this.current, this.stopping, this.launching]) {
        s?.dap.kill();
        s?.browser?.kill();
      }
    };
    process.on("exit", cleanup);
  }

  /** Instrução de fechar aba de sessão do modo navegador encerrada por inatividade (uma vez só). */
  takeAbaPendente(): string | undefined {
    const aba = this.abaPendente;
    this.abaPendente = undefined;
    return aba;
  }

  require(): DebugSession {
    if (!this.current) {
      const aba = this.takeAbaPendente();
      throw new Error(
        aba
          ? `A sessão de depuração encerrou por inatividade. ${aba}`
          : "Nenhuma sessão de depuração ativa. Use tds_debug_start."
      );
    }
    return this.current;
  }

  /**
   * Uma sessão por vez. A vaga é reservada antes de qualquer await: duas
   * chamadas simultâneas (tds_run, tds_debug_start) não podem ambas passar na
   * conferência e deixar um debugAdapter órfão.
   */
  async start(opts: StartOptions): Promise<{ session: DebugSession; breakpoints: Record<string, unknown> }> {
    const ocupada =
      this.starting ??
      (this.current && !this.current.encerrada
        ? { programa: this.current.programa, servidor: this.current.servidor, desde: this.current.iniciadaEm }
        : undefined);
    if (ocupada) {
      const hora = ocupada.desde.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      throw new Error(
        `Depurador ocupado: ${ocupada.programa} em ${ocupada.servidor} desde ${hora}. ` +
          `Encerre com tds_debug_stop ou aguarde a execução terminar.`
      );
    }
    this.starting = { programa: opts.descricao ?? opts.programa, servidor: opts.active.def.name, desde: new Date() };
    try {
      return await this.launchSession(opts);
    } finally {
      this.starting = undefined;
    }
  }

  private async launchSession(
    opts: StartOptions
  ): Promise<{ session: DebugSession; breakpoints: Record<string, unknown> }> {
    if (this.current) await this.stop();
    const logDir = path.join(os.tmpdir(), "tds-mcp");
    fs.mkdirSync(logDir, { recursive: true });
    removeStaleArtifacts(logDir);
    // Nome único entre processos: dois tds-mcp iniciando no mesmo milissegundo
    // não podem dividir o arquivo de onde a URL do webapp é lida.
    const logName = `debugAdapter-${process.pid}-${Date.now()}-${++logSeq}.log`;
    const dap = new DapClient(opts.adapterPath, path.join(logDir, logName));
    const session = new DebugSession(dap, opts);
    this.launching = session;
    try {
      return await this.connectSession(session, opts, logDir);
    } catch (err) {
      // Qualquer falha no meio da inicialização encerra o adaptador e o
      // navegador: conectados, segurariam a execução no AppServer.
      await session.stop();
      throw err;
    } finally {
      if (this.launching === session) this.launching = undefined;
    }
  }

  private async connectSession(
    session: DebugSession,
    opts: StartOptions,
    logDir: string
  ): Promise<{ session: DebugSession; breakpoints: Record<string, unknown> }> {
    const dap = session.dap;
    const init = await dap.request("initialize", {
      clientID: "tds-mcp",
      clientName: "tds-mcp",
      adapterID: "totvs_language_web_debug",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsRunInTerminalRequest: false,
      locale: "pt-br",
    });
    if (!init.success) {
      throw new Error(`O debugAdapter não inicializou: ${init.message ?? "sem detalhe"}`);
    }

    // "Navegador" do adaptador: processo que só fica vivo enquanto o adaptador
    // existir (se ele sair, o adaptador encerra a sessão). Ele herda o handle
    // do log do adaptador, então confere o pai a cada 250 ms para soltá-lo logo.
    const keepAlive =
      "const p=process.ppid;setInterval(()=>{try{process.kill(p,0)}catch{process.exit(0)}},250)";
    const launch = dap.request(
      "launch",
      {
        type: "totvs_language_web_debug",
        request: "launch",
        name: "tds-mcp",
        program: opts.programa,
        programArguments: opts.argumentos,
        cwb: opts.pastaFontes,
        workspaceFolders: [opts.pastaFontes],
        environment: opts.active.environment,
        environmentType: 1,
        token: opts.active.connectionToken,
        smartclientUrl: opts.webappUrl,
        webNavigator: process.execPath,
        webNavigatorArgs: ["-e", keepAlive],
        webAgent: "",
        webAgentArgs: [],
        enableMultiThread: opts.modo === "job",
        isMultiSession: true,
        enableTableSync: true,
        ignoreFiles: [],
      },
      120000
    );
    const initialized = await dap.waitFor(["initialized", "terminated"], 60000);
    if (!initialized || initialized.event !== "initialized") {
      const logs = dap.logsSince(0).map((l) => l.mensagem).join(" | ");
      throw new Error(`O debugAdapter não conectou no AppServer. ${logs}`.trim());
    }
    const breakpoints: Record<string, unknown> = {};
    for (const [file, specs] of Object.entries(opts.breakpoints)) {
      breakpoints[path.basename(file)] = await session.setBreakpoints(file, specs);
    }
    await dap.request("configurationDone");
    const launched = await launch;
    if (!launched.success) {
      throw new Error(`O debugAdapter recusou o launch: ${launched.message ?? "sem detalhe"}`);
    }
    session.url = await session.readWebappUrl();
    if (!session.url) {
      const logs = dap.logsSince(0).map((l) => l.mensagem).join(" | ");
      throw new Error(`O debugAdapter não informou a URL do webapp. ${logs}`.trim());
    }
    if (opts.modo !== "navegador") {
      session.browser = await HeadlessWebapp.open(opts.chromiumPath!, session.url, logDir, opts.pastaDownloads);
    }
    // tds_debug_stop (ou o encerramento do MCP) durante a inicialização mata o
    // adaptador sem erro aqui: a sessão não pode virar a ativa; o catch do
    // launchSession fecha o navegador recém-aberto.
    if (session.encerrada) throw new Error("A sessão de depuração foi encerrada durante a inicialização.");
    this.current = session;
    this.armIdleTimer();
    return { session, breakpoints };
  }

  /** Encerra a sessão ativa e a que estiver em inicialização. */
  async stop(): Promise<boolean> {
    const s = this.current;
    const launching = this.launching;
    this.current = undefined;
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (!s && !launching) return false;
    this.stopping = s;
    try {
      await Promise.all([s?.stop(), launching?.stop()]);
    } finally {
      if (this.stopping === s) this.stopping = undefined;
    }
    return true;
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      const s = this.current;
      if (!s) return;
      // No modo navegador o uso das telas pelo chrome-devtools não passa pelo
      // tds-mcp e não conta como atividade: o prazo é o triplo.
      const limite = this.idleMinutes * (s.modo === "navegador" ? 3 : 1) * 60000;
      if (Date.now() - s.lastActivity > limite) {
        this.abaPendente = s.fecharAba().fecharAba;
        void this.stop();
      }
    }, 30000);
    this.idleTimer.unref();
  }
}
