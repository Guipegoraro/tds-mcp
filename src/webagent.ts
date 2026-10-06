/**
 * TOTVS WebAgent para as execuções do webapp: o agente local que dá ao
 * SmartClient HTML o comportamento do SmartClient desktop (GetRemoteType() 1,
 * arquivos e impressão na máquina do usuário, visualização de PDF).
 *
 * Cada execução sobe uma instância própria numa porta livre (`-c --port`),
 * sem tocar no agente que o usuário tiver aberto, e o webapp a recebe pelo
 * parâmetro de URL AGENT-PORT. A versão do agente precisa ser a que o webapp
 * do servidor aceita (a TOTVS amarra versões de WebApp e WebAgent); o
 * tds-mcp não escolhe pela versão: confere no log da instância se o handshake
 * fechou e, se não fechou, a execução segue sem agente.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as tls from "node:tls";
import { isFile } from "./advpls.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** web-agent.exe: config webAgentPath (arquivo ou pasta) > TDS_MCP_WEBAGENT > instalação do usuário. */
export function resolveWebAgentPath(configured?: string): string | undefined {
  // Caminho escolhido explicitamente e ausente é erro, não motivo para usar outro agente.
  for (const [origem, escolhido] of [
    ["webAgentPath do config do tds-mcp", configured],
    ["TDS_MCP_WEBAGENT", process.env.TDS_MCP_WEBAGENT],
  ] as const) {
    if (!escolhido) continue;
    const exe = isFile(escolhido) ? escolhido : path.join(escolhido, "web-agent.exe");
    if (isFile(exe)) return exe;
    throw new Error(`${origem} não aponta para o web-agent.exe: ${escolhido}`);
  }
  const instalado = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "web-agent", "web-agent.exe");
  return process.env.LOCALAPPDATA && isFile(instalado) ? instalado : undefined;
}

function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const porta = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(porta));
    });
  });
}

/**
 * Como a instância fala: sem TLS (agentes 1.1.x, handshake próprio), TLS com
 * certificado confiável no Windows, ou TLS com certificado não confiável — o
 * navegador recusaria a conexão.
 */
async function protocolo(porta: number): Promise<"sem-tls" | "tls" | "tls-nao-confiavel" | "fechada"> {
  let ca: string[] | undefined;
  try {
    ca = (tls as unknown as { getCACertificates?: (t: string) => string[] }).getCACertificates?.("system");
  } catch {
    ca = undefined;
  }
  return new Promise((resolve) => {
    const s = tls.connect(
      { host: "127.0.0.1", port: porta, servername: "localhost", ...(ca ? { ca } : { rejectUnauthorized: false }) },
      () => {
        resolve(ca && !s.authorized ? "tls-nao-confiavel" : "tls");
        s.destroy();
      }
    );
    s.setTimeout(3000, () => {
      s.destroy();
      resolve("fechada");
    });
    s.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ECONNREFUSED") resolve("fechada");
      else if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(e.code ?? "")) resolve("tls-nao-confiavel");
      else resolve("sem-tls");
    });
  });
}

export class WebAgentInstance {
  private constructor(
    readonly exe: string,
    readonly porta: number,
    readonly pastaTemp: string,
    private readonly proc: ChildProcess
  ) {}

  /**
   * Sobe o agente numa porta livre, com TEMP próprio (é onde ele grava o
   * web-agent.log lido aqui), e espera a porta aceitar conexão. Devolve o
   * motivo quando a instância não serve.
   */
  static async start(
    exe: string,
    pastaTemp: string
  ): Promise<{ agente: WebAgentInstance } | { motivo: string }> {
    fs.mkdirSync(pastaTemp, { recursive: true });
    const porta = await portaLivre();
    const proc = spawn(exe, ["-c", "--port", String(porta)], {
      env: { ...process.env, TEMP: pastaTemp, TMP: pastaTemp },
      cwd: path.dirname(exe),
      stdio: "ignore",
      windowsHide: true,
    });
    let erroSpawn: Error | undefined;
    proc.on("error", (e) => (erroSpawn = e));
    const agente = new WebAgentInstance(exe, porta, pastaTemp, proc);
    let estado: Awaited<ReturnType<typeof protocolo>> = "fechada";
    for (let i = 0; i < 50 && estado === "fechada" && !erroSpawn && proc.exitCode === null; i++) {
      await sleep(200);
      estado = await protocolo(porta);
    }
    if (estado === "fechada") {
      agente.kill();
      return { motivo: `o WebAgent não abriu a porta ${porta}${erroSpawn ? `: ${erroSpawn.message}` : ""}` };
    }
    if (estado === "tls-nao-confiavel") {
      agente.kill();
      const ca = path.join(path.dirname(exe), "totvs_certificate_CA.crt");
      return {
        motivo:
          "o certificado do WebAgent não é confiável neste Windows, e o navegador recusaria a conexão. Para " +
          `confiar (uma vez, por usuário; altera os certificados confiáveis do Windows, rode só com autorização ` +
          `do usuário): Import-Certificate -FilePath "${ca}" -CertStoreLocation Cert:\\CurrentUser\\Root`,
      };
    }
    vivos.add(agente);
    return { agente };
  }

