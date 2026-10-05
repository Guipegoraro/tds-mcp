#!/usr/bin/env node
/**
 * tds-mcp — Servidor MCP para compilação AdvPL/TLPP e patches Protheus.
 *
 * Motor: advpls (TDS Language Server) via JSON-RPC stdio, mesmo protocolo da
 * extensão tds-vscode ($totvsserver/*). Reaproveita a configuração do TDS
 * (~/.totvsls/servers.json): servidores, ambientes, includes e token.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { URI } from "vscode-uri";

import {
  AdvplsClient,
  resolveAdvplsPath,
  advplsBinaryInfo,
  type AdvplsBinaryInfo,
  type CompileOptions,
  type MonitorUser,
} from "./advpls.js";
import { compileVerdict, RETURN_CODE_HINTS } from "./verdict.js";
import { resolveDebugAdapterPath } from "./dap.js";
import { resolveChromiumPath } from "./webapp.js";
import { lintFiles } from "./linter.js";
import { DebugManager, type BreakpointSpec, type DebugMode } from "./debug.js";
import { breakpointLineWarnings } from "./breakpointLines.js";
import { programaInicial } from "./modulos.js";
import { checkFiles, encodingErrorMessage, type EncodingCheck } from "./encoding.js";
import { loadConfig, configFilePath, configWarnings } from "./config.js";
import {
  SessionManager,
  readServersJson,
  serversJsonPath,
  effectiveIncludes,
  authorizationToken,
} from "./session.js";
import {
  nowStamp,
  patchBaseName,
  recommendedTitle,
  recommendedDescription,
  sha256File,
  gitInfo,
  currentAuthor,
  ensurePatchDir,
  writeManifest,
  appendHistory,
  type PatchManifest,
  type PatchSourceEntry,
} from "./trace.js";

/**
 * Extensões aceitas, espelhando o default de
 * `totvsLanguageServer.folder.extensionsAllowed` da extensão tds-vscode.
 */
const ADVPL_SOURCE_EXT = [
  ".prw", ".prx", ".prg", ".ppx", ".ppp", ".tlpp",
  ".apw", ".aph", ".apl", ".ahu", ".4gl", ".per",
];
/** Recursos: vão para o RPO junto dos fontes (traduções, imagens, layouts). */
const ADVPL_RESOURCE_EXT = [".tres", ".png", ".bmp", ".res", ".js", ".rptdesign"];

const config = loadConfig();
let client: AdvplsClient | undefined;
let session: SessionManager | undefined;
/** Binário do advpls em execução (o resolvido na última inicialização). */
let advplsPath: string | undefined;

/** Inicialização em andamento: chamadas simultâneas aguardam o mesmo advpls. */
let starting: Promise<{ client: AdvplsClient; session: SessionManager }> | undefined;

/** Inicializa o advpls sob demanda (primeira tool que precisar). */
async function ensureClient(): Promise<{ client: AdvplsClient; session: SessionManager }> {
  if (client && client.alive && session) return { client, session };
  starting ??= (async () => {
    advplsPath = resolveAdvplsPath(config.advplsPath);
    const c = await AdvplsClient.start(advplsPath);
    client = c;
    session = new SessionManager(c, config);
    return { client: c, session };
  })().finally(() => {
    starting = undefined;
  });
  return starting;
}

/** Binário em uso, ou o que seria usado se o advpls ainda não subiu. */
function advplsDiagnostic(): (AdvplsBinaryInfo & { emExecucao: boolean }) | { erro: string } {
  try {
    return { ...advplsBinaryInfo(advplsPath ?? resolveAdvplsPath(config.advplsPath)), emExecucao: !!client?.alive };
  } catch (err) {
    return { erro: err instanceof Error ? err.message : String(err) };
  }
}

/** URI de arquivo com caminho absoluto: relativo é resolvido pela pasta atual do MCP. */
function toFileUri(p: string): string {
  return URI.file(path.resolve(p)).toString();
}

function isAdvplSource(file: string): boolean {
  return ADVPL_SOURCE_EXT.includes(path.extname(file).toLowerCase());
}

function isAdvplResource(file: string): boolean {
  return ADVPL_RESOURCE_EXT.includes(path.extname(file).toLowerCase());
}

/**
 * Expande caminhos para absolutos: arquivos informados diretamente + varredura
 * recursiva de pastas. Na varredura entram fontes e recursos.
 */
