// Teste da recusa de acento em expressão do depurador — não precisa de AppServer.
// Uso: node test/acento.test.mjs
import { recusaAcento } from "../dist/acento.js";

let falhas = 0;
function check(nome, ok, detalhe) {
  if (!ok) falhas++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}
const pronta = (m) => (m?.match(/que já vem pronto: (.*)$/) ?? [])[1];

check("expressão só ASCII passa", recusaAcento("nTotal == 2 .and. cX == 'ok'", "a expressão") === undefined);

const m1 = recusaAcento('cDesc == "AÇÃO"', "a expressão");
check("aspas duplas: forma pronta com Chr()", pronta(m1) === 'cDesc == ("A" + Chr(199) + Chr(195) + "O")', m1);
check("a mensagem diz onde está o acento", /^Recusado: a expressão /.test(m1 ?? ""));

const m2 = recusaAcento("cDesc $ 'Ação'", "o watch x");
check("aspas simples mantêm o tipo de aspas", pronta(m2) === "cDesc $ ('A' + Chr(231) + Chr(227) + 'o')", m2);

const m3 = recusaAcento('cX := "ÇÃO" + cY', "a expressão");
check("acento no início do texto", pronta(m3) === 'cX := (Chr(199) + Chr(195) + "O") + cY', m3);

const m4 = recusaAcento('aItens[1] == "preço" .and. cZ == "ok"', "a expressão");
check("índice de array sem aspas não impede a forma pronta", pronta(recusaAcento('aItens[1] == "é"', "a expressão")) === 'aItens[1] == (Chr(233))');
check("só o literal acentuado é convertido", pronta(m4) === 'aItens[1] == ("pre" + Chr(231) + "o") .and. cZ == "ok"', m4);

const m5 = recusaAcento('cX == "€uro"', "a expressão");
check("€ usa o byte CP1252 (128)", pronta(m5) === 'cX == (Chr(128) + "uro")', m5);

for (const [nome, expr] of [
  ["acento entre colchetes fica sem forma pronta", "cDesc == [AÇÃO]"],
  ["acento fora de aspas fica sem forma pronta", "nAção := 1"],
  ["caractere fora do CP1252 fica sem forma pronta", 'cX == "a☃b"'],
  ["aspas sem fechar ficam sem forma pronta", 'cX == "ação'],
  ["aspas dentro de colchetes ficam sem forma pronta", 'cX == [ele disse "não"]'],
]) {
  const m = recusaAcento(expr, "a expressão");
  check(nome, !!m && !pronta(m) && /Chr\(<byte CP1252>\)/.test(m), m);
}

console.log(falhas === 0 ? "\nTODOS OS CASOS DE ACENTO PASSARAM" : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
