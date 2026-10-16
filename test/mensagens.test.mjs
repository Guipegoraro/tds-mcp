// Teste das mensagens e resumos que orientam o agente: detalhe agrupado da compilação, orientação de
// returnCode, C2003 na declaração, colisão de nome, porta sem separador, prazo das requests, retorno por
// UserException e telas de falha de ambiente — não precisa de AppServer.
// Uso: node test/mensagens.test.mjs
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compileVerdict, resumirDetalhe } from "../dist/verdict.js";
import { colisoesDeNome, funcoesDeclaradas } from "../dist/nomes.js";
import { portaSemSeparador, requestTimeoutMs } from "../dist/advpls.js";
import { falhaDeAmbienteNaTela, retornoPorExcecao } from "../dist/debug.js";

let falhas = 0;
function check(nome, condicao, detalhe = "") {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}

// Detalhe da compilação agrupado.
{
  const w = (l) => `ZTST.PRW(${l}) warning W0008 Too few parameters calling valtype`;
  const detalhe = ["", w(7), w(8), w(9), "ZTST.PRW(12) error C2001 Syntax error", "ZTST.PRW(14) error C2001 Syntax error"].join("\r\n");
  const r = resumirDetalhe(detalhe);
  check("avisos iguais viram uma linha com contagem e linhas", r.includes("warning W0008 Too few parameters calling valtype (3x, linhas 7, 8, 9)"), r);
  check("erros iguais também agrupam e saem antes dos avisos", r.indexOf("error C2001 Syntax error (2x, linhas 12, 14)") === 0, r);
  const muitos = Array.from({ length: 15 }, (_, i) => `A.PRW(${i + 1}) warning W${String(i).padStart(4, "0")} aviso ${i}`);
  const errosMuitos = Array.from({ length: 12 }, (_, i) => `A.PRW(${100 + i}) error C${2000 + i} erro ${i}`);
  const r2 = resumirDetalhe([...muitos, ...errosMuitos].join("\n"));
  check("acima de 10 avisos distintos, o resto vira contagem", r2.split("\n").filter((l) => l.startsWith("warning")).length === 10 && /\+5 avisos distintos \(5 ocorrências\)/.test(r2), r2);
  check("erros saem todos, sem limite", r2.split("\n").filter((l) => l.startsWith("error")).length === 12, r2);
  const comInclude = resumirDetalhe("MEUINC.CH(5) error C2001 Syntax error\nZTST.PRW(5) error C2001 Syntax error", undefined, "c:/src/ztst.prw");
  check("mensagem de include leva o nome do arquivo e não se mistura com a do fonte", comInclude.includes("MEUINC.CH: error C2001 Syntax error (linha 5)") && comInclude.includes("\nerror C2001 Syntax error (linha 5)"), comInclude);
  check("linha de fonte abortado, sem o tipo, conta como erro", resumirDetalhe("ZTST.PRW(14)   C2003 Syntax Error") === "error C2003 Syntax Error (linha 14)", resumirDetalhe("ZTST.PRW(14)   C2003 Syntax Error"));
  check("linha fora do formato sai como veio", resumirDetalhe("Mensagem livre do servidor") === "Mensagem livre do servidor");
  check("detalhe vazio fica vazio", resumirDetalhe("") === "" && resumirDetalhe(undefined) === "");
  const linhas = Array.from({ length: 25 }, (_, i) => w(i + 1)).join("\n");
  check("mais de 20 linhas do mesmo aviso: lista cortada", /\(25x, linhas 1, 2, .*20…\)/.test(resumirDetalhe(linhas)), resumirDetalhe(linhas));
}

// Orientação de returnCode.
{
  const v40820 = compileVerdict({ returnCode: 40820, compileInfos: [] }, ["a.prw"]);
  check("40820: conexão caiu, refazer tds_use_server", !v40820.sucesso && /conexão com o servidor caiu/.test(v40820.falhaDeBuild) && /tds_use_server/.test(v40820.falhaDeBuild), v40820.falhaDeBuild);
  const v99999 = compileVerdict({ returnCode: 99999, compileInfos: [] }, ["a.prw"]);
  check("99999: privilégio de compilação, tds_server_permissions", /tds_server_permissions/.test(v99999.falhaDeBuild), v99999.falhaDeBuild);
  const naoIniciado = compileVerdict(
    { returnCode: -1, compileInfos: [{ status: "FATAL", filePath: "a.prw", message: "Build not started", detail: "" }] },
    ["a.prw"],
    ["Request ignored -- RMS_DBGCOMPILE -- Build not started"]
  );
  check(
    "Build not started: orientação do RPO ocupado e FATAL como consequência",
    !naoIniciado.sucesso && /RPO estava em uso/.test(naoIniciado.falhaDeBuild) && /consequência do build não iniciado/.test(naoIniciado.falhaDeBuild) && !naoIniciado.causaProvavel,
    naoIniciado.falhaDeBuild
  );
  const outro = compileVerdict({ returnCode: -1, compileInfos: [] }, ["a.prw"], ["outra mensagem"]);
  check("returnCode sem orientação própria continua com o texto genérico", /returnCode -1/.test(outro.falhaDeBuild), outro.falhaDeBuild);
}