function expandFiles(inputs: string[]): string[] {
  const result: string[] = [];
  for (const input of inputs) {
    const stat = fs.statSync(input, { throwIfNoEntry: false });
    if (!stat) throw new Error(`Arquivo/pasta não encontrado: ${input}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(input, { recursive: true, encoding: "utf-8" })) {
        // Pastas ocultas não são fonte (.vscode/.advpl guarda cache gerado pelo
        // TDS), e node_modules de frontend traria .js de bibliotecas como recurso.
        const parts = entry.split(/[\\/]/);
        if (parts.some((part) => part.startsWith(".") || part.toLowerCase() === "node_modules")) continue;
        const full = path.resolve(input, entry);
        if (!fs.statSync(full).isFile()) continue;
        if (isAdvplSource(full) || isAdvplResource(full)) result.push(full);
      }
    } else {
      result.push(path.resolve(input));
    }
  }
  return result;
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** Resultado estruturado marcado como erro — para falhas que NÃO podem passar por sucesso. */
function jsonFailure(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    isError: true,
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ erro: message }, null, 2) }],
    isError: true,
  };
}

/** Executa handler com captura de erro amigável. */
function safe<A extends unknown[]>(fn: (...args: A) => Promise<{ content: { type: "text"; text: string }[] }>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
}

function defaultCompileOptions(): CompileOptions {
  return {
    recompile: false,
    debugAphInfo: true,
    gradualSending: true,
    generatePpoFile: false,
    showPreCompiler: false,
    priorVelocity: true,
    returnPpo: false,
    commitWithErrorOrWarning: false,
    syntaxOnly: false,
  };
}

const ACEITAR_MISTO_SCHEMA = z
  .boolean()
  .optional()
  .default(false)
  .describe(
    "Libera fonte CP1252 com linhas que parecem UTF-8 (`misto`). Use só depois de mostrar as linhas " +
      "apontadas ao usuário e ele confirmar que a sequência é intencional (ex.: tabela de conversão de UTF-8)."
  );

/** Fontes "misto" liberados por aceitarMisto, com as linhas, para o retorno da tool. */
function mistoAceitoResumo(checagem: EncodingCheck[]): { arquivo: string; linhas: number[] }[] {
  return checagem
    .filter((c) => c.kind === "misto" && c.safe)
    .map((c) => ({ arquivo: c.file, linhas: c.linhasUtf8 ?? [] }));
}

/** Monta o request de compilação com sessão/includes/autorização atuais. */
async function runCompilation(files: string[], options: CompileOptions, aceitarMisto = false) {
  const { client, session } = await ensureClient();
  const active = session.required();
  const cfg = readServersJson();
  const includes = effectiveIncludes(cfg, active.def);
  if (includes.length === 0) {
    throw new Error("Nenhuma pasta de includes configurada (servers.json).");
  }

  const expanded = expandFiles(files);
  if (expanded.length === 0) throw new Error("Nenhum fonte a compilar.");

  // O compilador Protheus só aceita CP1252. Bloqueia ANTES de enviar para não
  // gravar fonte corrompido no RPO (ver src/encoding.ts).
  const checagem = checkFiles(expanded, aceitarMisto);
  const problemas = checagem.filter((c) => !c.safe);
  if (problemas.length > 0) throw new Error(encodingErrorMessage(problemas));
  const mistoAceito = mistoAceitoResumo(checagem);

  // Marca o ponto do log: o advpls reporta falhas de build (ex.: a dica de
  // BuildKillUsers no COMPILEERROR-300) por notificação, não na resposta.
  const logMark = client.logCount;

  const result = await client.compile({
    connectionToken: active.connectionToken,
    authorizationToken: authorizationToken(cfg),
    environment: active.environment,
    includeUris: includes.map(toFileUri),
    fileUris: expanded.map(toFileUri),
    options,
    includeUrisRequired: expanded.some(isAdvplSource),
  });

  // O veredito considera returnCode (falha de build) E status por fonte.
  // Ver src/verdict.ts — falha de build pode vir com compileInfos vazio.
  const verdict = compileVerdict(result, expanded.filter(isAdvplSource));
  const logDaOperacao = client.logSince(logMark);
  return { active, expanded, result, verdict, logDaOperacao, mistoAceito };
}

// ---------------------------------------------------------------------------
// Servidor MCP
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "tds-mcp", version: "0.1.0" });

server.registerTool(
  "tds_list_servers",
  {
    title: "Listar servidores Protheus",
    description:
      "Lista os servidores Protheus do servers.json do TDS (~/.totvsls), com ambientes, " +
      "includes e qual está conectado nesta sessão do MCP.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  safe(async () => {
    const cfg = readServersJson();
    const active = session?.current;
    return jsonResult({
      arquivoConfig: serversJsonPath(),
      advpls: advplsDiagnostic(),
      sessaoAtiva: active
        ? {
            servidor: active.def.name,
            ambiente: active.environment,
            usuario: active.user,
            autenticacao: active.authMethod,
          }
        : null,
      conectadoNoVSCode: cfg.connectedServer
        ? { servidor: cfg.connectedServer.name, ambiente: cfg.connectedServer.environment }
        : null,
      servidores: cfg.configurations.map((s) => ({
        nome: s.name,
        endereco: `${s.address}:${s.port}`,
        seguro: s.secure,
        build: s.buildVersion,
        ambientes: s.environments ?? [],
        ambientePadrao: s.environment,
        usuario: s.username,
      })),
    });
  })
);

server.registerTool(
  "tds_use_server",
  {
    title: "Conectar em servidor Protheus",
    description:
      "Conecta e autentica em um servidor/ambiente do servers.json para as demais tools. " +
      "Com usuario e senha informados, autentica com eles (valem só para esta sessão do MCP; " +
      "não são gravados). Sem eles, tenta o token de reconexão salvo pelo TDS e, se falhar, as " +
      "credenciais de ~/.tds-mcp/config.json.",
    inputSchema: {
      servidor: z.string().describe("Nome (ou parte do nome) do servidor no servers.json"),
      ambiente: z.string().optional().describe("Ambiente; padrão: o último usado no TDS"),
      usuario: z.string().optional().describe("Usuário do Protheus (informe junto com senha)"),
      senha: z.string().optional().describe("Senha do usuário; não é gravada nem devolvida"),
    },
  },
  safe(async ({ servidor, ambiente, usuario, senha }) => {
    const { session } = await ensureClient();
    if ((usuario === undefined) !== (senha === undefined)) {
      throw new Error("Informe usuario e senha juntos, ou nenhum dos dois.");
    }
    const explicit = usuario !== undefined ? { user: usuario, password: senha! } : undefined;
    const active = await session.useServer(servidor, ambiente, explicit);
    return jsonResult({
      conectado: true,
      servidor: active.def.name,
      endereco: `${active.def.address}:${active.def.port}`,
      ambiente: active.environment,
      usuario: active.user,
      autenticacao: active.authMethod,
    });
  })
);

server.registerTool(
  "tds_compile",
  {
    title: "Compilar fontes AdvPL/TLPP",
    description:
      "Compila fontes ou pastas no RPO do servidor conectado. Use recompile=true para forçar " +
      "recompilação. COMO LER O RESULTADO: confie SEMPRE no campo booleano `sucesso` — ele já " +
      "combina as duas formas de falha. (a) falha de BUILD: `returnCode` != 0, com `falhaDeBuild` " +
      "explicando; nesse caso o build é revertido e NADA é gravado no RPO, mesmo que a lista " +
      "`resultados` venha vazia ou só com SUCCESS (ex.: COMPILEERROR-300 = sem acesso exclusivo ao " +
      "RPO). (b) falha de FONTE: itens com status ERROR/FATAL em `resultados`. (c) resposta " +
      "INCONCLUSIVA: vazia, status desconhecido ou fonte sem resultado, explicada em " +
      "`inconclusivo`; não afirme que compilou. Nunca conclua " +
      "sucesso apenas por não haver erros em `resultados`. Em falha, `logDoServidor` traz as " +
      "mensagens do AppServer. ATENÇÃO ao status SKIPPED: o fonte foi ignorado por já estar " +
      "atualizado no RPO — é sucesso, mas NADA foi gravado; confira `ignorados` e o campo " +
      "`aviso` antes de afirmar que compilou. Fontes precisam estar em CP1252: arquivos em " +
      "UTF-8 são recusados antes do envio (o compilador Protheus gravaria caracteres " +
      "corrompidos no RPO). Aceita fontes e recursos (.tres, .png, imagens, layouts).",
    inputSchema: {
      arquivos: z.array(z.string()).min(1).describe("Caminhos de fontes ou pastas"),
      recompile: z.boolean().optional().default(false).describe("Forçar recompilação"),
      aceitarMisto: ACEITAR_MISTO_SCHEMA,
    },
  },
  safe(async ({ arquivos, recompile, aceitarMisto }) => {
    const options = defaultCompileOptions();
    options.recompile = recompile ?? false;
    const { active, expanded, verdict, logDaOperacao, mistoAceito } = await runCompilation(
      arquivos,
      options,
      aceitarMisto ?? false
    );
    const payload = {
      servidor: active.def.name,
      ambiente: active.environment,
      ...(mistoAceito.length ? { encodingMistoAceito: mistoAceito } : {}),
      totalFontes: expanded.length,
      sucesso: verdict.sucesso,
      returnCode: verdict.returnCode,
      ...(verdict.falhaDeBuild ? { falhaDeBuild: verdict.falhaDeBuild } : {}),
      ...(verdict.inconclusivo ? { inconclusivo: verdict.inconclusivo } : {}),
      ...(verdict.aviso ? { aviso: verdict.aviso } : {}),
      ...(verdict.causaProvavel ? { causaProvavel: verdict.causaProvavel } : {}),
      erros: verdict.erros.length,
      avisos: verdict.avisos.length,
      ignorados: verdict.ignorados.length,
      resultados: verdict.infos.map((i) => ({
        status: i.status,
        arquivo: i.filePath,
        mensagem: i.message,
        detalhe: i.detail,
      })),
      ...(verdict.sucesso ? {} : { logDoServidor: logDaOperacao }),
    };
    return verdict.sucesso ? jsonResult(payload) : jsonFailure(payload);
  })
);

server.registerTool(
  "tds_syntax_check",
  {
    title: "Verificar sintaxe (sem gravar no RPO)",
    description:
      "Verifica a sintaxe dos fontes com o linter do TDS Language Server (o mesmo que marca erros " +
      "no editor do VS Code), usando as pastas de include do servidor conectado (ou as globais do " +
      "servers.json). Não usa o AppServer e não grava nada — pode ser usada livremente antes de " +
      "tds_compile. Devolve erros e avisos com arquivo e linha. Confie em `sintaxeOk`; fonte sem " +
      "resposta do linter vem em `semResposta` e deixa o resultado inconclusivo. O linter pode ser " +
      "mais rigoroso que o compilador; na dúvida sobre um erro, compile num ambiente de " +
      "desenvolvimento. Erro que só aparece na execução (variável inexistente) não é detectado aqui.",
    inputSchema: {
      arquivos: z.array(z.string()).min(1).describe("Caminhos de fontes ou pastas"),
      aceitarMisto: ACEITAR_MISTO_SCHEMA,
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ arquivos, aceitarMisto }) => {
    const cfg = readServersJson();
    const active = session?.current;
    const configured = active ? effectiveIncludes(cfg, active.def) : (cfg.includes ?? []).filter((i) => !!i);
    if (configured.length === 0) throw new Error("Nenhuma pasta de includes configurada (servers.json).");
    // Sem a pasta de include o linter não acha nem o PRTOPDEF.CH implícito e
    // acusa C2090 na linha 1 em todo fonte.
    const includes = configured.filter((d) => fs.statSync(d, { throwIfNoEntry: false })?.isDirectory());
    const includesAusentes = configured.filter((d) => !includes.includes(d));
    if (includes.length === 0) {
      throw new Error(
        `Nenhuma pasta de includes do servers.json existe nesta máquina: ${configured.join(", ")}. ` +
          `Corrija as pastas de include do servidor no TDS.`
      );
    }
    const expanded = expandFiles(arquivos).filter(isAdvplSource);
    if (expanded.length === 0) throw new Error("Nenhum fonte AdvPL/TLPP para verificar.");
    const checagem = checkFiles(expanded, aceitarMisto ?? false);
    const problemas = checagem.filter((c) => !c.safe);
    if (problemas.length > 0) throw new Error(encodingErrorMessage(problemas));
    const mistoAceito = mistoAceitoResumo(checagem);

    const { diagnosticos, semResposta } = await lintFiles(
      advplsPath ?? resolveAdvplsPath(config.advplsPath),
      expanded.map((f) => path.resolve(f)),
      includes
    );
    const erros = diagnosticos.filter((d) => d.severidade === "erro");
    const sintaxeOk = semResposta.length > 0 ? null : erros.length === 0;
    const payload = {
      ...(active ? { includesDoServidor: active.def.name } : { includes: "globais do servers.json" }),
      ...(includesAusentes.length ? { includesAusentes } : {}),
      ...(mistoAceito.length ? { encodingMistoAceito: mistoAceito } : {}),
      totalFontes: expanded.length,
      sintaxeOk,
      erros: erros.length,
      avisos: diagnosticos.filter((d) => d.severidade === "aviso").length,
      diagnosticos,
      ...(semResposta.length
        ? { semResposta, aviso: "O linter não respondeu para estes fontes; a verificação ficou inconclusiva." }
        : {}),
    };
    return sintaxeOk === true ? jsonResult(payload) : jsonFailure(payload);
  })
);

server.registerTool(
  "tds_generate_ppo",
  {
    title: "Gerar PPO (fonte pré-processado)",
    description:
      "Retorna o fonte após o pré-processador (resolução de #include/#define). " +
      "Útil para depurar problemas de defines e includes.",
    inputSchema: {
      arquivo: z.string().describe("Caminho do fonte"),
      aceitarMisto: ACEITAR_MISTO_SCHEMA,
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ arquivo, aceitarMisto }) => {
    const options = defaultCompileOptions();
    options.recompile = true;
    options.returnPpo = true;
    const { verdict } = await runCompilation([arquivo], options, aceitarMisto ?? false);
    const ppo = verdict.infos.find((i) => i.status === "APPRE");
    if (!ppo) {
      return jsonFailure({
        sucesso: false,
        returnCode: verdict.returnCode,
        ...(verdict.falhaDeBuild ? { falhaDeBuild: verdict.falhaDeBuild } : {}),
        ...(verdict.inconclusivo ? { inconclusivo: verdict.inconclusivo } : {}),
        mensagem: "PPO não retornado; veja resultados",
        resultados: verdict.infos.map((i) => ({
          status: i.status,
          arquivo: i.filePath,
          mensagem: i.message,
        })),
      });
    }
    return { content: [{ type: "text" as const, text: ppo.detail }] };
  })
);

server.registerTool(
  "tds_rpo_objects",
  {
    title: "Listar objetos do RPO",
    description:
      "Lista fontes/recursos do RPO do ambiente conectado. Use filtro para limitar (ex.: 'TEC10'). " +
      "ATENÇÃO à semântica de dataFonte: é o mtime (data de modificação) do ARQUIVO-FONTE registrado " +
      "no momento da compilação — NÃO é o instante em que a compilação ocorreu. Uso correto: comparar " +
      "com o mtime do arquivo em disco — igual (±2s) significa que o RPO contém o conteúdo atual do " +
      "arquivo; disco mais novo significa fonte alterado depois da última compilação. NÃO compare com " +
      "data de commit git (commit posterior ao mtime é normal). Sem filtro retorna contagem + primeiros 100.",
    inputSchema: {
      filtro: z.string().optional().describe("Substring case-insensitive do nome"),
      incluirRecursos: z.boolean().optional().default(false).describe("Incluir recursos não-fonte (tres)"),
      limite: z.number().int().min(1).optional().default(100).describe("Máximo de itens retornados"),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ filtro, incluirRecursos, limite }) => {
    const { client, session } = await ensureClient();
    const active = session.required();
    const all = await client.inspectorObjects(
      active.connectionToken,
      active.environment,
      incluirRecursos ?? false
    );
    const needle = filtro?.toLowerCase();
    const filtered = needle ? all.filter((o) => o.source.toLowerCase().includes(needle)) : all;
    const max = limite ?? 100;
    return jsonResult({
      servidor: active.def.name,
      ambiente: active.environment,
      totalNoRPO: all.length,
      totalFiltrado: filtered.length,
      exibindo: Math.min(filtered.length, max),
      semanticaDataFonte:
        "mtime do arquivo-fonte no momento da compilação; igual ao disco (±2s) = RPO atualizado",
      objetos: filtered.slice(0, max).map((o) => ({ fonte: o.source, dataFonte: o.date })),
    });
  })
);

server.registerTool(
  "tds_rpo_functions",
  {
    title: "Listar funções do RPO",
    description:
      "Lista funções do RPO com fonte e linha onde estão definidas. Use filtro para procurar " +
      "uma função específica (ex.: 'U_TEC10R06').",
    inputSchema: {
      filtro: z.string().optional().describe("Substring case-insensitive do nome da função"),
      apenasPublicas: z.boolean().optional().default(true).describe("Omitir funções privadas/estáticas"),
      limite: z.number().int().min(1).optional().default(100).describe("Máximo de itens retornados"),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ filtro, apenasPublicas, limite }) => {
    const { client, session } = await ensureClient();
    const active = session.required();
    const all = await client.inspectorFunctions(
      active.connectionToken,
      active.environment,
      apenasPublicas ?? true
    );
    const needle = filtro?.toLowerCase();
    const filtered = needle ? all.filter((f) => f.function.toLowerCase().includes(needle)) : all;
    const max = limite ?? 100;
    return jsonResult({
      servidor: active.def.name,
      ambiente: active.environment,
      totalFiltrado: filtered.length,
      exibindo: Math.min(filtered.length, max),
      funcoes: filtered.slice(0, max).map((f) => ({
        funcao: f.function,
        fonte: f.source,
        linha: f.line,
      })),
    });
  })
);

server.registerTool(
  "tds_rpo_info",
  {
    title: "Informações do RPO",
    description:
      "Versão do RPO, data de geração e histórico de patches aplicados no ambiente conectado. " +
      "Auditoria pré/pós-deploy.",
    inputSchema: {
      ultimosPatches: z.number().int().min(1).optional().default(10).describe("Quantos patches do histórico retornar"),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ ultimosPatches }) => {
    const { client, session } = await ensureClient();
    const active = session.required();
    const info = await client.rpoInfo(active.connectionToken, active.environment);
    const patches = info.rpoPatchs ?? [];
    const max = ultimosPatches ?? 10;
    return jsonResult({
      servidor: active.def.name,
      ambiente: info.environment || active.environment,
      versaoRPO: info.rpoVersion,
      dataGeracao: info.dateGeneration,
      totalPatchesAplicados: patches.length,
      ultimosPatches: patches.slice(-max).map((p) => ({
        geradoEm: p.dateFileGeneration,
        buildGeracao: p.buildFileGeneration,
        aplicadoEm: p.dateFileApplication,
        programas: (p.programsApp ?? []).slice(0, 20).map((pr) => `${pr.name} (${pr.date})`),
        totalProgramas: (p.programsApp ?? []).length,
      })),
    });
  })
);

server.registerTool(
  "tds_patch_generate",
  {
    title: "Gerar patch (PTM) com rastreabilidade",
    description:
      "Gera um patch PTM a partir de fontes já compilados no RPO, com organização padrão " +
      "(<raiz>/<cliente>/<ticket>/DDMMAA_HHMM_<ticket>_<customizacao>.ptm, datas no padrão brasileiro), " +
      "manifesto JSON (sha256, fontes, datas do RPO, servidor, autor, git) e histórico. Exige o " +
      "identificador da customização (vai no nome do arquivo junto com o ticket) e o título para o " +
      "tcloud (até 60 caracteres), devolvido em tituloTcloud. Retorna também título e descrição " +
      "recomendados — o título começa com data e hora. No manifesto/retorno, rpoDate de cada " +
      "fonte é o mtime do arquivo-fonte na compilação (semântica de tds_rpo_objects), não o " +
      "instante da compilação.",
    inputSchema: {
      fontes: z
        .array(z.string())
        .min(1)
        .describe("Nomes dos objetos no RPO (ex.: TEC10R06.PRW). Devem já estar compilados."),
      cliente: z.string().describe("Nome do cliente (vira pasta)"),
      ticket: z.string().describe("Número do ticket da demanda (vira pasta e entra no nome do arquivo)"),
      customizacao: z
        .string()
        .min(3)
        .max(40)
        .regex(/^[a-z0-9]+(_[a-z0-9]+)*$/, "Use snake_case minúsculo, sem acento (ex.: balanca_refugo_req_op)")
        .describe(
          "Identificador curto da customização em snake_case, sem acento, até 40 caracteres " +
            "(ex.: balanca_refugo_req_op). Vai no nome do arquivo depois do ticket."
        ),
      tituloTcloud: z
        .string()
        .trim()
        .min(5)
        .max(60, "O título do tcloud tem no máximo 60 caracteres")
        .describe(
          "Título para cadastrar o patch no tcloud, até 60 caracteres, com o ticket e o que muda " +
            "(ex.: '18662 Balança refugo: regras, data e requisição na OP')."
        ),
      descricao: z.string().optional().default("").describe("Motivo/resumo da alteração"),
      pastaFontesLocais: z
        .string()
        .optional()
        .describe("Pasta local dos fontes (para registrar commit git no manifesto)"),
    },
  },
  safe(async ({ fontes, cliente, ticket, customizacao, tituloTcloud, descricao, pastaFontesLocais }) => {
    const { client, session } = await ensureClient();
    const active = session.required();
    const cfg = readServersJson();

    // Confere existência/data de cada fonte no RPO (rastreabilidade)
    const rpoObjects = await client.inspectorObjects(active.connectionToken, active.environment, true);
    const byName = new Map(rpoObjects.map((o) => [o.source.toUpperCase(), o]));
    const sources: PatchSourceEntry[] = [];
    const missing: string[] = [];
    for (const f of fontes) {
      const hit = byName.get(f.toUpperCase());
      if (hit) sources.push({ name: hit.source, rpoDate: hit.date });
      else missing.push(f);
    }
    if (missing.length > 0) {
      throw new Error(
        `Fontes não encontrados no RPO de ${active.def.name}/${active.environment}: ${missing.join(", ")}. ` +
          `Compile antes (tds_compile) ou confira o nome exato com tds_rpo_objects.`
      );
    }

    const stamp = nowStamp();
    // Ticket + customização no nome: o arquivo se identifica sozinho, sem abrir o manifesto
    const slugBase = `${slugify_safe(ticket)}_${customizacao}`;
    const destDir = ensurePatchDir(config.patchesRoot, cliente, ticket);
    // DDMMAA_HHMM; se já existir patch no mesmo minuto, usa variante com segundos
    let baseName = patchBaseName(stamp, slugBase);
    if (fs.existsSync(path.join(destDir, `${baseName}.ptm`))) {
      baseName = patchBaseName(stamp, slugBase, true);
    }

    const result = await client.patchGenerate({
      connectionToken: active.connectionToken,
      authorizationToken: authorizationToken(cfg),
      environment: active.environment,
      patchDestUri: toFileUri(destDir),
      patchName: baseName,
      patchFiles: sources.map((s) => s.name),
    });

    // Mesma regra da compilação: returnCode != 0 = falha de build, mesmo sem
    // erro por fonte. Nunca assumir sucesso só porque a resposta chegou.
    const rc = typeof result?.returnCode === "number" ? result.returnCode : 0;
    if (rc !== 0) {
      throw new Error(
        RETURN_CODE_HINTS[rc] ??
          `Geração de patch falhou no servidor (returnCode ${rc}). Consulte tds_server_log.`
      );
    }

    // Localiza o arquivo gerado
    const expected = path.join(destDir, `${baseName}.ptm`);
    const patchFile = fs.existsSync(expected)
      ? expected
      : findNewestPtm(destDir, stamp.iso) ?? expected;
    if (!fs.existsSync(patchFile)) {
      throw new Error(
        `Servidor reportou geração, mas o arquivo não foi encontrado em ${destDir}. ` +
          `Retorno: ${JSON.stringify(result)}`
      );
    }

    const author = currentAuthor();
    const titulo = recommendedTitle(stamp, cliente, ticket, sources.map((s) => s.name));
    const descricaoCompleta = recommendedDescription({
      stamp,
      cliente,
      ticket,
      descricao: descricao ?? "",
      serverName: active.def.name,
      environment: active.environment,
      build: active.def.buildVersion ?? "",
      sources,
      author,
    });

    const manifest: PatchManifest = {
      titulo,
      tituloTcloud,
      customizacao,
      descricao: descricaoCompleta,
      patchFile,
      sha256: sha256File(patchFile),
      sizeBytes: fs.statSync(patchFile).size,
      patchType: "ptm",
      cliente,
      ticket,
      server: {
        name: active.def.name,
        address: active.def.address,
        port: active.def.port,
        environment: active.environment,
        build: active.def.buildVersion ?? "",
      },
      sources,
      author,
      createdAt: stamp.iso,
      git: pastaFontesLocais ? gitInfo(pastaFontesLocais) : undefined,
    };
    const manifestFile = writeManifest(destDir, baseName, manifest);

    appendHistory(config.patchesRoot, destDir, {
      ts: stamp.iso,
      op: "generate",
      patchFile,
      server: active.def.name,
      environment: active.environment,
      author,
      ok: true,
    });

    return jsonResult({
      sucesso: true,
      tituloTcloud,
      tituloRecomendado: titulo,
      descricaoRecomendada: descricaoCompleta,
      patch: patchFile,
      manifesto: manifestFile,
      sha256: manifest.sha256,
      fontes: sources,
    });
  })
);

server.registerTool(
  "tds_patch_validate",
  {
    title: "Validar patch (sem aplicar)",
    description:
      "Valida um arquivo de patch contra o RPO do ambiente conectado, sem aplicar. " +
      "Aponta fontes do patch mais antigos que o RPO. Gate recomendado antes de tds_patch_apply. " +
      "As datas comparadas (dataPatch/dataRPO) seguem a semântica de mtime do arquivo-fonte na " +
      "compilação, não do instante de compilação.",
    inputSchema: {
      arquivoPatch: z.string().describe("Caminho local do .ptm/.upd/.pak"),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ arquivoPatch }) => {
    const { client, session } = await ensureClient();
    const active = session.required();
    const cfg = readServersJson();
    if (!fs.existsSync(arquivoPatch)) throw new Error(`Patch não encontrado: ${arquivoPatch}`);

    const result = await client.patchApply({
      connectionToken: active.connectionToken,
      authorizationToken: authorizationToken(cfg),
      environment: active.environment,
      patchUri: toFileUri(arquivoPatch),
      validateOnly: true,
    });

    // error e errorCode: qualquer um diferente de zero/false indica falha.
    const ok = !result.error && (result.errorCode ?? 0) === 0;
    appendHistory(config.patchesRoot, dirIfManaged(arquivoPatch), {
      ts: new Date().toISOString(),
      op: "validate",
      patchFile: arquivoPatch,
      server: active.def.name,
      environment: active.environment,
      author: currentAuthor(),
      ok,
      detail: result.message,
    });

    return jsonResult({
      valido: ok,
      mensagem: result.message,
      codigoErro: result.errorCode,
      fontesDesatualizados: (result.patchValidates ?? []).map((v) => ({
        fonte: v.file,
        dataPatch: v.datePatch,
        dataRPO: v.dateRpo,
      })),
    });
  })
);

server.registerTool(
  "tds_patch_info",
  {
    title: "Inspecionar conteúdo de patch",
    description:
      "Lista o conteúdo (fontes, datas, tamanhos) de um arquivo de patch sem aplicá-lo. " +
      "Auditoria de patch recebido de terceiros. O campo date de cada objeto é o mtime do " +
      "arquivo-fonte registrado na compilação (mesma semântica de tds_rpo_objects).",
    inputSchema: {
      arquivoPatch: z.string().describe("Caminho local do .ptm/.upd/.pak"),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ arquivoPatch }) => {
    const { client, session } = await ensureClient();
    const active = session.required();
    const cfg = readServersJson();
    if (!fs.existsSync(arquivoPatch)) throw new Error(`Patch não encontrado: ${arquivoPatch}`);

    const result = await client.patchInfo({
      connectionToken: active.connectionToken,
      authorizationToken: authorizationToken(cfg),
      environment: active.environment,
      patchUri: toFileUri(arquivoPatch),
    });
    return jsonResult({ arquivo: arquivoPatch, conteudo: result.patchInfos });
  })
);

server.registerTool(
  "tds_patch_apply",
  {
    title: "Aplicar patch no RPO",
    description:
      "APLICA um patch no RPO do ambiente conectado (operação de deploy — altera o ambiente). " +
      "Por padrão aplica somente fontes mais novos; use aplicarAntigos=true para forçar. " +
      "Recomenda-se tds_patch_validate antes.",
    inputSchema: {
      arquivoPatch: z.string().describe("Caminho local do .ptm/.upd/.pak"),
      aplicarAntigos: z
        .boolean()
        .optional()
        .default(false)
        .describe("Aplicar mesmo fontes mais antigos que os do RPO"),
    },
    annotations: { destructiveHint: true },
  },
  safe(async ({ arquivoPatch, aplicarAntigos }) => {
    const { client, session } = await ensureClient();
    const active = session.required();
    const cfg = readServersJson();
    if (!fs.existsSync(arquivoPatch)) throw new Error(`Patch não encontrado: ${arquivoPatch}`);

    const result = await client.patchApply({
      connectionToken: active.connectionToken,
      authorizationToken: authorizationToken(cfg),
      environment: active.environment,
      patchUri: toFileUri(arquivoPatch),
      validateOnly: false,
      applyOld: aplicarAntigos ?? false,
    });

    // error e errorCode: qualquer um diferente de zero/false indica falha.
    const ok = !result.error && (result.errorCode ?? 0) === 0;
    appendHistory(config.patchesRoot, dirIfManaged(arquivoPatch), {
      ts: new Date().toISOString(),
      op: "apply",
      patchFile: arquivoPatch,
      server: active.def.name,
      environment: active.environment,
      author: currentAuthor(),
      ok,
      detail: result.message,
    });

    const payload = {
      aplicado: ok,
      servidor: active.def.name,
      ambiente: active.environment,
      mensagem: result.message,
      codigoErro: result.errorCode,
      ocorrencias: (result.patchValidates ?? []).map((v) => ({
        fonte: v.file,
        dataPatch: v.datePatch,
        dataRPO: v.dateRpo,
      })),
    };
    // Deploy que falhou nunca pode ser lido como sucesso.
    return ok ? jsonResult(payload) : jsonFailure(payload);
  })
);

server.registerTool(
  "tds_server_log",
  {
    title: "Log do language server",
    description:
      "Últimas mensagens emitidas pelo advpls nesta sessão (diagnóstico de conexão/compilação) " +
      "e o binário em uso (caminho e versões do tds-ls/extensão). Falha de conexão com release " +
      "nova do Protheus costuma ser versão antiga do tds-ls.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  safe(async () => {
    return jsonResult({
      advpls: advplsDiagnostic(),
      log: client?.serverLog ?? [],
      configFile: configFilePath(),
      ...(configWarnings.length ? { avisosConfig: configWarnings } : {}),
    });
  })
);

server.registerTool(
  "tds_server_files",
  {
    title: "Listar pastas/arquivos do servidor",
    description:
      "Lista subpastas e arquivos de uma pasta no sistema de arquivos do AppServer conectado " +
      "(a mesma navegação que o tds-vscode usa para escolher pasta de patch no servidor). " +
      "pasta vazia = raiz.",
    inputSchema: {
      pasta: z.string().optional().default("").describe("Caminho no servidor; vazio = raiz"),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ pasta }) => {
    const { client, session } = await ensureClient();
    const active = session.required();
    const folder = pasta ?? "";
    const pastas = await client.getPatchDir(active.connectionToken, active.environment, folder, true);
    const arquivos = await client.getPatchDir(active.connectionToken, active.environment, folder, false);
    return jsonResult({ servidor: active.def.name, pasta: folder, pastas, arquivos });
  })
);

server.registerTool(
  "tds_server_permissions",
  {
    title: "Privilégios no servidor",
    description:
      "Operações que o usuário da sessão pode executar no AppServer conectado (compilar, " +
      "aplicar patch, monitor, parar servidor...), conforme a seção de privilégios do appserver.ini.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  safe(async () => {
    const { client, session } = await ensureClient();
    const active = session.required();
    const result = await client.serverPermissions(active.connectionToken);
    const ops = result?.serverPermissions?.operation ?? [];
    const texts = result?.serverPermissions?.text ?? [];
    return jsonResult({
      servidor: active.def.name,
      usuario: active.user,
      mensagem: result?.message,
      permissoes: ops.map((op, i) => ({ operacao: op, descricao: texts[i] ?? "" })),
    });
  })
);

// ---------------------------------------------------------------------------
// Monitor do AppServer
// ---------------------------------------------------------------------------

function userView(u: MonitorUser) {
  return {
    threadId: u.threadId,
    usuario: u.username,
    computador: u.computerName,
    servidor: u.server,
    ambiente: u.environment,
    programa: u.mainName,
    tipoCliente: u.clientType,
    login: u.loginTime?.trim(),
    tempoDecorrido: u.elapsedTime,
    tempoInativo: u.inactiveTime,
    memoria: u.memUsed,
    instrucoesPorSeg: u.instrCountPerSec,
    observacao: u.remark,
  };
}

/**
 * Sessão-alvo pela thread, conferida na lista atual do monitor: o agente não
 * digita usuário/computador, e a ação nunca vai para uma thread que já saiu.
 */
async function findMonitorTarget(
  client: AdvplsClient,
  monitorToken: string,
  threadId: number,
  servidorDaSessao?: string
): Promise<MonitorUser> {
  const users = await client.getUsers(monitorToken);
  const hits = users.filter(
    (u) =>
      u.threadId === threadId &&
      (!servidorDaSessao || u.server.toLowerCase() === servidorDaSessao.toLowerCase())
  );
  if (hits.length === 0) {
    throw new Error(
      `Thread ${threadId} não está na lista atual do monitor` +
        (servidorDaSessao ? ` do servidor "${servidorDaSessao}"` : "") +
        `. Confira com tds_monitor_users.`
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `Thread ${threadId} aparece em mais de um servidor (${hits.map((h) => h.server).join(", ")}). ` +
        `Informe servidorDaSessao.`
    );
  }
  return hits[0];
}

const targetSchema = {
  threadId: z.number().int().describe("Thread da sessão, como listada em tds_monitor_users"),
  servidorDaSessao: z
    .string()
    .optional()
    .describe("Campo `servidor` da sessão em tds_monitor_users; só se a thread se repetir"),
};

server.registerTool(
  "tds_monitor_users",
  {
    title: "Monitor: sessões conectadas",
    description:
      "Lista as sessões (threads) do AppServer conectado: usuário, computador, ambiente, " +
      "programa, tempo de conexão/inatividade e memória. Filtros por substring, sem diferenciar " +
      "maiúsculas. Abre uma conexão de monitor; exige privilégio de monitor no servidor.",
    inputSchema: {
      usuario: z.string().optional().describe("Filtro pelo nome do usuário"),
      ambiente: z.string().optional().describe("Filtro pelo ambiente"),
      programa: z.string().optional().describe("Filtro pelo programa (ex.: SIGAFAT, HTTP_START)"),
      limite: z.number().int().min(1).optional().default(100).describe("Máximo de sessões retornadas"),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ usuario, ambiente, programa, limite }) => {
    const { client, session } = await ensureClient();
    const active = session.required();
    const users = await client.getUsers(await session.monitorToken());
    const has = (value: string | undefined, needle?: string) =>
      !needle || (value ?? "").toLowerCase().includes(needle.toLowerCase());
    const filtered = users.filter(
      (u) => has(u.username, usuario) && has(u.environment, ambiente) && has(u.mainName, programa)
    );
    const max = limite ?? 100;
    return jsonResult({
      servidor: active.def.name,
      totalSessoes: users.length,
      totalFiltrado: filtered.length,
      exibindo: Math.min(filtered.length, max),
      sessoes: filtered.slice(0, max).map(userView),
    });
  })
);

server.registerTool(
  "tds_monitor_send_message",
  {
    title: "Monitor: enviar mensagem a uma sessão",
    description:
      "Exibe uma mensagem ao usuário de uma sessão do AppServer conectado. A sessão é " +
      "identificada pela thread (tds_monitor_users) e conferida na lista atual antes do envio.",
    inputSchema: {
      ...targetSchema,
      mensagem: z.string().trim().min(1).describe("Texto exibido ao usuário"),
    },
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  safe(async ({ threadId, servidorDaSessao, mensagem }) => {
    const { client, session } = await ensureClient();
    const active = session.required();
    const token = await session.monitorToken();
    const target = await findMonitorTarget(client, token, threadId, servidorDaSessao);
    const retorno = await client.sendUserMessage(token, target, mensagem);
    return jsonResult({ servidor: active.def.name, sessao: userView(target), retornoDoServidor: retorno });
  })
);

server.registerTool(
  "tds_monitor_kill_user",
  {
    title: "Monitor: derrubar sessão imediatamente",
    description:
      "Encerra IMEDIATAMENTE uma sessão do AppServer conectado (o usuário perde o que não " +
      "gravou). Para pedir que a aplicação se encerre sozinha, use tds_monitor_app_kill_user. " +
      "A sessão é identificada pela thread e conferida na lista atual antes da ação.",
    inputSchema: targetSchema,
    annotations: { destructiveHint: true },
  },
  safe(async ({ threadId, servidorDaSessao }) => {
    const { client, session } = await ensureClient();
    const active = session.required();
    const token = await session.monitorToken();
    const target = await findMonitorTarget(client, token, threadId, servidorDaSessao);
    const retorno = await client.killUser(token, target);
    return jsonResult({ servidor: active.def.name, sessao: userView(target), retornoDoServidor: retorno });
  })
);

server.registerTool(
  "tds_monitor_app_kill_user",
  {
    title: "Monitor: pedir encerramento da aplicação da sessão",
    description:
      "Pede à aplicação de uma sessão do AppServer conectado que se encerre. É só um pedido: o " +
      "servidor marca a sessão (observacao \"[APPKILL]\") e ela termina quando o programa atender " +
      "o pedido; um programa em laço que não o verifica continua rodando. Para derrubar na hora, " +
      "use tds_monitor_kill_user. A sessão é identificada pela thread e conferida na lista atual.",
    inputSchema: targetSchema,
    annotations: { destructiveHint: true },
  },
  safe(async ({ threadId, servidorDaSessao }) => {
    const { client, session } = await ensureClient();
    const active = session.required();
    const token = await session.monitorToken();
    const target = await findMonitorTarget(client, token, threadId, servidorDaSessao);
    const retorno = await client.appKillUser(token, target);
    return jsonResult({ servidor: active.def.name, sessao: userView(target), retornoDoServidor: retorno });
  })
);

// ---------------------------------------------------------------------------
// Execução e depuração (debugAdapter da TOTVS + webapp)
// ---------------------------------------------------------------------------

const debugManager = new DebugManager(config.debugIdleMinutes ?? 10);

/** URL do webapp do servidor: config > http(s)://<endereço>:<porta>/webapp/ (multiprotocolo). */
function webappUrlFor(def: { name: string; address: string; port: number; secure: boolean }): string {
  const configured = config.webappUrls?.[def.name];
  if (configured) return configured.endsWith("/") ? configured : configured + "/";
  if (/^https?:\/\//i.test(def.address)) return `${def.address}:${def.port}/webapp/`;
  return `${def.secure ? "https" : "http"}://${def.address}:${def.port}/webapp/`;
}

/** "DD/MM/AAAA HH:MM:SS" do inspetor de objetos -> epoch ms (hora local). */
function parseRpoDate(value: string): number | undefined {
  const m = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!m) return undefined;
  return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]).getTime();
}

