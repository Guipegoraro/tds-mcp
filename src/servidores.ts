/**
 * Cadastro de servidor no servers.json do TDS.
 *
 * Grava no mesmo formato que o TDS-VSCode usa ao adicionar um servidor, para que
 * tds_use_server e o VS Code enxerguem a entrada. O arquivo e o de
 * serversJsonPath() (override, workspace ou ~/.totvsls).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomInt } from "node:crypto";
import { hostDe, serversJsonPath, type TdsServerDef } from "./session.js";

export interface NovoServidor {
  nome: string;
  endereco: string;
  porta: number;
  ambientes: string[];
  segura?: boolean;
  includes?: string[];
}

/** Resposta da validacao do advpls ($totvsserver/validation). */
export interface ResultadoValidacao {
  build: string;
  secure: number | boolean;
}

export type ValidarServidor = (endereco: string, porta: number, tipo: string) => Promise<ResultadoValidacao>;

export interface OpcoesCadastro {
  /** Arquivo a alterar; padrao: o que serversJsonPath() resolve. */
  arquivo?: string;
  /** Acrescenta contexto a falha de validacao (ex.: se a porta aceita conexao). */
  explicarFalha?: (mensagem: string) => Promise<string>;
}

export interface ServidorCadastrado {
  id: string;
  nome: string;
  endereco: string;
  porta: number;
  build: string;
  segura: boolean;
  ambientes: string[];
  includes: string[];
  arquivo: string;
  backup: string;
  avisos: string[];
  proximoPasso: string;
}

const TIPO_PROTHEUS = "totvs_server_protheus";
const TAMANHO_ID = 30;
const ALFABETO_ID = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Id aleatorio em base 36, do mesmo tipo dos que o TDS gera (28 a 31 caracteres). */
export function gerarIdServidor(existentes: Iterable<string> = []): string {
  const usados = new Set(existentes);
  for (;;) {
    let id = "";
    for (let i = 0; i < TAMANHO_ID; i++) id += ALFABETO_ID[randomInt(ALFABETO_ID.length)];
    if (!usados.has(id)) return id;
  }
}

interface Formato {
  indentacao: string;
  quebra: string;
  bom: boolean;
  quebraNoFim: boolean;
}

