/**
 * Registro dos fontes que o tds-mcp compilou como temporários (wrappers e
 * fontes de teste), por servidor e ambiente. É a trava do tds_rpo_delete: só
 * o que está aqui sai do RPO sem liberação explícita do usuário.
 *
 * Fica em ~/.claude/tds-mcp/temporarios.json, um arquivo só para todos os
 * projetos: o wrapper criado no scratchpad de uma sessão precisa ser achado
 * por outra sessão, depois.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const TEMPORARIOS_FILE = path.join(os.homedir(), ".claude", "tds-mcp", "temporarios.json");

export interface Temporario {
  /** Nome do servidor no servers.json. */
  servidor: string;
  ambiente: string;
  /** Nome do fonte como o RPO registra (nome do arquivo em maiúsculas). */
  fonte: string;
  /** Caminho local de onde foi compilado. */
  arquivo: string;
  compiladoEm: string;
}

/**
 * Prefixo do nome de wrapper desta pessoa nesta máquina: "zT" + 3 caracteres
 * derivados de usuário@máquina, estável entre sessões. Com 3 letras da rotina
 * o nome tem 8 caracteres: "U_" + 8 são os 10 que o AdvPL considera no nome
 * de função, e wrappers de desenvolvedores diferentes não colidem no RPO.
 */
export function prefixoWrapper(usuario = os.userInfo().username, maquina = os.hostname()): string {
  const chave = `${usuario}@${maquina}`.toLowerCase();
  let h = 0;
  for (const c of chave) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  return "zT" + (h % 36 ** 3).toString(36).toUpperCase().padStart(3, "0");
}

export function nomeNoRpo(arquivo: string): string {
  return path.basename(arquivo).toUpperCase();
}

const mesmoLugar = (t: Temporario, servidor: string, ambiente: string) =>
  t.servidor.toLowerCase() === servidor.toLowerCase() && t.ambiente.toLowerCase() === ambiente.toLowerCase();

export function loadTemporarios(file = TEMPORARIOS_FILE): Temporario[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error(`${file} não contém uma lista de temporários.`);
  return data as Temporario[];
}

/** Grava num arquivo ao lado e renomeia: uma falha no meio não deixa o registro pela metade. */
function save(lista: Temporario[], file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lista, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function temporariosDe(servidor: string, ambiente: string, file = TEMPORARIOS_FILE): Temporario[] {
  return loadTemporarios(file).filter((t) => mesmoLugar(t, servidor, ambiente));
}

/**
 * Atualiza o registro com o resultado de uma compilação: com `temporario`, os
 * fontes entram (ou têm a data renovada); sem ele, saem — a última compilação
 * diz o que o fonte é.
 */
export function registrarCompilacao(
  servidor: string,
  ambiente: string,
  arquivos: string[],
  temporario: boolean,
  file = TEMPORARIOS_FILE
): void {
  if (arquivos.length === 0) return;
  const nomes = new Set(arquivos.map(nomeNoRpo));
  const antes = loadTemporarios(file);
  const lista = antes.filter((t) => !(mesmoLugar(t, servidor, ambiente) && nomes.has(t.fonte)));
  if (!temporario && lista.length === antes.length) return;
  if (temporario) {
    const agora = new Date().toISOString();
    for (const arquivo of arquivos) {
      lista.push({ servidor, ambiente, fonte: nomeNoRpo(arquivo), arquivo: path.resolve(arquivo), compiladoEm: agora });
    }
  }
  save(lista, file);
}

export function removerTemporarios(servidor: string, ambiente: string, fontes: string[], file = TEMPORARIOS_FILE): void {
  const nomes = new Set(fontes.map(nomeNoRpo));
  const antes = loadTemporarios(file);
  const depois = antes.filter((t) => !(mesmoLugar(t, servidor, ambiente) && nomes.has(t.fonte)));
  if (depois.length !== antes.length) save(depois, file);
}
