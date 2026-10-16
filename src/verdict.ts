/**
 * Veredito de compilação: decide sucesso/falha a partir da resposta do
 * $totvsserver/compilation.
 *
 * REGRA CRÍTICA: falha pode vir em DOIS níveis independentes.
 *
 *  1. Nível de BUILD (`returnCode !== 0`) — acontece ANTES/FORA da compilação
 *     individual dos fontes. Nesse caso `compileInfos` pode vir VAZIO ou sem
 *     nenhum status ERROR/FATAL. Ex.: COMPILEERROR-300 (falha ao obter acesso
 *     exclusivo ao RPO) e 40840 (token de autorização expirado).
 *  2. Nível de FONTE (`compileInfos[].status`) — erro de sintaxe etc.
 *
 * Olhar apenas (2) faz uma falha de build ser reportada como sucesso. Por isso
 * o veredito exige returnCode === 0, todo fonte com status conhecido de
 * sucesso e um resultado para cada fonte enviado. Resposta que não comprova
 * a compilação (vazia, nula, status desconhecido, fonte sem resultado) não é
 * sucesso.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { CompileInfo, CompileResult } from "./advpls.js";

/** Status por fonte que contam como compilação concluída. */
const OK_STATUS = new Set(["SUCCESS", "WARN", "SKIPPED", "APPRE"]);
/** Status de erro reportados pelo compilador. */
const ERROR_STATUS = new Set(["ERROR", "FATAL"]);

/** Códigos de retorno conhecidos do build, com orientação acionável. */
export const RETURN_CODE_HINTS: Record<number, string> = {
  [-300]:
    "COMPILEERROR-300: falha ao obter acesso exclusivo do RPO. Nenhum fonte foi gravado " +
    "(build revertido). Verifique se há usuários/serviços conectados ao ambiente e se a " +
    "chave BuildKillUsers=1 está definida na seção [General] do appserver.ini.",
  40840:
    "Token de autorização de compilação expirado. Renove o token/chave de compilação " +
    "(no TDS: RPO token / compile key) e tente novamente.",
  // A TOTVS não documenta o 40910; o texto resume as mensagens que vieram com ele no
  // log do servidor: "SYMTAB in use for StartBuild", "Error when loading Rpo DEFAULT",
  // "Already building" e COMPILEERROR-300 "Failed to open repository".
  40910:
    "returnCode 40910: o servidor não começou o build porque o RPO estava em uso (outra " +
    "compilação ou aplicação de patch em andamento, ou o RPO preso por outro processo). Nas " +
    "ocorrências vistas nada foi gravado; para ter certeza, confira com tds_rpo_objects. A " +
    "mensagem do servidor está no tds_server_log. Repita uma vez depois de alguns " +
    "segundos; se voltar, não insista: num AppServer compartilhado avise o usuário (alguém " +
    "compila ou o RPO está preso; BuildKillUsers=1 e um AppServer por RPO evitam), e num " +
    "AppServer local reiniciá-lo solta o RPO.",
  40820:
    "returnCode 40820: a conexão com o servidor caiu e o build não começou; nada foi gravado no " +
    "RPO. Refaça a conexão com tds_use_server e compile de novo; se voltar, o servidor ou a VPN " +
    "está instável.",
  99999:
    "returnCode 99999: o servidor recusou o build. Causa comum: falta de privilégio de " +
    "compilação para o usuário no ambiente (\"Insufficient privileges for COMPILE\" no " +
    "logDoServidor): confira com tds_server_permissions e peça a liberação ao administrador.",
};

/** Mensagem do servidor quando o build nem começa porque o RPO está ocupado. */
const BUILD_NAO_INICIADO = /Build not started/i;

