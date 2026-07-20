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
 * o veredito exige returnCode === 0 E ausência de ERROR/FATAL.
 */
import type { CompileInfo, CompileResult } from "./advpls.js";

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
  /** Preenchido quando a operação passou, mas nenhum fonte foi efetivamente gravado. */
  aviso?: string;
  infos: CompileInfo[];
  erros: CompileInfo[];
  avisos: CompileInfo[];
  ignorados: CompileInfo[];
}

export function compileVerdict(result: CompileResult): CompileVerdict {
  const infos = result?.compileInfos ?? [];
  const erros = infos.filter((i) => i.status === "ERROR" || i.status === "FATAL");
  const avisos = infos.filter((i) => i.status === "WARN");
  // SKIPPED: o servidor ignorou o fonte (normalmente já está atualizado no RPO
  // e recompile=false). Não é erro, mas também NÃO houve gravação.
  const ignorados = infos.filter((i) => i.status === "SKIPPED");

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

  const sucesso = !buildFalhou && erros.length === 0;

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
    aviso,
    infos,
    erros,
    avisos,
    ignorados,
  };
}
