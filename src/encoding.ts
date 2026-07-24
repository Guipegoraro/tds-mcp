/**
 * Verificação de encoding dos fontes antes de compilar.
 *
 * O compilador Protheus só aceita fontes em Windows-1252 (CP1252). Um fonte
 * gravado em UTF-8 com acentos vai para o RPO com caracteres corrompidos —
 * às vezes SEM erro de compilação, o que é pior do que falhar.
 *
 * Como agentes de IA gravam em UTF-8 por padrão, esta checagem roda antes de
 * qualquer envio ao servidor.
 *
 * Regra de decisão:
 *  - Somente ASCII  -> seguro (idêntico nos dois encodings)
 *  - BOM UTF-8      -> bloqueia
 *  - UTF-8 válido com bytes não-ASCII -> bloqueia (quase certamente UTF-8)
 *  - Bytes não-ASCII que NÃO formam UTF-8 válido -> assume CP1252, segue
 *
 * Nada é convertido automaticamente: o arquivo do usuário nunca é alterado.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type EncodingKind = "ascii" | "utf8-bom" | "utf8" | "cp1252";

export interface EncodingCheck {
  file: string;
  kind: EncodingKind;
  /** true quando o arquivo pode ser enviado ao compilador com segurança. */
  safe: boolean;
}

/** Extensões cujo conteúdo é texto e passa pelo pré-processador/compilador. */
const TEXT_LIKE = new Set([
  ".prw", ".prx", ".prg", ".ppx", ".ppp", ".tlpp",
  ".apw", ".aph", ".apl", ".ahu", ".4gl", ".per", ".tres", ".js",
]);

export function isTextSource(file: string): boolean {
  return TEXT_LIKE.has(path.extname(file).toLowerCase());
}

export function detectEncoding(buf: Buffer): EncodingKind {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return "utf8-bom";
  }

  let hasHighByte = false;
  for (const byte of buf) {
    if (byte >= 0x80) {
      hasHighByte = true;
      break;
    }
  }
  if (!hasHighByte) return "ascii";

  // Bytes altos: se decodificam como UTF-8 estrito, o arquivo é UTF-8.
  // Sequências CP1252 (ex.: "ção" = E7 E3 ...) não formam UTF-8 válido.
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return "utf8";
  } catch {
    return "cp1252";
  }
}

export function checkFile(file: string): EncodingCheck {
  const kind = detectEncoding(fs.readFileSync(file));
  return { file, kind, safe: kind === "ascii" || kind === "cp1252" };
}

/** Verifica os fontes de texto da lista; recursos binários são ignorados. */
export function checkFiles(files: string[]): EncodingCheck[] {
  return files.filter(isTextSource).map(checkFile);
}

/** Mensagem de bloqueio, com o que fazer. Não altera nenhum arquivo. */
export function encodingErrorMessage(problems: EncodingCheck[]): string {
  const lista = problems
    .map((p) => `  - ${p.file} (${p.kind === "utf8-bom" ? "UTF-8 com BOM" : "UTF-8"})`)
    .join("\n");

  return (
    `Compilação bloqueada: ${problems.length} fonte(s) não estão em CP1252 (Windows-1252).\n` +
    `${lista}\n\n` +
    `O compilador Protheus só aceita CP1252. Compilar assim gravaria caracteres ` +
    `corrompidos no RPO, muitas vezes SEM erro de compilação.\n\n` +
    `Como resolver (o arquivo NÃO foi alterado):\n` +
    `  - Converta para CP1252 e compile de novo. Com o MCP file-tools: ` +
    `convert_encoding (to: cp1252); no VS Code: "Save with Encoding" -> Windows 1252.\n` +
    `  - Ao editar fontes AdvPL/TLPP, grave sempre em CP1252 para não repetir o problema.`
  );
}
