/**
 * Colisão de nomes de função no AdvPL: o RPO identifica Function e User
 * Function pelos 10 primeiros caracteres do nome, contando o "U_" que a User
 * Function ganha (User Function ZPVCRED vira U_ZPVCRED). Duas funções que só
 * diferem depois disso colidem sem erro nem aviso do compilador, e o sintoma
 * costuma ser "invalid typecast" em quem chama. Nome longo só existe no TLPP,
 * e uma chamada a partir de .prw usa os 10 primeiros caracteres mesmo assim.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Caracteres do nome que o RPO guarda para função AdvPL. */
export const CARACTERES_DO_NOME = 10;

/** Function / User Function / Main Function no início da linha; Static Function não entra (escopo do fonte). */
const DECLARACAO = /^[ \t]*(user[ \t]+|main[ \t]+)?function[ \t]+(\w+)/gim;

export interface FuncaoDeclarada {
  arquivo: string;
  /** Nome como o RPO registra: com U_ na User Function, em maiúsculas. */
  nome: string;
}

/** Tira comentários // e /* *\/ para não pegar declaração comentada. */
function semComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Funções públicas declaradas no fonte; fonte TLPP com namespace fica de fora (o nome inclui o namespace). */
export function funcoesDeclaradas(arquivo: string, texto: string): FuncaoDeclarada[] {
  const limpo = semComentarios(texto);
  if (/\.tlpp$/i.test(arquivo) && /^[ \t]*namespace[ \t]+\w/im.test(limpo)) return [];
  const lista: FuncaoDeclarada[] = [];
  for (const m of limpo.matchAll(DECLARACAO)) {
    const user = /^user/i.test(m[1] ?? "");
    lista.push({ arquivo, nome: `${user ? "U_" : ""}${m[2]}`.toUpperCase() });
  }
  return lista;
}

/**
 * Avisos de funções do lote que coincidem nos 10 primeiros caracteres com nome
 * diferente. Fonte que não pôde ser lido fica de fora.
 */
export function colisoesDeNome(arquivos: string[]): string[] {
  const porChave = new Map<string, FuncaoDeclarada[]>();
  for (const arquivo of arquivos) {
    if (!/\.(prw|prx|tlpp)$/i.test(arquivo)) continue;
    let texto: string;
    try {
      texto = fs.readFileSync(arquivo, "latin1");
    } catch {
      continue;
    }
    for (const f of funcoesDeclaradas(arquivo, texto)) {
      const chave = f.nome.slice(0, CARACTERES_DO_NOME);
      const lista = porChave.get(chave) ?? [];
      if (!lista.some((g) => g.nome === f.nome && g.arquivo === f.arquivo)) lista.push(f);
      porChave.set(chave, lista);
    }
  }
  const avisos: string[] = [];
  for (const [chave, lista] of porChave) {
    const nomes = new Set(lista.map((f) => f.nome));
    if (nomes.size < 2) continue;
    const quem = lista.map((f) => `${f.nome} (${path.basename(f.arquivo)})`).join(", ");
    // Nome longo de TLPP fica inteiro no RPO; quem trunca é a chamada a partir de .prw. Dois
    // AdvPL no grupo, ou um TLPP com nome de até 10 caracteres, colidem no RPO de verdade.
    const tlpp = lista.filter((f) => /\.tlpp$/i.test(f.arquivo));
    const comTlpp =
      tlpp.length > 0 && lista.length - tlpp.length <= 1 && tlpp.every((f) => f.nome.length > CARACTERES_DO_NOME);
    avisos.push(
      `${quem} coincidem nos ${CARACTERES_DO_NOME} primeiros caracteres (${chave}): ` +
        (comTlpp
          ? "o nome longo do TLPP fica inteiro no RPO, mas uma chamada a partir de .prw usa só os " +
            `${CARACTERES_DO_NOME} primeiros e pode cair na função errada. `
          : "no RPO valem como a mesma função, sem erro do compilador. ") +
        "Encurte um dos nomes."
    );
  }
  return avisos;
}