// C2003 na linha da declaração aponta o tds_generate_ppo.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-msg-"));
  const fonte = path.join(dir, "ZTSTC23.PRW");
  fs.writeFileSync(fonte, '#include "totvs.ch"\r\n\r\nStatic Function zCalc(cFilial)\r\n    Local nX := 1\r\nReturn nX\r\n', "latin1");
  const erro = (linha) => ({ status: "ERROR", filePath: fonte, message: "Error", detail: `ZTSTC23.PRW(${linha})   C2003 Syntax Error` });
  const v = compileVerdict({ returnCode: 0, compileInfos: [erro(3)] }, [fonte]);
  check("C2003 na linha de Function: sugere tds_generate_ppo", /C2003 na linha da declaração \(zCalc, linha 3\)/.test(v.causaProvavel ?? "") && /tds_generate_ppo/.test(v.causaProvavel), v.causaProvavel);
  const v2 = compileVerdict({ returnCode: 0, compileInfos: [erro(4)] }, [fonte]);
  check("C2003 em outra linha: sem essa orientação", !/declaração/.test(v2.causaProvavel ?? ""), v2.causaProvavel);
  const v3 = compileVerdict({ returnCode: 0, compileInfos: [{ ...erro(3), filePath: path.join(dir, "NAOEXISTE.PRW") }] }, []);
  check("fonte local ausente: sem diagnóstico, sem falha", !/declaração/.test(v3.causaProvavel ?? ""), v3.causaProvavel);
  const uri = compileVerdict({ returnCode: 0, compileInfos: [{ ...erro(3), filePath: "file:///" + fonte.replace(/\\/g, "/") }] }, []);
  check("filePath como URI file:// também é lido", /zCalc, linha 3/.test(uri.causaProvavel ?? ""), uri.causaProvavel);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Colisão de nome nos 10 primeiros caracteres.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-nome-"));
  const f = (nome, texto) => {
    const p = path.join(dir, nome);
    fs.writeFileSync(p, texto, "latin1");
    return p;
  };
  const a = f("DAN04A.PRW", "User Function DAN04PCar()\r\nReturn\r\n// User Function DAN04PCom()\r\n/* Function ZZZ */\r\n");
  const b = f("DAN04B.PRW", "User Function DAN04PCan()\r\nReturn\r\nStatic Function DAN04PCaX()\r\nReturn\r\n");
  const c = f("OUTRO.PRW", "User Function Outro()\r\nReturn\r\n");
  check(
    "funções públicas: U_ conta, Static e comentário ficam de fora",
    JSON.stringify(funcoesDeclaradas(a, fs.readFileSync(a, "latin1")).map((x) => x.nome)) === '["U_DAN04PCAR"]' &&
      JSON.stringify(funcoesDeclaradas(b, fs.readFileSync(b, "latin1")).map((x) => x.nome)) === '["U_DAN04PCAN"]'
  );
  const avisos = colisoesDeNome([a, b, c]);
  check("U_DAN04PCar e U_DAN04PCan colidem em U_DAN04PCA", avisos.length === 1 && /U_DAN04PCAR \(DAN04A.PRW\), U_DAN04PCAN \(DAN04B.PRW\)/.test(avisos[0]) && /mesma função/.test(avisos[0]), avisos.join(" | "));
  check("nomes distintos nos 10 primeiros: sem aviso", colisoesDeNome([a, c]).length === 0);
  const t1 = f("A.TLPP", "User Function AscNumTitHook()\nReturn\n");
  const t2 = f("B.TLPP", "User Function AscNumTitProx()\nReturn\n");
  const soTlpp = colisoesDeNome([t1, t2]);
  check("com TLPP: aviso fala da chamada a partir de .prw", soTlpp.length === 1 && /a partir de \.prw/.test(soTlpp[0]), soTlpp.join(" | "));
  const misto = colisoesDeNome([a, f("D.TLPP", "User Function DAN04PCarLongo()\nReturn\n")]);
  check("PRW com TLPP: o aviso não diz que o RPO junta as duas", misto.length === 1 && /a partir de \.prw/.test(misto[0]) && !/mesma função/.test(misto[0]), misto.join(" | "));
  const curto = colisoesDeNome([f("LONGO.PRW", "User Function ABCDEFGHXY()\r\nReturn\r\n"), f("CURTO.TLPP", "User Function ABCDEFGH()\nReturn\n")]);
  check("PRW longo com TLPP de nome curto: colidem no RPO", curto.length === 1 && /mesma função/.test(curto[0]), curto.join(" | "));
  const doisPrw = colisoesDeNome([a, b, f("E.TLPP", "User Function DAN04PCarLongo()\nReturn\n")]);
  check("dois PRW e um TLPP: colidem no RPO", doisPrw.length === 1 && /mesma função/.test(doisPrw[0]), doisPrw.join(" | "));
  const ns = f("C.TLPP", "namespace custom.x\nUser Function AscNumTitHook()\nReturn\n");
  check("TLPP com namespace fica de fora", colisoesDeNome([ns, t2]).length === 0);
  check("arquivo que não existe é ignorado", colisoesDeNome([path.join(dir, "NAO.PRW"), a]).length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Porta com separador de milhar nas mensagens do advpls.
check(
  "porta 1.614 vira 1614",
  portaSemSeparador("An error ocurred while autoReconnect.\n\rServer: danica.cloudtotvs.com.br:1.614 [serverName]") ===
    "An error ocurred while autoReconnect.\n\rServer: danica.cloudtotvs.com.br:1614 [serverName]"
);
check("porta sem separador fica igual", portaSemSeparador("Server: h:1234 [x]") === "Server: h:1234 [x]");
check("número fora de 'Server:' fica igual", portaSemSeparador("versão 7.00.240223P de 1.614 linhas") === "versão 7.00.240223P de 1.614 linhas");

// Prazo das requests.
check("conexão e consulta: 90 s", requestTimeoutMs("$totvsserver/connect") === 90_000 && requestTimeoutMs("$totvsserver/inspectorObjects") === 90_000);
check("compilação e patch: 30 min", requestTimeoutMs("$totvsserver/compilation") === 30 * 60_000 && requestTimeoutMs("$totvsserver/patchApply") === 30 * 60_000);
check("remoção de fonte do RPO: 5 min", requestTimeoutMs("$totvsserver/deletePrograms") === 5 * 60_000);

// Retorno por UserException("RESULTADO: ...").
{
  const r = retornoPorExcecao("RESULTADO: soma=3 | longa=20\nU_ZTZA9PRW - ZTZA9PRW.PRW(15)");
  check("valor e local da exceção", r?.valor === "soma=3 | longa=20" && r.onde === "U_ZTZA9PRW - ZTZA9PRW.PRW(15)", JSON.stringify(r));
  const multi = retornoPorExcecao("RESULTADO: linha1\nlinha2\nU_X - X.PRW(3)");
  check("valor com várias linhas", multi?.valor === "linha1\nlinha2" && multi.onde === "U_X - X.PRW(3)", JSON.stringify(multi));
  check("sem a linha do local", JSON.stringify(retornoPorExcecao("RESULTADO: 42")) === '{"valor":"42"}');
  check("valor vazio", retornoPorExcecao("RESULTADO:")?.valor === "");
  check("outro erro não é retorno", retornoPorExcecao("variable does not exist NX on U_X(X.PRW)") === undefined);
  check("prefixo só no começo", retornoPorExcecao("erro: RESULTADO: 1") === undefined);
}

// Telas de falha de ambiente.
check("Falha ao conectar com o WebAgent", /WebAgent/.test(falhaDeAmbienteNaTela("TOTVS\nFalha ao conectar com o WebAgent\nTentar novamente")?.causa ?? ""));
check("Acesso não autorizado ao WebAgent", /recusou a versão/.test(falhaDeAmbienteNaTela("Acesso não autorizado ao WebAgent")?.causa ?? ""));
check("ERR0032", /conexão do webapp com o AppServer caiu/.test(falhaDeAmbienteNaTela("ERR0032: Conexão entre TOTVS Webapp e Application Server interrompida")?.causa ?? ""));
check("tela comum não é falha", falhaDeAmbienteNaTela("Processando... aguarde") === undefined && falhaDeAmbienteNaTela("") === undefined);
check("tela longa é cortada", (falhaDeAmbienteNaTela("ERR0032 " + "x".repeat(3000))?.tela.length ?? 0) <= 1001);

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DE MENSAGENS PASSARAM");
