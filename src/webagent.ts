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
    try {
      this.proc.kill();
    } catch {
      /* já encerrado */
    }
  }
}

/** URL do webapp com a porta do agente. */
export function comAgente(url: string, porta: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}AGENT-PORT=${porta}`;
}
