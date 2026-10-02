/**
 * Aviso para breakpoint que o depurador TOTVS aceita (verificado) mas onde
 * nunca para: comentário, linha em branco, declaração de função e fechamento
 * de bloco. Lê o fonte local em CP1252 (latin1 preserva as colunas).
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * No AppServer 24.3 o depurador para em: `Local` (com ou sem valor),
 * atribuição, If, While/For (a cada volta), Case <cond>, Return. Não para em:
 * declaração de função, diretiva #, Else, EndIf, EndDo, Do Case, OtherWise,
 * EndCase, Begin/End Sequence, Next.
 */
const NON_STOP_LINE =
  /^(?:(?:user|static|main|template|project)\s+function|function|method|wsmethod|class|endclass|next|endif|enddo|endcase|end\s*(?:if|do|while|case|sequence|class)|else|otherwise|do\s+case|begin\s+sequence|#\s*\w+)\b/i;
/** `End` sozinho fecha bloco; `End Transaction` vira chamada (EndTran) e executa. */
const BARE_END = /^end\b(?!\s*(?:transaction|tran)\b)/i;

/**
 * Para cada linha, se ela inteira está dentro de comentário de bloco. Abre
 * `/*` só fora de string e antes de `//`.
 */
function blockCommentLines(source: string[]): boolean[] {
  const inBlock: boolean[] = [];
  let open = false;
  for (const line of source) {
    let wholly = open;
    let seenCode = false;
    let i = 0;
    while (i < line.length) {
      if (open) {
        const end = line.indexOf("*/", i);
        if (end < 0) break;
        open = false;
        i = end + 2;
        continue;
      }
      const ch = line[i];
      if (ch === '"' || ch === "'") {
        const close = line.indexOf(ch, i + 1);
        seenCode = true;
        i = close < 0 ? line.length : close + 1;
        continue;
      }
      if (line.startsWith("//", i)) break;
      if (line.startsWith("/*", i)) {
        open = true;
        i += 2;
        continue;
      }
      if (!/\s/.test(ch)) seenCode = true;
      i++;
    }
    if (seenCode) wholly = false;
    else if (!wholly && /^\s*\/\*/.test(line)) wholly = true;
    inBlock.push(wholly);
  }
  return inBlock;
}

export function breakpointLineWarnings(file: string, lines: number[]): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "latin1");
  } catch {
    return [];
  }
  const source = text.split(/\r?\n/);
  const inBlock = blockCommentLines(source);
  const avisos: string[] = [];
  for (const n of lines) {
    const content = (source[n - 1] ?? "").trim();
    let motivo: string | undefined;
    if (n > source.length) motivo = "a linha não existe no arquivo local";
    else if (!content) motivo = "linha em branco";
    else if (inBlock[n - 1] || content.startsWith("//") || content.startsWith("*")) motivo = "comentário";
    else if (NON_STOP_LINE.test(content) || BARE_END.test(content)) {
      motivo = `"${content.slice(0, 40)}" não é instrução executada`;
    }
    if (motivo) {
      avisos.push(
        `${path.basename(file)}:${n} — ${motivo}; o depurador aceita o breakpoint mas não para nela. ` +
          `Use uma linha com instrução (atribuição, chamada, If, Return).`
      );
    }
  }
  return avisos;
}

