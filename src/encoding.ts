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
 *  - BOM UTF-16 ou bytes NUL -> bloqueia (UTF-16, saída padrão do Out-File)
 *  - Bytes não-ASCII que NÃO formam UTF-8 válido, mas contêm sequências UTF-8
 *    de letra acentuada (C3 xx / C2 xx) -> bloqueia (misto: trecho UTF-8
 *    gravado num fonte CP1252)
 *  - Demais bytes não-ASCII -> assume CP1252, segue
 *
 * Nada é convertido automaticamente: o arquivo do usuário nunca é alterado.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type EncodingKind = "ascii" | "utf8-bom" | "utf8" | "utf16" | "misto" | "cp1252";

export interface EncodingCheck {
  file: string;
  kind: EncodingKind;
  /** true quando o arquivo pode ser enviado ao compilador com segurança. */
  safe: boolean;
  /** Linhas (1 = primeira) com sequência UTF-8 num fonte misto. */
  linhasUtf8?: number[];
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
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    return "utf16";
  }
  if (buf.includes(0)) return "utf16";

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
    return utf8AccentLines(buf).length > 0 ? "misto" : "cp1252";
  }
}

/**
 * Linhas gravadas em UTF-8 num fonte CP1252: a linha tem sequência UTF-8 de
 * letra acentuada latina (C3 seguido de 80-BF, À-ÿ; ou C2 seguido de A0-BF,
 * símbolos) e decodifica inteira como UTF-8. Uma linha que também tem acento
 * CP1252 de verdade, como `StrTran(cTxt, "Ã§", "ç")` em rotina que converte
 * UTF-8, não decodifica como UTF-8 e não conta.
 */
export function utf8AccentLines(buf: Buffer): number[] {
  const linhas: number[] = [];
  const strict = new TextDecoder("utf-8", { fatal: true });
  let inicio = 0;
  for (let n = 1; inicio <= buf.length; n++) {
    let fim = buf.indexOf(0x0a, inicio);
    if (fim < 0) fim = buf.length;
    const linha = buf.subarray(inicio, fim);
    if (hasUtf8Accent(linha)) {
      try {
        strict.decode(linha);
        linhas.push(n);
      } catch {
        /* tem byte CP1252 fora de sequência UTF-8: linha CP1252 legítima */
      }
    }
    inicio = fim + 1;
  }
  return linhas;
}

function hasUtf8Accent(linha: Buffer): boolean {
  for (let i = 0; i + 1 < linha.length; i++) {
    const b = linha[i];
    const next = linha[i + 1];
    if ((b === 0xc3 && next >= 0x80 && next <= 0xbf) || (b === 0xc2 && next >= 0xa0 && next <= 0xbf)) return true;
  }
  return false;
}

/**
 * @param aceitarMisto Libera o fonte "misto": o usuário confirmou que as
 *   linhas apontadas são intencionais (ex.: tabela de conversão de UTF-8).
 */
export function checkFile(file: string, aceitarMisto = false): EncodingCheck {
  const buf = fs.readFileSync(file);
  const kind = detectEncoding(buf);
  return {
    file,
    kind,
    safe: kind === "ascii" || kind === "cp1252" || (kind === "misto" && aceitarMisto),
    ...(kind === "misto" ? { linhasUtf8: utf8AccentLines(buf) } : {}),
  };
}

const KIND_LABEL: Record<EncodingKind, string> = {
  ascii: "ASCII",
  "utf8-bom": "UTF-8 com BOM",
  utf8: "UTF-8",
  utf16: "UTF-16",
  misto: "CP1252 com trechos em UTF-8",
  cp1252: "CP1252",
};

/** Verifica os fontes de texto da lista; recursos binários são ignorados. */
export function checkFiles(files: string[], aceitarMisto = false): EncodingCheck[] {
  return files.filter(isTextSource).map((f) => checkFile(f, aceitarMisto));
}

/** Mensagem de bloqueio, com o que fazer. Não altera nenhum arquivo. */
export function encodingErrorMessage(problems: EncodingCheck[]): string {
  const lista = problems
    .map((p) => {
      const linhas = p.linhasUtf8?.length
        ? `; UTF-8 nas linhas ${p.linhasUtf8.slice(0, 10).join(", ")}${p.linhasUtf8.length > 10 ? "..." : ""}`
        : "";
      return `  - ${p.file} (${KIND_LABEL[p.kind]}${linhas})`;
    })
    .join("\n");

  const temMisto = problems.some((p) => p.kind === "misto");
  return (
    `Compilação bloqueada: ${problems.length} fonte(s) não estão em CP1252 (Windows-1252).\n` +
    `${lista}\n\n` +
    `O compilador Protheus só aceita CP1252. Compilar assim gravaria caracteres ` +
    `corrompidos no RPO, muitas vezes SEM erro de compilação.\n\n` +
    `Como resolver (o arquivo NÃO foi alterado):\n` +
    (temMisto
      ? `  - Fonte misto: regrave em CP1252 só as linhas indicadas; converter o arquivo ` +
        `inteiro como se fosse UTF-8 corromperia os acentos que já estão certos.\n` +
        `  - Se essas linhas têm a sequência UTF-8 de propósito (ex.: tabela de conversão ` +
        `de UTF-8), mostre-as ao usuário e, com a confirmação dele, repita com aceitarMisto: true.\n`
      : "") +
    `  - Converta para CP1252 e compile de novo. Com o MCP file-tools: ` +
    `convert_encoding (to: cp1252); no VS Code: "Save with Encoding" -> Windows 1252.\n` +
    `  - Ao editar fontes AdvPL/TLPP, grave sempre em CP1252 para não repetir o problema.`
  );
}
