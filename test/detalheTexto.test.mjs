// Teste do detalhe de texto do depurador (charDetails) com um adaptador falso — não precisa de AppServer.
// As respostas imitam as do tds-da 1.4.2 com extendFeatures.charDetails ligado no launch.
// Uso: node test/detalheTexto.test.mjs
import assert from "node:assert/strict";
import { DebugSession, extrasDoLaunch } from "../dist/debug.js";

let falhas = 0;
function check(nome, condicao, detalhe = "") {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}

const BYTES = ["a [0x61] [97]", "ç [0xe7] [231]", "ã [0xe3] [227]", "o [0x6f] [111]"];

/** Adaptador falso: com charDetails, string é expansível em Raw, Length e o bloco de bytes. */
function adaptadorFalso({ charDetails, nBytes = 4, raw = '"ação"', falha }) {
  const pedidos = [];
  const bytes = Array.from({ length: nBytes }, (_, i) => BYTES[i % 4]);
  const dap = {
    alive: true,
    internalLog: "",
    events: [],
    logsSince: () => [],
    async request(command, args) {
      pedidos.push({ command, args });
      if (falha && command === "variables" && args.variablesReference === falha) return { success: false, message: "timeout" };
      switch (command) {
        case "stackTrace":
          return { success: true, body: { stackFrames: [{ id: 7, name: "U_ZTST", source: { path: "x.prw" }, line: 3 }] } };
        case "scopes":
          return { success: true, body: { scopes: [{ name: "Local", variablesReference: 100 }] } };
        case "variables":
          if (args.variablesReference === 100) {
            return {
              success: true,
              body: {
                variables: [
                  { name: "CNOME", type: "C", value: '"ação"', variablesReference: charDetails ? 200 : -1 },
                  { name: "AITENS", type: "A", value: "Array {size=1}", variablesReference: 300 },
                ],
              },
            };
          }
          if (args.variablesReference === 200) {
            return {
              success: true,
              body: {
                variables: [
                  { name: "Raw", type: "C", value: raw, variablesReference: -1 },
                  { name: "Length", type: "N", value: String(nBytes), variablesReference: -1 },
                  { name: "CNOME (ascii)", type: "_CHAR_BLOCK_", value: `(${nBytes} bytes)`, variablesReference: 201 },
                ],
              },
            };
          }
          if (args.variablesReference === 201) {
            return {
              success: true,
              body: { variables: bytes.map((v, i) => ({ name: `CNOME [${i}]`, type: "C", value: v, variablesReference: -1 })) },
            };
          }
          if (args.variablesReference === 300) {
            return { success: true, body: { variables: [{ name: "AITENS[1]", type: "C", value: '"um"', variablesReference: charDetails ? 200 : -1 }] } };
          }
          return { success: true, body: { variables: [] } };
        case "evaluate":
          if (args.expression === "nTotal") {
            return { success: true, body: { type: "N", result: "6", variablesReference: -1 } };
          }
          return { success: true, body: { type: "C", result: '[UTF8]"ação"', variablesReference: charDetails ? 200 : -1 } };
        default:
          return { success: true, body: {} };
      }
    },
  };
  return { dap, pedidos };
}

function sessaoParada(dap, detalheTexto) {
  const s = new DebugSession(dap, {
    modo: "headless",
    programa: "u_zTst",
    active: { def: { name: "Srv" }, environment: "ENV" },
    detalheTexto,
  });
  s.threadId = 1; // parado num breakpoint
  return s;
}

{
  const { dap } = adaptadorFalso({ charDetails: true });
  const r = await sessaoParada(dap, true).variables(0, "Local", ["CNOME"]);
  check(
    "variables até uma string traz valor e detalhe com bruto, tamanho e bytes",
    r.valor === 'C "ação" (+)' && r.detalhe?.bruto === '"ação"' && r.detalhe?.tamanho === 4 && r.detalhe?.bytes?.join("|") === BYTES.join("|"),
    JSON.stringify(r)
  );
}

{
  const { dap } = adaptadorFalso({ charDetails: true });
  const r = await sessaoParada(dap, true).variables(0, "Local", ["AITENS"]);
  check("array continua expandindo em itens", r.itens?.["AITENS[1]"] === 'C "um" (+)' && !r.detalhe, JSON.stringify(r));
}