/**
 * Confere se o fonte local de cada breakpoint é o que está no RPO (mesma
 * semântica de tds_rpo_objects: data do RPO = mtime do arquivo na compilação).
 * Fonte divergente desloca as linhas dos breakpoints.
 */
async function sourceFreshness(files: string[]): Promise<string[]> {
  if (files.length === 0) return [];
  const { client, session } = await ensureClient();
  const active = session.required();
  const objects = await client.inspectorObjects(active.connectionToken, active.environment, false);
  const byName = new Map(objects.map((o) => [o.source.toUpperCase(), o]));
  const avisos: string[] = [];
  for (const file of files) {
    const name = path.basename(file).toUpperCase();
    const hit = byName.get(name);
    if (!hit) {
      avisos.push(`${path.basename(file)} não está no RPO de ${active.environment}: compile antes (tds_compile).`);
      continue;
    }
    const rpo = parseRpoDate(hit.date);
    const local = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
    if (rpo !== undefined && local !== undefined && Math.abs(Math.floor(local / 1000) * 1000 - rpo) > 2000) {
      avisos.push(
        `${path.basename(file)}: o arquivo local (${new Date(local).toLocaleString("pt-BR")}) não é o compilado no ` +
          `RPO (${hit.date}). As linhas dos breakpoints podem não bater; recompile com tds_compile.`
      );
    }
  }
  return avisos;
}