export interface CompileVerdict {
  sucesso: boolean;
  returnCode: number;
  /** Preenchido quando a falha é de build (returnCode != 0). */
  falhaDeBuild?: string;
  /** Preenchido quando a resposta não comprova a compilação (vazia, status desconhecido, fonte sem resultado). */
  inconclusivo?: string;
  /** Preenchido quando a operação passou, mas nenhum fonte foi efetivamente gravado. */
  aviso?: string;
  /** Causa provável deduzida da mensagem de erro (chave de compilação, includes...). */
  causaProvavel?: string;
  infos: CompileInfo[];
  erros: CompileInfo[];
  avisos: CompileInfo[];
  ignorados: CompileInfo[];
  /** Fontes enviados sem resultado na resposta do servidor. */
  semResultado: string[];
}

/** Nome do arquivo em minúsculas, aceitando caminho ou URI file://. */
function fileKey(p: string): string {
  let s = String(p ?? "");
  if (/^file:/i.test(s)) {
    try {
      s = decodeURIComponent(s.replace(/^file:\/*/i, ""));
    } catch {
      /* caminho com % literal: usa como veio */
    }
  }
  return path.basename(s.replace(/\\/g, "/")).toLowerCase();
}

/**
 * @param enviados Fontes enviados ao servidor. Quando informado, cada um
 *   precisa ter um resultado na resposta.
 * @param log Mensagens do servidor durante a compilação (logDoServidor).
 */
export function compileVerdict(
  result: CompileResult | null | undefined,
  enviados: string[] = [],
  log: string[] = []
): CompileVerdict {
  const infos = Array.isArray(result?.compileInfos) ? result!.compileInfos : [];
  const status = (i: CompileInfo) => String(i.status ?? "").toUpperCase();
  const erros = infos.filter((i) => ERROR_STATUS.has(status(i)));
  // Status fora das listas conhecidas não é erro de compilação, mas também não
  // comprova que o fonte foi gravado: torna o resultado inconclusivo.
  const desconhecidos = infos.filter((i) => !ERROR_STATUS.has(status(i)) && !OK_STATUS.has(status(i)));
  const avisos = infos.filter((i) => status(i) === "WARN");
  // SKIPPED: o servidor ignorou o fonte (normalmente já está atualizado no RPO
  // e recompile=false). Não é erro, mas também NÃO houve gravação.
  const ignorados = infos.filter((i) => status(i) === "SKIPPED");
  const recebidos = new Set(infos.map((i) => fileKey(i.filePath)));
  const semResultado = enviados.filter((f) => !recebidos.has(fileKey(f)));

  // returnCode ausente na resposta é tratado como 0 (sucesso) para não quebrar
  // servidores/builds que omitem o campo; a checagem de ERROR/FATAL continua valendo.
  const returnCode = typeof result?.returnCode === "number" ? result.returnCode : 0;
  const buildFalhou = returnCode !== 0;

  let falhaDeBuild: string | undefined;
  // "Build not started" vem com returnCode próprio e marca todo fonte como
  // FATAL, mas é o mesmo RPO ocupado do 40910: os FATAL não são erro do fonte.
  const naoIniciado = buildFalhou && log.some((l) => BUILD_NAO_INICIADO.test(l));
  if (naoIniciado) {
    falhaDeBuild =
      `"Build not started" (returnCode ${returnCode}): ${RETURN_CODE_HINTS[40910].replace(/^returnCode 40910: /, "")} ` +
      "Os fontes marcados como FATAL nesta resposta são consequência do build não iniciado, não erro do fonte.";
  } else if (buildFalhou) {
    falhaDeBuild =
      RETURN_CODE_HINTS[returnCode] ??
      `A compilação falhou no servidor (returnCode ${returnCode}). O build foi abortado; ` +
        `provavelmente nada foi gravado no RPO. Consulte tds_server_log para o detalhe.`;
    if (erros.length === 0) {
      falhaDeBuild +=
        " Atenção: o servidor não reportou erro por fonte — a falha é de build, " +
        "não de sintaxe. Não interprete a ausência de erros por fonte como sucesso.";
    }
  }

  // Causas conhecidas que o servidor reporta apenas na mensagem do fonte.
  const causaProvavel = naoIniciado ? undefined : diagnoseKnownCauses(erros);

  // Resposta sem nenhum resultado por fonte não comprova compilação.
  let inconclusivo: string | undefined;
  if (!buildFalhou && infos.length === 0) {
    inconclusivo =
      "O servidor não devolveu resultado por fonte (resposta vazia). Não dá para afirmar que " +
      "algo foi gravado no RPO; confira com tds_rpo_objects ou compile de novo.";
  } else if (!buildFalhou && semResultado.length > 0) {
    inconclusivo =
      `O servidor não devolveu resultado para ${semResultado.length} fonte(s) enviado(s): ` +
      `${semResultado.map((f) => path.basename(f)).join(", ")}. Não dá para afirmar que foram gravados.`;
  }
  if (!buildFalhou && desconhecidos.length > 0) {
    const msg =
      `Status não reconhecido na resposta (${[...new Set(desconhecidos.map(status))].join(", ")}): ` +
      `tratado como falha, pois não comprova a gravação no RPO.`;
    inconclusivo = inconclusivo ? `${inconclusivo} ${msg}` : msg;
  }
  const sucesso = !buildFalhou && erros.length === 0 && !inconclusivo;

  // Sucesso em que TUDO foi ignorado: nada foi gravado no RPO. Reportar como
  // "compilado" sem ressalva seria enganoso.
  let aviso: string | undefined;
  if (sucesso && infos.length > 0 && ignorados.length === infos.length) {
    aviso =
      `Nenhum fonte foi gravado: os ${ignorados.length} fonte(s) foram ignorados (SKIPPED) ` +
      `pelo servidor, normalmente porque o RPO já está atualizado. Use recompile=true para forçar.`;
  }

  return {
    sucesso,
    returnCode,
    falhaDeBuild,
    inconclusivo,
    aviso,
    causaProvavel,
    infos,
    erros,
    avisos,
    ignorados,
    semResultado,
  };
}

/**
 * Traduz mensagens de erro conhecidas em causa + ação. Baseado no
 * troubleshooting da documentação oficial do tds-vscode.
 */
function diagnoseKnownCauses(erros: CompileInfo[]): string | undefined {
  if (erros.length === 0) return undefined;
  const texto = erros.map((e) => `${e.message} ${e.detail}`).join(" ").toLowerCase();

  const declaracao = c2003NaDeclaracao(erros);
  if (declaracao) {
    return (
      `C2003 na linha da declaração (${declaracao}): costuma ser um parâmetro ou variável com nome que ` +
      "um #define do protheus.ch/totvs.ch traduz (ex.: cFilial vira xFilial(Alias())), e o erro aparece " +
      "na linha da Function. Rode tds_generate_ppo no fonte, veja a linha expandida e renomeie o identificador."
    );
  }

  if (/authoriz|licen[çc]|compile key|chave de compila|\.aut\b/.test(texto)) {
    return (
      "Possível falta de chave de compilação: fontes com `Function` / `Main Function` " +
      "(em vez de `User Function`) exigem autorização `.aut` ou token de RPO. " +
      "Aplique a chave no TDS (Compile Key / RPO token) ou converta para `User Function`."
    );
  }
  if (/include|#include|não encontrado.*\.ch|undefined.*define/.test(texto)) {
    return (
      "Possível problema de includes: confira as pastas de include do servidor no " +
      "servers.json (campo `includes`) — devem apontar para os `.ch`/`.th` da build correta."
    );
  }
  if (/invalid character|caracter|mojibake|�/.test(texto)) {
    return (
      "Possível problema de encoding: o fonte deve estar em CP1252. " +
      "Converta e recompile."
    );
  }
  return undefined;
}

/**
 * Linha do detalhe do compilador: "FONTE.PRW(12) warning W0008 Too few parameters calling valtype",
 * ou sem o tipo quando o fonte aborta ("FONTE.PRW(14)   C2003 Syntax Error").
 */
const LINHA_DETALHE = /^(.+?)\((\d+)\)\s+(?:(warning|error|fatal)\s+)?([A-Z]\d{4})\s+(.*)$/i;
/** Declaração de função que o compilador aponta quando o C2003 vem de um #define. */
const DECLARACAO = /^\s*(?:(?:static|user|main)\s+)?function\s+(\w+)/i;

/**
 * Função cuja linha de declaração recebeu um C2003, lendo a linha no fonte local.
 * Sem o arquivo ou com a linha fora dele, não diagnostica.
 */
function c2003NaDeclaracao(erros: CompileInfo[]): string | undefined {
  for (const e of erros) {
    for (const linha of String(e.detail ?? "").split(/\r?\n/)) {
      const m = LINHA_DETALHE.exec(linha.trim());
      if (!m || m[4].toUpperCase() !== "C2003") continue;
      // C2003 apontado num include: a linha não é do fonte.
      if (path.basename(m[1]).toLowerCase() !== path.basename(arquivoLocal(e.filePath)).toLowerCase()) continue;
      let fonte: string[];
      try {
        fonte = fs.readFileSync(arquivoLocal(e.filePath), "latin1").split(/\r?\n/);
      } catch {
        continue;
      }
      const decl = DECLARACAO.exec(fonte[Number(m[2]) - 1] ?? "");
      if (decl) return `${decl[1]}, linha ${m[2]}`;
    }
  }
  return undefined;
}

/** Caminho local de um filePath do compilador, que pode vir como URI file://. */
function arquivoLocal(p: string): string {
  const s = String(p ?? "");
  if (!/^file:/i.test(s)) return s;
  try {
    return decodeURIComponent(s.replace(/^file:\/*/i, ""));
  } catch {
    return s.replace(/^file:\/*/i, "");
  }
}

/** Avisos distintos mostrados por fonte; os erros aparecem sempre. */
export const AVISOS_DISTINTOS_POR_FONTE = 10;

/**
 * Agrupa as linhas iguais do detalhe do compilador ("W0008 ... — linhas 7, 8, 9").
 * Erros saem todos; avisos, até `limite` mensagens distintas, e o resto vira uma
 * contagem. Linha fora do formato do compilador sai como veio.
 */
export function resumirDetalhe(detail: string, limite = AVISOS_DISTINTOS_POR_FONTE, fonte?: string): string {
  const principal = fonte ? path.basename(fonte).toLowerCase() : undefined;
  const grupos = new Map<string, { erro: boolean; linhas: number[] }>();
  const outras: string[] = [];
  for (const bruta of String(detail ?? "").split(/\r?\n/)) {
    const linha = bruta.trim();
    if (!linha) continue;
    const m = LINHA_DETALHE.exec(linha);
    if (!m) {
      outras.push(linha);
      continue;
    }
    const tipo = (m[3] ?? "error").toLowerCase();
    // Mensagem de outro arquivo (include) leva o nome dele: as linhas são de lá.
    const outro = principal && path.basename(m[1]).toLowerCase() !== principal ? `${m[1]}: ` : "";
    const chave = `${outro}${tipo} ${m[4]} ${m[5]}`;
    const g = grupos.get(chave) ?? { erro: tipo !== "warning", linhas: [] };
    g.linhas.push(Number(m[2]));
    grupos.set(chave, g);
  }
  const fmt = (chave: string, linhas: number[]) => {
    const lista = linhas.length > 20 ? `${linhas.slice(0, 20).join(", ")}…` : linhas.join(", ");
    return `${chave} (${linhas.length === 1 ? "linha" : `${linhas.length}x, linhas`} ${lista})`;
  };
  const erros = [...grupos].filter(([, g]) => g.erro).map(([k, g]) => fmt(k, g.linhas));
  const avisos = [...grupos].filter(([, g]) => !g.erro);
  const mostrados = avisos.slice(0, limite).map(([k, g]) => fmt(k, g.linhas));
  const resto = avisos.length - mostrados.length;
  const ocorrenciasResto = avisos.slice(limite).reduce((n, [, g]) => n + g.linhas.length, 0);
  return [
    ...outras,
    ...erros,
    ...mostrados,
    ...(resto > 0 ? [`+${resto} avisos distintos (${ocorrenciasResto} ocorrências) não mostrados`] : []),
  ].join("\n");
}