  private log(): string {
    try {
      return fs.readFileSync(path.join(this.pastaTemp, "web-agent.log"), "utf8");
    } catch {
      return "";
    }
  }

  /** O webapp conectou e o handshake com o agente fechou. */
  get conectado(): boolean {
    return /Handshake success/i.test(this.log());
  }

  /** O webapp recusou esta versão do agente (handshake desfeito com stop-broker). */
  get recusado(): boolean {
    const log = this.log();
    return /stop-broker/i.test(log) && !/Handshake success/i.test(log);
  }

  /** Espera o handshake (ou a recusa) até `ms`. */
  async aguardarConexao(ms: number): Promise<"conectado" | "recusado" | "sem-conexao"> {
    const fim = Date.now() + ms;
    while (Date.now() < fim) {
      if (this.conectado) return "conectado";
      if (this.recusado) return "recusado";
      await sleep(250);
    }
    return this.conectado ? "conectado" : this.recusado ? "recusado" : "sem-conexao";
  }

  kill(): void {
    vivos.delete(this);
    try {
      this.proc.kill();
    } catch {
      /* já encerrado */
    }
  }

  /** Encerra o agente e apaga a pasta temporária dele. */
  encerrar(): void {
    this.kill();
    try {
      fs.rmSync(this.pastaTemp, { recursive: true, force: true });
    } catch {
      /* visualizador de PDF aberto pelo agente ainda usa a pasta; a varredura remove depois */
    }
  }

  /**
   * Encerra o agente quando a página do webapp se desligar dele. Agente que
   * morre com a página ainda ligada faz o webapp reconectar e, sem resposta,
   * abrir outro agente pelo protocolo web-agent: do Windows, que ninguém
   * encerra. A página se desliga ao sair do programa (fim, erro, thread
   * encerrada pelo depurador) ou ao fechar, e o log registra stop-broker por
   * último; agente sem nenhuma página conectada encerra logo. `maxMs` limita
   * a espera.
   */
  encerrarAoSairDaPagina(maxMs: number): void {
    if (!/Handshake success/i.test(this.log())) return this.encerrar();
    const fim = Date.now() + maxMs;
    let anterior = "";
    let paradoDesde = Date.now();
    const timer = setInterval(() => {
      const log = this.log();
      if (log !== anterior) {
        anterior = log;
        paradoDesde = Date.now();
      }
      // Última linha "... SND Action (stop-broker)": a página se desligou do agente.
      const saiu = /stop-broker\)?\s*$/i.test(log) && Date.now() - paradoDesde >= 3000;
      if (saiu || this.proc.exitCode !== null || Date.now() >= fim) {
        clearInterval(timer);
        this.encerrar();
      }
    }, 1000);
    timer.unref();
  }
}

/** Instâncias que este processo subiu e ainda não encerrou. */
const vivos = new Set<WebAgentInstance>();
// Último recurso na saída do tds-mcp: agente esperando a aba fechar também cai.
process.on("exit", () => {
  for (const a of vivos) a.kill();
});

/** URL do webapp com a porta do agente. */
export function comAgente(url: string, porta: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}AGENT-PORT=${porta}`;
}

/**
 * Script para rodar antes do webapp carregar: grava no localStorage a porta
 * do AGENT-PORT da URL. Ao abrir a conexão, o webapp informa ao AppServer a
 * porta do agente lida do localStorage, antes de o agente conectar; num
 * perfil novo (contexto isolado, Chromium headless) ela ainda não existe e o
 * AppServer trata a sessão como sem agente: ExecInClient (porta serial e
 * demais funções EIC_*) volta vazio, embora o agente esteja conectado.
 * URL sem AGENT-PORT não mexe no localStorage.
 */
export const SCRIPT_PORTA_AGENTE =
  "(()=>{try{for(const [k,v] of new URLSearchParams(location.search))" +
  "if(k.toUpperCase()==='AGENT-PORT'&&Number(v)>0)localStorage.setItem('desktopagentport',v)}catch(e){}})()";