async function startDebug(args: {
  programa: string;
  argumentos?: string[];
  modulo?: string;
  breakpoints?: { arquivo: string; linha: number; condicao?: string; log?: string; contagem?: string; rastro?: string[] }[];
  modo: DebugMode;
  pastaFontes?: string;
}) {
  if (args.modulo && args.modo !== "navegador") {
    throw new Error(
      "modulo exige modo 'navegador': o SIGABPM pede login e diálogos do módulo, operados no chrome-devtools."
    );
  }
  const inicial = programaInicial(args.programa, args.argumentos ?? [], args.modulo);
  const { session } = await ensureClient();
  const active = session.required();
  const byFile: Record<string, BreakpointSpec[]> = {};
  for (const b of args.breakpoints ?? []) {
    const file = path.resolve(b.arquivo);
    if (!fs.existsSync(file)) throw new Error(`Fonte do breakpoint não encontrado: ${b.arquivo}`);
    (byFile[file] ??= []).push({ linha: b.linha, condicao: b.condicao, log: b.log, contagem: b.contagem, rastro: b.rastro });
  }
  const avisos = [
    ...(await sourceFreshness(Object.keys(byFile))),
    ...Object.entries(byFile).flatMap(([file, specs]) => breakpointLineWarnings(file, specs.map((s) => s.linha))),
  ];
  const firstFile = Object.keys(byFile)[0];
  const pastaFontes = path.resolve(args.pastaFontes ?? (firstFile ? path.dirname(firstFile) : process.cwd()));
  const adapterPath = resolveDebugAdapterPath(advplsPath ?? resolveAdvplsPath(config.advplsPath), config.debugAdapterPath);
  const started = await debugManager.start({
    active,
    adapterPath,
    chromiumPath: args.modo === "navegador" ? undefined : resolveChromiumPath(config.chromiumPath),
    webappUrl: webappUrlFor(active.def),
    programa: inicial.programa,
    argumentos: inicial.argumentos,
    descricao: inicial.codigoModulo ? `${args.programa} (módulo ${inicial.codigoModulo})` : undefined,
    breakpoints: byFile,
    modo: args.modo,
    pastaFontes,
  });
  return { ...started, avisos };
}

