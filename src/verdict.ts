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
};

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
 */
export function compileVerdict(result: CompileResult | null | undefined, enviados: string[] = []): CompileVerdict {
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
  if (buildFalhou) {
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
  const causaProvavel = diagnoseKnownCauses(erros);

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