{
  const { dap } = adaptadorFalso({ charDetails: true });
  const r = await sessaoParada(dap, true).variables(0, "Local", ["AITENS", "AITENS[1]"]);
  check("string dentro de array também traz o detalhe", r.detalhe?.tamanho === 4, JSON.stringify(r));
}

{
  const { dap } = adaptadorFalso({ charDetails: true });
  const r = await sessaoParada(dap, true).evaluate("EncodeUTF8(cNome)");
  check(
    "evaluate de string traz resultado com [UTF8] e o detalhe",
    r.resultado === 'C [UTF8]"ação" (+)' && r.detalhe?.bytes?.length === 4,
    JSON.stringify(r)
  );
}

{
  const { dap } = adaptadorFalso({ charDetails: true });
  const r = await sessaoParada(dap, true).evaluate("nTotal");
  check("evaluate de número não tem detalhe", r.resultado === "N 6" && !("detalhe" in r), JSON.stringify(r));
}

{
  const { dap, pedidos } = adaptadorFalso({ charDetails: true, nBytes: 1000 });
  const r = await sessaoParada(dap, true).variables(0, "Local", ["CNOME"]);
  check(
    "string longa: até 300 bytes e o resto em bytesOmitidos",
    r.detalhe?.bytes?.length === 300 && r.detalhe?.bytesOmitidos === 700 && r.detalhe?.tamanho === 1000,
    JSON.stringify({ n: r.detalhe?.bytes?.length, omitidos: r.detalhe?.bytesOmitidos })
  );
}

{
  const { dap } = adaptadorFalso({ charDetails: true, nBytes: 1000, raw: "x".repeat(1000) });
  const r = await sessaoParada(dap, true).variables(0, "Local", ["CNOME"]);
  check("Raw longo: bruto cortado em 300 caracteres", r.detalhe?.bruto?.length === 301 && r.detalhe.bruto.endsWith("…"), String(r.detalhe?.bruto?.length));
}

{
  const { dap } = adaptadorFalso({ charDetails: true, falha: 200 });
  const r = await sessaoParada(dap, true).variables(0, "Local", ["CNOME"]);
  check("adaptador sem resposta no detalhe: erro, não detalhe vazio", /detalhe indisponível: timeout/.test(r.detalhe?.erro ?? ""), JSON.stringify(r.detalhe));
  const { dap: d2 } = adaptadorFalso({ charDetails: true, falha: 201 });
  const r2 = await sessaoParada(d2, true).evaluate("cNome");
  check("adaptador sem resposta nos bytes: bruto e tamanho com erro dos bytes", r2.detalhe?.tamanho === 4 && /bytes indisponíveis/.test(r2.detalhe?.erro ?? "") && !r2.detalhe?.bytes, JSON.stringify(r2.detalhe));
}

check(
  "launch: charDetails só com detalheTexto",
  JSON.stringify(extrasDoLaunch({ detalheTexto: true })) === '{"extendFeatures":{"charDetails":true}}' &&
    JSON.stringify(extrasDoLaunch({})) === "{}",
  JSON.stringify(extrasDoLaunch({ detalheTexto: true }))
);

{
  const { dap } = adaptadorFalso({ charDetails: false });
  const s = sessaoParada(dap, false);
  const v = await s.variables(0, "Local", ["CNOME"]);
  const e = await s.evaluate("cNome");
  check(
    "sessão sem detalheTexto: string é folha e evaluate só traz resultado",
    v.valor === 'C "ação"' && !v.detalhe && e.resultado === 'C [UTF8]"ação"' && !("detalhe" in e),
    JSON.stringify({ v, e })
  );
}

{
  const { dap, pedidos } = adaptadorFalso({ charDetails: true });
  const s = new DebugSession(dap, { modo: "headless", programa: "u_zTst", active: { def: { name: "Srv" }, environment: "ENV" }, detalheTexto: true });
  let erro = "";
  try {
    await s.evaluate("cNome");
  } catch (e) {
    erro = e.message;
  }
  check("programa em execução recusa antes de falar com o adaptador", /não está parado/.test(erro) && pedidos.length === 0, erro);
}

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DO DETALHE DE TEXTO PASSARAM");