const breakpointSchema = z.object({
  arquivo: z.string().describe("Caminho local do fonte (.prw/.tlpp); casa com o RPO pelo nome do arquivo"),
  linha: z.number().int().min(1).describe("Linha (1 = primeira)"),
  condicao: z.string().optional().describe("Expressão AdvPL; para só quando verdadeira (ex.: nI == 2)"),
  log: z
    .string()
    .optional()
    .describe(
      "Logpoint do depurador TOTVS: registra sem parar, mas só interpola {nomeDeVariavel} e valor " +
        "caractere sai vazio. Para texto ou expressões, prefira rastro."
    ),
  rastro: z
    .array(z.string())
    .optional()
    .describe(
      "Ponto de rastro: ao passar na linha, avalia estas expressões (inclusive texto e funções), " +
        "registra os valores em mensagens (nivel RASTRO) e continua sem parar. Ex.: [\"cArg\", \"Len(aItens)\"]"
    ),
  contagem: z.string().optional().describe("Para só a partir da N-ésima passagem (ex.: '3')"),
});

server.registerTool(
  "tds_debug_start",
  {
    title: "Depurar: iniciar sessão",
    description:
      "Inicia a depuração de um programa no servidor/ambiente conectado (tds_use_server), pelo " +
      "debugAdapter da TOTVS e o SmartClient HTML (webapp). Pergunte ao usuário antes de depurar " +
      "num servidor: o programa roda de verdade e, parado num breakpoint, segura a thread. " +
      "modo 'headless': o tds-mcp abre o programa num navegador invisível — para rotinas sem " +
      "tela. modo 'navegador': devolve `abrirCom` ({url, isolatedContext}); abra com new_page do " +
      "chrome-devtools passando os dois — sem o contexto isolado, o perfil do navegador guarda o " +
      "último programa e o WebAgent, e o webapp descarta os parâmetros da URL. Opere as telas no " +
      "chrome-devtools e acompanhe com tds_debug_wait. modulo (só no modo navegador): roda a rotina " +
      "dentro do módulo, como o usuário no menu (empresa, filial, data base, MV_ e variáveis do " +
      "módulo); a tela pede login e confirma diálogos do módulo antes de a rotina começar. Sem " +
      "modulo, a função é o programa inicial e roda sem empresa aberta; um wrapper com RpcSetEnv " +
      "abre o ambiente em modo automático (Pergunte não mostra tela, data com ano de 2 dígitos). modo 'job': também captura threads novas do ambiente " +
      "(StartJob, REST) — mas pode capturar jobs alheios do servidor; use só em AppServer de " +
      "desenvolvimento dedicado. Com aguardarSeg > 0 espera a primeira parada e já devolve o " +
      "estado (local, pilha, variáveis Local/Private/Static). Uma sessão por vez; encerre com " +
      "tds_debug_stop. Os fontes dos breakpoints precisam estar compilados (o retorno avisa " +
      "quando o arquivo local difere do RPO).",
    inputSchema: {
      programa: z
        .string()
        .min(1)
        .describe("A rotina a executar, como no SmartClient (ex.: u_zMinhaRotina). Nunca SIGAMDI/SIGABPM: use modulo"),
      argumentos: z
        .array(z.string())
        .optional()
        .describe("Parâmetros da rotina (equivalem a -A/&A=), chegam como caractere. Não combinam com modulo"),
      modulo: z
        .string()
        .optional()
        .describe(
          "Módulo onde a rotina roda, por código ou nome (ex.: '04' ou 'SIGAEST'). O tds-mcp abre pelo " +
            "SIGABPM; exige modo 'navegador'"
        ),
      breakpoints: z.array(breakpointSchema).optional().default([]),
      modo: z.enum(["headless", "navegador", "job"]).optional().default("headless"),
      aguardarSeg: z
        .number()
        .min(0)
        .max(600)
        .optional()
        .describe("Segundos para esperar a primeira parada (padrão 60; no modo navegador padrão 0)"),
      pastaFontes: z
        .string()
        .optional()
        .describe("Pasta dos fontes locais (padrão: pasta do primeiro breakpoint)"),
    },
  },
  safe(async ({ programa, argumentos, modulo, breakpoints, modo, aguardarSeg, pastaFontes }) => {
    const mode = (modo ?? "headless") as DebugMode;
    const { session: s, breakpoints: bps, avisos } = await startDebug({
      programa,
      argumentos,
      modulo,
      breakpoints,
      modo: mode,
      pastaFontes,
    });
    const wait = aguardarSeg ?? (mode === "navegador" ? 0 : 60);
    const estado = wait > 0 ? await s.waitForStop(wait) : { estado: "executando" };
    const contexto = `tds-${/[?&]DEBUG=(\d+)/.exec(s.url ?? "")?.[1] ?? Date.now()}`;
    return jsonResult({
      sessao: { programa: s.programa, servidor: s.servidor, ambiente: s.ambiente, modo: s.modo },
      ...(mode === "navegador"
        ? {
            abrirCom: { url: s.url, isolatedContext: contexto },
            proximoPasso:
              `Chame new_page do chrome-devtools com url e isolatedContext "${contexto}" de abrirCom. ` +
              (modulo
                ? "A tela pede login (usuário e senha do Protheus), depois confirma empresa/filial/data base, " +
                  "o aviso de ambiente e diálogos do módulo (ex.: Moedas): confirme cada um; a carga do módulo " +
                  "pode levar minutos. "
                : "") +
              "Acompanhe com tds_debug_wait (até 100 s por chamada) e veja a tela com take_snapshot.",
          }
        : {}),
      breakpoints: bps,
      ...(avisos.length ? { avisos } : {}),
      ...estado,
    });
  })
);

