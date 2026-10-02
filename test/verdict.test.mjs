// Teste da lógica de veredito de compilação — não precisa de AppServer.
// Falha de BUILD (returnCode != 0) e resposta que não comprova a compilação
// nunca podem sair como sucesso.
// Uso: node test/verdict.test.mjs
import assert from "node:assert/strict";
import { compileVerdict } from "../dist/verdict.js";

const casos = [
  {
    nome: "sucesso: returnCode 0 e fonte SUCCESS",
    resposta: {
      returnCode: 0,
      compileInfos: [{ status: "SUCCESS", filePath: "a.prw", message: "ok", detail: "" }],
    },
    esperado: true,
  },
  {
    nome: "COMPILEERROR-300: build falhou, compileInfos VAZIO",
    resposta: { returnCode: -300, compileInfos: [] },
    esperado: false,
  },
  {
    nome: "-300 com fonte marcado SUCCESS (build revertido depois)",
    resposta: {
      returnCode: -300,
      compileInfos: [{ status: "SUCCESS", filePath: "a.prw", message: "ok", detail: "" }],
    },
    esperado: false,
  },
  {
    nome: "token de autorizacao expirado (40840)",
    resposta: { returnCode: 40840, compileInfos: [] },
    esperado: false,
  },
  {
    nome: "returnCode desconhecido diferente de zero",
    resposta: { returnCode: -999, compileInfos: [] },
    esperado: false,
  },
  {
    nome: "erro de sintaxe por fonte (returnCode 0)",
    resposta: {
      returnCode: 0,
      compileInfos: [{ status: "ERROR", filePath: "a.prw", message: "erro", detail: "C2002" }],
    },
    esperado: false,
  },
  {
    nome: "apenas WARN nao invalida sucesso",
    resposta: {
      returnCode: 0,
      compileInfos: [{ status: "WARN", filePath: "a.prw", message: "aviso", detail: "" }],
    },
    esperado: true,
  },
  {
    // Cenario real medido: fonte ja atualizado no RPO com recompile=false
    nome: "tudo SKIPPED: sucesso, mas com aviso de que nada foi gravado",
    resposta: {
      returnCode: 0,
      compileInfos: [{ status: "SKIPPED", filePath: "a.prw", message: "", detail: "" }],
    },
    esperado: true,
    exigeAviso: true,
  },
  {
    // Cenario real medido: erro de sintaxe e arquivo inexistente retornam -1
    nome: "erro por fonte com returnCode -1 (medido no AppServer)",
    resposta: {
      returnCode: -1,
      compileInfos: [{ status: "ERROR", filePath: "a.prw", message: "erro", detail: "C2002" }],
    },
    esperado: false,
  },
  {
    nome: "returnCode ausente é tratado como 0",
    resposta: {
      compileInfos: [{ status: "SUCCESS", filePath: "a.prw", message: "ok", detail: "" }],
    },
    esperado: true,
  },
  {
    nome: "resposta nula -> inconclusivo, nao sucesso",
    resposta: null,
    esperado: false,
    exigeInconclusivo: true,
  },
  {
    nome: "returnCode 0 com compileInfos vazio -> inconclusivo",
    resposta: { returnCode: 0, compileInfos: [] },
    esperado: false,
    exigeInconclusivo: true,
  },
  {
    nome: "status desconhecido (ABORTED) -> inconclusivo",
    resposta: { returnCode: 0, compileInfos: [{ status: "ABORTED", filePath: "a.prw", message: "", detail: "" }] },
    esperado: false,
    exigeInconclusivo: true,
  },
  {
    nome: "status em minusculas (success) e aceito",
    resposta: { returnCode: 0, compileInfos: [{ status: "success", filePath: "a.prw", message: "", detail: "" }] },
    esperado: true,
  },
  {
    nome: "fonte enviado sem resultado na resposta -> inconclusivo",
    resposta: { returnCode: 0, compileInfos: [{ status: "SUCCESS", filePath: "C:\\src\\a.prw", message: "", detail: "" }] },
    enviados: ["C:\\src\\a.prw", "C:\\src\\b.prw"],
    esperado: false,
    exigeInconclusivo: true,
  },
  {
    nome: "todos os enviados com resultado (filePath como URI) -> sucesso",
    resposta: {
      returnCode: 0,
      compileInfos: [
        { status: "SUCCESS", filePath: "file:///c%3A/src/A.PRW", message: "", detail: "" },
        { status: "SUCCESS", filePath: "c:\\src\\b.prw", message: "", detail: "" },
      ],
    },
    enviados: ["C:\\src\\a.prw", "C:\\src\\b.prw"],
    esperado: true,
  },
];

let falhas = 0;
for (const c of casos) {
  const v = compileVerdict(c.resposta, c.enviados);
  let ok = v.sucesso === c.esperado;
  if (c.exigeAviso && !v.aviso) ok = false;
  if (c.exigeInconclusivo && !v.inconclusivo) ok = false;
  if (!ok) falhas++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.nome}\n      sucesso=${v.sucesso} (esperado ${c.esperado}) returnCode=${v.returnCode}` +
      (v.falhaDeBuild ? `\n      motivo: ${v.falhaDeBuild.substring(0, 110)}...` : "") +
      (v.aviso ? `\n      aviso : ${v.aviso.substring(0, 110)}...` : "") +
      (v.inconclusivo ? `\n      inconclusivo: ${v.inconclusivo.substring(0, 110)}...` : "")
  );
}

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log(`\nTODOS OS ${casos.length} CASOS PASSARAM`);
