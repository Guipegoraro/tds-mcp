/**
 * Aviso para breakpoint que o depurador TOTVS aceita (verificado) mas onde
 * nunca para: comentário, linha em branco, declaração de função e fechamento
 * de bloco. Lê o fonte local em CP1252 (latin1 preserva as colunas).
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Medido no AppServer 24.3: param `Local` (com ou sem valor), atribuição, If,
 * While/For (a cada volta), Case <cond>, Return. Não param: declaração de
 * função, diretiva #, Else, EndIf, EndDo, Do Case, OtherWise, EndCase,
 * Begin/End Sequence, Next.
 */
const NON_STOP_LINE =
  /^(?:(?:user|static|main|template|project)\s+function|function|method|wsmethod|class|endclass|next|endif|enddo|endcase|end\s*(?:if|do|while|case|sequence|class)?|else|otherwise|do\s+case|begin\s+sequence|#\s*\w+)\b/i;

export function breakpointLineWarnings(file: string, lines: number[]): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "latin1");
  } catch {
    return [];
  }
  const source = text.split(/\r?\n/);
  // Marca linhas dentro de comentário de bloco /* ... */
  const inBlock: boolean[] = [];
  let open = false;
  for (const raw of source) {
    let line = raw;
    let whollyComment = open;
    if (!open && /^\s*\/\*/.test(line)) whollyComment = true;
    while (line.length) {
      if (open) {
        const end = line.indexOf("*/");
        if (end < 0) break;
        open = false;
        line = line.slice(end + 2);
        if (line.trim()) whollyComment = false;
      } else {
        const start = line.indexOf("/*");
        if (start < 0) break;
        open = true;
        line = line.slice(start + 2);
      }
    }
    inBlock.push(whollyComment);
  }
  const avisos: string[] = [];
  for (const n of lines) {
    const content = (source[n - 1] ?? "").trim();
    let motivo: string | undefined;
    if (n > source.length) motivo = "a linha não existe no arquivo local";
    else if (!content) motivo = "linha em branco";
    else if (inBlock[n - 1] || content.startsWith("//") || content.startsWith("*")) motivo = "comentário";
    else if (NON_STOP_LINE.test(content)) motivo = `"${content.slice(0, 40)}" não é instrução executada`;
    if (motivo) {
      avisos.push(
        `${path.basename(file)}:${n} — ${motivo}; o depurador aceita o breakpoint mas não para nela. ` +
          `Use uma linha com instrução (atribuição, chamada, If, Return).`
      );
    }
  }
  return avisos;
}