server.registerTool(
  "tds_debug_wait",
  {
    title: "Depurar: esperar parada",
    description:
      "Espera o programa em depuração parar (breakpoint, passo) ou terminar e devolve o estado: " +
      "local, pilha, variáveis Local/Private/Static do topo, watches, o que mudou desde a parada " +
      "anterior e mensagens (logpoints, erros). estado 'executando' = ainda não parou no prazo " +
      "(o programa pode estar esperando interação na tela): nos modos headless e job vêm `tela` " +
      "(texto) e `botoes` do navegador invisível; no modo navegador, conectado=false indica que " +
      "nenhum webapp abriu a sessão. Erro de execução vem em erroDeExecucao (mensagem, " +
      "pilha e variáveis da tela de erro) com estado 'encerrado'. Use timeoutSeg até 100: " +
      "chamada mais longa estoura o prazo de ferramenta do cliente.",
    inputSchema: {
      timeoutSeg: z.number().min(1).max(600).optional().default(60),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ timeoutSeg }) => jsonResult(await debugManager.require().waitForStop(timeoutSeg ?? 60)))
);

server.registerTool(
  "tds_debug_step",
  {
    title: "Depurar: continuar / passo",
    description:
      "Com o programa parado: 'continuar' até o próximo breakpoint ou o fim; 'proxima' executa a " +
      "linha (passa por cima de chamadas); 'entrar' entra na função chamada; 'sair' volta ao " +
      "chamador. Devolve o novo estado como tds_debug_wait.",
    inputSchema: {
      acao: z.enum(["continuar", "proxima", "entrar", "sair"]),
      timeoutSeg: z.number().min(1).max(600).optional().default(60),
    },
  },
  safe(async ({ acao, timeoutSeg }) => jsonResult(await debugManager.require().step(acao, timeoutSeg ?? 60)))
);

