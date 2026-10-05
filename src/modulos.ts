/**
 * Execução de rotina dentro de um módulo do Protheus pelo programa inicial
 * SIGABPM: depois do login, ele abre a rotina direto no módulo, sem passar
 * pelo menu, com o ambiente que o usuário teria no SIGAMDI (empresa, filial,
 * data base, variáveis do módulo). Recebe só dois parâmetros, o código do
 * módulo e a rotina: a rotina é chamada sem argumentos (TDN "3.0 Como invocar
 * uma rotina do Microsiga Protheus").
 */

/** Código do módulo -> sufixo do nome SIGAxxx (referência TOTVS, MCP advpl-tlpp-mcp-docs). */
export const MODULOS: Record<string, string> = {
  "01": "ATF",
  "02": "COM",
  "04": "EST",
  "05": "FAT",
  "06": "FIN",
  "07": "GPE",
  "09": "FIS",
  "10": "PCP",
  "11": "VEI",
  "12": "LOJA",
  "13": "TMK",
  "14": "OFI",
  "16": "PON",
  "17": "EIC",
  "18": "TCF",
  "19": "MNT",
  "20": "RSP",
  "21": "QIE",
  "22": "QMT",
  "23": "FRT",
  "24": "QDO",
  "25": "QIP",
  "26": "TRM",
  "28": "TEC",
  "29": "EEC",
  "30": "EFF",
  "31": "ECO",
  "33": "PLS",
  "34": "CTB",
  "35": "MDT",
  "36": "QNC",
  "37": "QAD",
  "39": "OMS",
  "40": "CSA",
  "41": "PEC",
  "42": "WMS",
  "43": "TMS",
  "44": "PMS",
  "45": "CDA",
  "47": "PPAP",
  "48": "REP",
  "50": "EDC",
};

/** Código de dois dígitos a partir de "4", "04", "SIGAEST" ou "EST". */
export function resolveModulo(valor: string): string {
  const v = valor.trim().toUpperCase();
  if (/^\d{1,2}$/.test(v) && Number(v) >= 1) return v.padStart(2, "0");
  const sufixo = v.replace(/^SIGA/, "");
  const hit = Object.entries(MODULOS).find(([, nome]) => nome === sufixo);
  if (hit) return hit[0];
  throw new Error(
    `Módulo "${valor}" não reconhecido. Informe o código numérico do módulo (ex.: 04 = SIGAEST, ` +
      `05 = SIGAFAT, 06 = SIGAFIN, 02 = SIGACOM, 10 = SIGAPCP).`
  );
}

/**
 * Programa inicial e argumentos que vão para o webapp. Com `modulo`, a rotina
 * roda pelo SIGABPM; sem ele, a função é o próprio programa inicial.
 */
export function programaInicial(
  programa: string,
  argumentos: string[],
  modulo?: string
): { programa: string; argumentos: string[]; codigoModulo?: string } {
  const rotina = programa.trim();
  if (/^SIGA[A-Z0-9]+$/i.test(rotina)) {
    throw new Error(
      `"${rotina}" é programa de módulo, não a rotina. Informe a rotina em programa (ex.: u_zMinhaRotina) ` +
        `e o módulo em modulo (ex.: "04"); o tds-mcp abre pelo SIGABPM.`
    );
  }
  if (!modulo) return { programa: rotina, argumentos };
  if (argumentos.length) {
    throw new Error(
      "Com modulo a rotina é chamada pelo SIGABPM sem argumentos: retire argumentos, ou rode sem modulo " +
        "(a função como programa inicial recebe os argumentos, mas sem o ambiente do módulo)."
    );
  }
  const codigoModulo = resolveModulo(modulo);
  return { programa: "SIGABPM", argumentos: [codigoModulo, rotina], codigoModulo };
}