/** Estilo do arquivo (indentacao, fim de linha, BOM, quebra final) para regravar sem reformatar. */
function detectarFormato(raw: string): Formato {
  const bom = raw.charCodeAt(0) === 0xfeff;
  const texto = bom ? raw.slice(1) : raw;
  const indentacao = /^\{\r?\n([ \t]+)"/.exec(texto)?.[1] ?? "\t";
  return { indentacao, quebra: texto.includes("\r\n") ? "\r\n" : "\n", bom, quebraNoFim: /\n$/.test(texto) };
}

function serializar(obj: unknown, f: Formato): string {
  let texto = JSON.stringify(obj, null, f.indentacao);
  if (f.quebra === "\r\n") texto = texto.replace(/\n/g, "\r\n");
  return (f.bom ? "﻿" : "") + texto + (f.quebraNoFim ? f.quebra : "");
}

interface Lido {
  raw: string;
  json: Record<string, unknown> & { configurations: TdsServerDef[] };
}

function lerArquivo(arquivo: string): Lido {
  let raw: string;
  try {
    raw = fs.readFileSync(arquivo, "utf-8");
  } catch (err) {
    const codigo = (err as NodeJS.ErrnoException).code;
    throw new Error(
      codigo === "ENOENT"
        ? `servers.json não encontrado em ${arquivo}. Conecte num servidor pelo VS Code uma vez (o TDS cria o arquivo) ` +
            "ou aponte TDS_MCP_SERVERS_JSON para o arquivo existente."
        : `Não foi possível ler ${arquivo}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    throw new Error(`${arquivo} não é JSON válido; nada foi alterado (${err instanceof Error ? err.message : String(err)}).`);
  }
  const obj = json as { configurations?: unknown };
  if (!json || typeof json !== "object" || Array.isArray(json) || !Array.isArray(obj.configurations)) {
    throw new Error(`${arquivo} não tem a lista "configurations"; nada foi alterado.`);
  }
  return { raw, json: json as Lido["json"] };
}

/** Servidor que ja ocupa o nome ou o par endereco+porta, com a mensagem dizendo qual. */
function conflito(configs: TdsServerDef[], nome: string, endereco: string, porta: number): string | undefined {
  const nomeChave = nome.toLowerCase();
  const hostChave = hostDe(endereco).toLowerCase();
  for (const s of configs) {
    if (typeof s?.name === "string" && s.name.toLowerCase() === nomeChave) {
      return `Já existe o servidor "${s.name}" (${s.address}:${s.port}) com o mesmo nome. Nada foi gravado.`;
    }
  }
  for (const s of configs) {
    if (typeof s?.address === "string" && hostDe(s.address).toLowerCase() === hostChave && Number(s.port) === porta) {
      return `Já existe o servidor "${s.name}" no mesmo endereço e porta (${s.address}:${s.port}). Nada foi gravado.`;
    }
  }
  return undefined;
}

function unicos(lista: string[]): string[] {
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const item of lista.map((i) => i.trim()).filter(Boolean)) {
    const chave = item.toLowerCase();
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(item);
  }
  return saida;
}

function nomeDoBackup(arquivo: string, agora: Date): string {
  const p = (n: number, t = 2) => String(n).padStart(t, "0");
  const carimbo =
    `${agora.getFullYear()}${p(agora.getMonth() + 1)}${p(agora.getDate())}` +
    `-${p(agora.getHours())}${p(agora.getMinutes())}${p(agora.getSeconds())}-${p(agora.getMilliseconds(), 3)}`;
  return `${arquivo}.tds-mcp-${carimbo}.bak`;
}

/** Copia o arquivo ao lado dele sem sobrescrever backup anterior (mesmo instante ganha sufixo). */
function copiarBackup(arquivo: string): string {
  const base = nomeDoBackup(arquivo, new Date());
  for (let n = 1; ; n++) {
    const destino = n === 1 ? base : base.replace(/\.bak$/, `-${n}.bak`);
    try {
      fs.copyFileSync(arquivo, destino, fs.constants.COPYFILE_EXCL);
      return destino;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

/** Grava por arquivo temporario na mesma pasta + rename, para nao deixar o arquivo pela metade. */
function gravarAtomico(arquivo: string, conteudo: string): void {
  const temp = path.join(path.dirname(arquivo), `${path.basename(arquivo)}.tds-mcp-${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, conteudo, "utf-8");
    fs.renameSync(temp, arquivo);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * Arquivo a alterar: o que serversJsonPath() resolve. Com TDS_MCP_SERVERS_JSON apontando para um
 * arquivo que nao existe, a leitura cai no servers.json do workspace ou do usuario; gravar la
 * seria alterar um arquivo que o chamador nao indicou.
 */
function arquivoParaGravar(): string {
  const arquivo = serversJsonPath();
  const override = process.env.TDS_MCP_SERVERS_JSON;
  if (override && path.resolve(override) !== path.resolve(arquivo)) {
    throw new Error(`TDS_MCP_SERVERS_JSON aponta para ${override}, que não existe. Nada foi gravado.`);
  }
  return arquivo;
}

/**
 * Valida o servidor no AppServer e o acrescenta em `configurations`. Nada e gravado
 * se houver duplicata ou se a validacao falhar. As demais entradas e as chaves do
 * topo seguem como estavam.
 */
export async function cadastrarServidor(
  entrada: NovoServidor,
  validar: ValidarServidor,
  opcoes: OpcoesCadastro = {}
): Promise<ServidorCadastrado> {
  const nome = entrada.nome.trim();
  const endereco = entrada.endereco.trim();
  const ambientes = unicos(entrada.ambientes);
  if (!nome) throw new Error("Informe o nome do servidor.");
  if (!endereco) throw new Error("Informe o endereço do servidor.");
  if (!Number.isInteger(entrada.porta) || entrada.porta < 1 || entrada.porta > 65535) {
    throw new Error(`Porta inválida: ${entrada.porta}. Use um inteiro de 1 a 65535.`);
  }
  if (ambientes.length === 0) throw new Error("Informe ao menos um ambiente.");

  const arquivo = opcoes.arquivo ?? arquivoParaGravar();
  const { raw: rawInicial, json: jsonInicial } = lerArquivo(arquivo);
  const duplicado = conflito(jsonInicial.configurations, nome, endereco, entrada.porta);
  if (duplicado) throw new Error(duplicado);

  let validacao: ResultadoValidacao;
  try {
    validacao = await validar(endereco, entrada.porta, TIPO_PROTHEUS);
    if (!validacao?.build) throw new Error("a validação não devolveu a versão do build");
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    const base = `O servidor ${endereco}:${entrada.porta} não respondeu à validação (${detalhe}). Nada foi gravado.`;
    const explicada = opcoes.explicarFalha ? await opcoes.explicarFalha(base) : base;
    throw new Error(
      `${explicada} No TCloud o servidor de debug só responde com o modo debug ligado: confira se ele está ativo ` +
        "e se a porta é a do servidor de debug (o portal mostra os dois; no MCP tcloud, tcloud_servidor_debug)."
    );
  }
  const segura = !!validacao.secure;
  const avisos: string[] = [];
  if (entrada.segura !== undefined && entrada.segura !== segura) {
    avisos.push(
      `Foi informado segura=${entrada.segura}, mas a validação do servidor indica conexão ${segura ? "segura (SSL)" : "não segura"}; ` +
        "foi gravado o valor da validação."
    );
  }

  // O arquivo e relido depois da validacao (que demora): o VS Code pode ter gravado nesse intervalo.
  const { raw, json } = lerArquivo(arquivo);
  if (raw !== rawInicial) {
    const depois = conflito(json.configurations, nome, endereco, entrada.porta);
    if (depois) throw new Error(depois);
  }

  const globais = Array.isArray(json.includes) ? (json.includes as unknown[]).filter((i): i is string => typeof i === "string" && !!i) : [];
  const informados = unicos(entrada.includes ?? []);
  const includes = informados.length ? informados : globais;
  if (includes.length === 0) {
    avisos.push("Nenhuma pasta de includes (nem informada, nem global no servers.json): a compilação vai recusar até configurar.");
  }

  const id = gerarIdServidor(json.configurations.map((s) => s?.id).filter((i): i is string => typeof i === "string"));
  const nova: TdsServerDef = {
    id,
    type: TIPO_PROTHEUS,
    name: nome,
    port: entrada.porta,
    address: endereco,
    buildVersion: validacao.build,
    secure: segura,
    includes,
    environments: ambientes,
  };
  json.configurations.push(nova);

  const backup = copiarBackup(arquivo);
  gravarAtomico(arquivo, serializar(json, detectarFormato(raw)));

  return {
    id,
    nome,
    endereco,
    porta: entrada.porta,
    build: validacao.build,
    segura,
    ambientes,
    includes,
    arquivo,
    backup,
    avisos,
    proximoPasso:
      "A primeira conexão precisa de login: tds_use_server com usuario e senha, ou conecte uma vez pelo VS Code " +
      "(o TDS guarda o token de reconexão).",
  };
}