server.registerTool(
  "tds_debug_breakpoints",
  {
    title: "Depurar: definir breakpoints de um fonte",
    description:
      "Substitui os breakpoints de um fonte na sessão ativa (lista vazia remove todos). Funciona " +
      "com o programa rodando: incluir um breakpoint numa linha que será executada é a forma " +
      "confiável de interromper (pause não interrompe thread em Sleep). Para 'rodar até a linha', " +
      "inclua o breakpoint e use tds_debug_step continuar.",
    inputSchema: {
      arquivo: z.string(),
      breakpoints: z.array(breakpointSchema.omit({ arquivo: true })).default([]),
    },
  },
  safe(async ({ arquivo, breakpoints }) => {
    const s = debugManager.require();
    s.touch();
    if (!fs.existsSync(arquivo)) throw new Error(`Fonte não encontrado: ${arquivo}`);
    const avisos = [
      ...(await sourceFreshness(breakpoints.length ? [path.resolve(arquivo)] : [])),
      ...breakpointLineWarnings(path.resolve(arquivo), breakpoints.map((b) => b.linha)),
    ];
    const resultado = await s.setBreakpoints(arquivo, breakpoints);
    return jsonResult({ arquivo, breakpoints: resultado, ...(avisos.length ? { avisos } : {}) });
  })
);

