/**
 * Acento em expressão do depurador. O debugAdapter da TOTVS troca cada
 * caractere acima de 127 da expressão por "?" antes de mandar ao AppServer, e
 * a comparação com o texto acentuado dá falso sem erro. A expressão é recusada
 * com a forma em Chr() pronta: o código do Chr é o byte CP1252, que é como o
 * AppServer guarda o texto.
 */

const CP1252_ALTOS = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";

/** Byte CP1252 do caractere, ou undefined quando ele não existe no CP1252. */
function byteCp1252(c: string): number | undefined {
  const code = c.codePointAt(0)!;
  if (code < 0x80) return code;
  if (code >= 0xa0 && code <= 0xff) return code;
  const i = CP1252_ALTOS.indexOf(c);
  return i >= 0 && ![0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(0x80 + i) ? 0x80 + i : undefined;
}

/** Literal acentuado reescrito como concatenação, entre parênteses: ("A" + Chr(199) + "O"). */
function literalComChr(conteudo: string, aspas: string): string | undefined {
  const partes: string[] = [];
  let ascii = "";
  for (const c of conteudo) {
    if (c.codePointAt(0)! < 0x80) {
      ascii += c;
      continue;
    }
    const b = byteCp1252(c);
    if (b === undefined) return undefined;
    if (ascii) partes.push(aspas + ascii + aspas);
    ascii = "";
    partes.push(`Chr(${b})`);
  }
  if (ascii) partes.push(aspas + ascii + aspas);
  return `(${partes.join(" + ")})`;
}

/**
 * Mensagem de recusa para expressão com caractere não ASCII, ou undefined
 * quando ela não tem. Converte só literais entre aspas simples ou duplas; acento
 * fora deles (ou entre colchetes, que também são índice de array) e caractere
 * sem CP1252 ficam sem forma pronta.
 */
export function recusaAcento(expressao: string, onde: string): string | undefined {
  if (!/[^\x00-\x7f]/.test(expressao)) return undefined;
  let saida = "";
  let convertivel = true;
  let i = 0;
  while (i < expressao.length) {
    const c = expressao[i];
    if (c === '"' || c === "'") {
      const fim = expressao.indexOf(c, i + 1);
      if (fim < 0) {
        convertivel = false;
        break;
      }
      const conteudo = expressao.slice(i + 1, fim);
      if (/[^\x00-\x7f]/.test(conteudo)) {
        const conv = literalComChr(conteudo, c);
        if (!conv) convertivel = false;
        saida += conv ?? "";
      } else {
        saida += c + conteudo + c;
      }
      i = fim + 1;
      continue;
    }
    if (c.codePointAt(0)! >= 0x80) convertivel = false;
    saida += c;
    i++;
  }
  const base =
    `Recusado: ${onde} tem caractere acentuado ou especial (fora do ASCII), e o depurador da TOTVS o troca por "?" antes de ` +
    `chegar ao AppServer (a comparação daria falso sem erro).`;
  return convertivel
    ? `${base} Reenvie com o texto em Chr(), que já vem pronto: ${saida}`
    : `${base} Escreva o texto acentuado com Chr(<byte CP1252>), ex.: "A" + Chr(199) + Chr(195) + "O" para AÇÃO; ` +
        `só o texto entre aspas simples ou duplas tem conversão automática, e caractere fora do CP1252 não existe no AppServer.`;
}
