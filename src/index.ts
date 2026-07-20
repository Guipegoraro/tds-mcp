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

import { AdvplsClient, resolveAdvplsPath, type CompileOptions } from "./advpls.js";
import { compileVerdict, RETURN_CODE_HINTS } from "./verdict.js";
import { loadConfig, configFilePath } from "./config.js";
import {
  SessionManager,
  readServersJson,
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

const ADVPL_SOURCE_EXT = [".prw", ".prx", ".prg", ".tlpp", ".aph", ".ahu", ".apl", ".apw", ".4gl"];

const config = loadConfig();
let client: AdvplsClient | undefined;
let session: SessionManager | undefined;

/** Inicializa o advpls sob demanda (primeira tool que precisar). */
async function ensureClient(): Promise<{ client: AdvplsClient; session: SessionManager }> {
  if (client && client.alive && session) return { client, session };
  const advplsPath = resolveAdvplsPath(config.advplsPath);
  client = await AdvplsClient.start(advplsPath);
  session = new SessionManager(client, config);
  return { client, session };
}

function toFileUri(p: string): string {
  return URI.file(p).toString();
}

function isAdvplSource(file: string): boolean {
  return ADVPL_SOURCE_EXT.includes(path.extname(file).toLowerCase());
}

/** Expande caminhos: arquivos diretos + varredura recursiva de pastas. */
function expandFiles(inputs: string[]): string[] {
  const result: string[] = [];
  for (const input of inputs) {
    const stat = fs.statSync(input, { throwIfNoEntry: false });
    if (!stat) throw new Error(`Arquivo/pasta não encontrado: ${input}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(input, { recursive: true, encoding: "utf-8" })) {
        const full = path.join(input, entry);
        if (fs.statSync(full).isFile() && isAdvplSource(full)) result.push(full);
      }
    } else {
      result.push(input);
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

/** Monta o request de compilação com sessão/includes/autorização atuais. */
async function runCompilation(files: string[], options: CompileOptions) {
  const { client, session } = await ensureClient();
  const active = session.required();
  const cfg = readServersJson();
  const includes = effectiveIncludes(cfg, active.def);
  if (includes.length === 0) {
    throw new Error("Nenhuma pasta de includes configurada (servers.json).");
  }

  const expanded = expandFiles(files);
  if (expanded.length === 0) throw new Error("Nenhum fonte a compilar.");

  // Marca o ponto do log: o advpls reporta falhas de build (ex.: a dica de
  // BuildKillUsers no COMPILEERROR-300) por notificação, não na resposta.
  const logMark = client.serverLog.length;

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
  const verdict = compileVerdict(result);
  const logDaOperacao = client.serverLog.slice(logMark);
  return { active, expanded, result, verdict, logDaOperacao };
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
      "Tenta o token de reconexão salvo pelo TDS; se falhar, usa credenciais de ~/.tds-mcp/config.json.",
    inputSchema: {
      servidor: z.string().describe("Nome (ou parte do nome) do servidor no servers.json"),
      ambiente: z.string().optional().describe("Ambiente; padrão: o último usado no TDS"),
    },
  },
  safe(async ({ servidor, ambiente }) => {
    const { session } = await ensureClient();
    const active = await session.useServer(servidor, ambiente);
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
      "RPO). (b) falha de FONTE: itens com status ERROR/FATAL em `resultados`. Nunca conclua " +
      "sucesso apenas por não haver erros em `resultados`. Em falha, `logDoServidor` traz as " +
      "mensagens do AppServer. ATENÇÃO ao status SKIPPED: o fonte foi ignorado por já estar " +
      "atualizado no RPO — é sucesso, mas NADA foi gravado; confira `ignorados` e o campo " +
      "`aviso` antes de afirmar que compilou.",
    inputSchema: {
      arquivos: z.array(z.string()).min(1).describe("Caminhos de fontes ou pastas"),
      recompile: z.boolean().optional().default(false).describe("Forçar recompilação"),
    },
  },
  safe(async ({ arquivos, recompile }) => {
    const options = defaultCompileOptions();
    options.recompile = recompile ?? false;
    const { active, expanded, verdict, logDaOperacao } = await runCompilation(arquivos, options);
    const payload = {
      servidor: active.def.name,
      ambiente: active.environment,
      totalFontes: expanded.length,
      sucesso: verdict.sucesso,
      returnCode: verdict.returnCode,
      ...(verdict.falhaDeBuild ? { falhaDeBuild: verdict.falhaDeBuild } : {}),
      ...(verdict.aviso ? { aviso: verdict.aviso } : {}),
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
      "Compila com syntaxOnly: valida os fontes no servidor SEM commitar no RPO. " +
      "Sem efeito colateral — pode ser usada livremente antes de tds_compile. " +
      "Confie no campo `sintaxeOk`: ele considera tanto `returnCode` (falha de build) quanto " +
      "os status por fonte. Lista `resultados` vazia NÃO significa sucesso.",
    inputSchema: {
      arquivos: z.array(z.string()).min(1).describe("Caminhos de fontes ou pastas"),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ arquivos }) => {
    const options = defaultCompileOptions();
    options.syntaxOnly = true;
    const { active, expanded, verdict, logDaOperacao } = await runCompilation(arquivos, options);
    const payload = {
      servidor: active.def.name,
      ambiente: active.environment,
      totalFontes: expanded.length,
      sintaxeOk: verdict.sucesso,
      ...(verdict.sucesso ? {} : { logDoServidor: logDaOperacao }),
      returnCode: verdict.returnCode,
      ...(verdict.falhaDeBuild ? { falhaDeBuild: verdict.falhaDeBuild } : {}),
      ...(verdict.aviso ? { aviso: verdict.aviso } : {}),
      erros: verdict.erros.length,
      avisos: verdict.avisos.length,
      ignorados: verdict.ignorados.length,
      resultados: verdict.infos.map((i) => ({
        status: i.status,
        arquivo: i.filePath,
        mensagem: i.message,
        detalhe: i.detail,
      })),
    };
    return verdict.sucesso ? jsonResult(payload) : jsonFailure(payload);
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
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ arquivo }) => {
    const options = defaultCompileOptions();
    options.recompile = true;
    options.returnPpo = true;
    const { verdict } = await runCompilation([arquivo], options);
    const ppo = verdict.infos.find((i) => i.status === "APPRE");
    if (!ppo) {
      return jsonFailure({
        sucesso: false,
        returnCode: verdict.returnCode,
        ...(verdict.falhaDeBuild ? { falhaDeBuild: verdict.falhaDeBuild } : {}),
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
      limite: z.number().optional().default(100).describe("Máximo de itens retornados"),
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
      limite: z.number().optional().default(100).describe("Máximo de itens retornados"),
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
      ultimosPatches: z.number().optional().default(10).describe("Quantos patches do histórico retornar"),
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
      "(<raiz>/<cliente>/<ticket>/DDMMAA_HHMM_<slug>.ptm, datas no padrão brasileiro), manifesto JSON (sha256, fontes, " +
      "datas do RPO, servidor, autor, git) e histórico. Retorna também título e descrição " +
      "recomendados — o título começa com data e hora. No manifesto/retorno, rpoDate de cada " +
      "fonte é o mtime do arquivo-fonte na compilação (semântica de tds_rpo_objects), não o " +
      "instante da compilação.",
    inputSchema: {
      fontes: z
        .array(z.string())
        .min(1)
        .describe("Nomes dos objetos no RPO (ex.: TEC10R06.PRW). Devem já estar compilados."),
      cliente: z.string().describe("Nome do cliente (vira pasta)"),
      ticket: z.string().describe("Ticket/slug da demanda (vira pasta)"),
      descricao: z.string().optional().default("").describe("Motivo/resumo da alteração"),
      pastaFontesLocais: z
        .string()
        .optional()
        .describe("Pasta local dos fontes (para registrar commit git no manifesto)"),
    },
  },
  safe(async ({ fontes, cliente, ticket, descricao, pastaFontesLocais }) => {
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
    const slugBase = fontes.length === 1 ? path.parse(fontes[0]).name : slugify_safe(ticket);
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
      "Últimas mensagens emitidas pelo advpls nesta sessão (diagnóstico de conexão/compilação).",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  safe(async () => {
    return jsonResult({ log: client?.serverLog ?? [], configFile: configFilePath() });
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
  return dir.toLowerCase().startsWith(config.patchesRoot.toLowerCase()) ? dir : undefined;
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

process.on("SIGINT", () => {
  client?.dispose();
  process.exit(0);
});

main().catch((err) => {
  console.error("Falha ao iniciar tds-mcp:", err);
  process.exit(1);
});