server.registerTool(
  "tds_debug_variables",
  {
    title: "Depurar: ver variáveis",
    description:
      "Lista as variáveis de um escopo num frame da pilha, ou expande uma variável. Escopos: " +
      "Local, Private, Public, Static e Table (tabelas abertas: cada alias com os campos do " +
      "registro posicionado). frame 0 = função atual; 1, 2... = chamadores (é assim que se vê " +
      "variável de outra função — tds_debug_evaluate só enxerga o frame 0). caminho desce em " +
      "arrays, objetos JSON e tabelas: ['AITENS'], ['AITENS', 'AITENS[3]'], ['SA1'].",
    inputSchema: {
      escopo: z.string().optional().default("Local"),
      frame: z.number().int().min(0).optional().default(0),
      caminho: z.array(z.string()).optional().default([]),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ escopo, frame, caminho }) =>
    jsonResult(await debugManager.require().variables(frame ?? 0, escopo ?? "Local", caminho ?? []))
  )
);

server.registerTool(
  "tds_debug_evaluate",
  {
    title: "Depurar: avaliar expressão",
    description:
      "Avalia uma expressão AdvPL no ponto de parada (frame do topo). Aceita atribuição para " +
      "alterar o programa em execução (nTotal := 0), campos de tabela (SA1->A1_COD, " +
      "SA1->(RecNo())), funções (Len(aItens)) e table:ALIAS para a tabela inteira. ATENÇÃO: roda " +
      "código de verdade no servidor — função com efeito colateral (RecLock, gravação) executa.",
    inputSchema: {
      expressao: z.string().min(1),
    },
  },
  safe(async ({ expressao }) => jsonResult({ expressao, resultado: await debugManager.require().evaluate(expressao) }))
);

server.registerTool(
  "tds_debug_watch",
  {
    title: "Depurar: watches",
    description:
      "Mantém a lista de expressões observadas: cada parada (tds_debug_wait/step) devolve o valor " +
      "atual delas em `watches` e aponta em `alteradas` o que mudou. Use expressões sem efeito " +
      "colateral (variáveis, campos, Len(...)).",
    inputSchema: {
      adicionar: z.array(z.string()).optional().default([]),
      remover: z.array(z.string()).optional().default([]),
      limpar: z.boolean().optional().default(false),
    },
  },
  safe(async ({ adicionar, remover, limpar }) => {
    const s = debugManager.require();
    s.touch();
    if (limpar) s.watches = [];
    s.watches = s.watches.filter((w) => !(remover ?? []).includes(w));
    for (const w of adicionar ?? []) if (!s.watches.includes(w)) s.watches.push(w);
    return jsonResult({ watches: s.watches });
  })
);

server.registerTool(
  "tds_debug_stop",
  {
    title: "Depurar: encerrar sessão",
    description:
      "Encerra a sessão de depuração: libera a thread no AppServer (uma thread parada em " +
      "breakpoint fica presa até o depurador sair) e fecha o navegador headless. Sempre chame " +
      "ao terminar. Sessões sem uso também encerram sozinhas após o tempo de inatividade.",
    inputSchema: {},
  },
  safe(async () => jsonResult({ encerrada: await debugManager.stop() }))
);

server.registerTool(
  "tds_run",
  {
    title: "Executar programa (sem depurar)",
    description:
      "Executa uma função no servidor/ambiente conectado, num SmartClient HTML invisível, e diz " +
      "como terminou: 'concluido', 'erro' (mensagem, fonte/linha e a tela de detalhes com pilha " +
      "e variáveis) ou 'tempoEsgotado' (ainda rodando ou esperando interação; vem o texto da tela " +
      "e os botões). Não devolve o valor de retorno da função. Para rotinas com tela, use " +
      "tds_debug_start no modo navegador. Pergunte ao usuário antes de executar num servidor.",
    inputSchema: {
      programa: z.string().min(1).describe("Função, como no SmartClient (ex.: u_zMinhaRotina)"),
      argumentos: z.array(z.string()).optional().describe("Parâmetros (chegam como caractere)"),
      timeoutSeg: z.number().min(5).max(600).optional().default(60),
    },
  },
  safe(async ({ programa, argumentos, timeoutSeg }) => {
    const t0 = Date.now();
    const { session: s } = await startDebug({ programa, argumentos, modo: "headless" });
    try {
      const fim = await s.waitForStop(timeoutSeg ?? 60);
      const duracaoSeg = Math.round((Date.now() - t0) / 100) / 10;
      if (fim.estado === "encerrado") {
        const erroLog = (fim.mensagens ?? []).find((m) => m.nivel === "ERROR");
        if (fim.erroDeExecucao || erroLog) {
          return jsonFailure({
            programa,
            resultado: "erro",
            duracaoSeg,
            erro: erroLog?.mensagem ?? fim.erroDeExecucao?.resumo,
            ...(fim.erroDeExecucao ? { detalhes: fim.erroDeExecucao.detalhes } : {}),
          });
        }
        return jsonResult({ programa, resultado: "concluido", duracaoSeg, mensagens: fim.mensagens });
      }
      const tela = (await s.browser?.screenText()) ?? "";
      const botoes = (await s.browser?.buttons()) ?? [];
      return jsonFailure({
        programa,
        resultado: "tempoEsgotado",
        duracaoSeg,
        tela: tela.slice(0, 4000),
        botoes,
        observacao: "Execução interrompida ao fim do prazo. Rotina com tela: use tds_debug_start modo navegador.",
      });
    } finally {
      await debugManager.stop();
    }
  })
);

// ---------------------------------------------------------------------------
// Auxiliares locais
// ---------------------------------------------------------------------------

function slugify_safe(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
}

/** Se o patch está dentro da árvore organizada, retorna a pasta do ticket. */
function dirIfManaged(patchFile: string): string | undefined {
  const dir = path.dirname(path.resolve(patchFile));
  const rel = path.relative(path.resolve(config.patchesRoot), dir);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? dir : undefined;
}

/** Fallback: .ptm mais recente da pasta criado após o início da geração. */
function findNewestPtm(dir: string, sinceIso: string): string | undefined {
  const since = new Date(sinceIso).getTime() - 5000;
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".ptm"))
    .map((f) => path.join(dir, f))
    .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .filter((c) => c.mtime >= since)
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.f;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Encerra a depuração antes de sair, para não deixar thread presa no AppServer
 * nem debugAdapter/Chromium órfãos. Vale para Ctrl+C e para o cliente MCP
 * fechando o stdio.
 */
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  void debugManager.stop().finally(() => {
    client?.dispose();
    process.exit(0);
  });
}
// Uma promise rejeitada sem tratamento (escrita num processo filho que acabou
// de morrer, por exemplo) encerraria o MCP inteiro: registra no stderr e segue.
process.on("unhandledRejection", (reason) => {
  console.error("tds-mcp: rejeição sem tratamento:", reason instanceof Error ? reason.stack : reason);
});
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

main().catch((err) => {
  console.error("Falha ao iniciar tds-mcp:", err);
  process.exit(1);
});
