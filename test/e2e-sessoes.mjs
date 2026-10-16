// E2E do que veio das sessões de outros projetos: troca de servidor sem perder a sessão, falha de
// conexão explicada, detalhe agrupado da compilação, C2003 na declaração, colisão de nome, retorno por
// UserException no tds_run e aviso de parada pendente no tds_debug_breakpoints.
// GRAVA E REMOVE do RPO (fontes zTstSes*): rode só em AppServer de desenvolvimento, acompanhado.
// Uso: node test/e2e-sessoes.mjs <servidor> [ambiente]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const serverName = process.argv[2] ?? process.env.TDS_MCP_TEST_SERVER;
const environment = process.argv[3] ?? process.env.TDS_MCP_TEST_ENV;
const credenciais = process.env.TDS_MCP_TEST_USER
  ? { usuario: process.env.TDS_MCP_TEST_USER, senha: process.env.TDS_MCP_TEST_PASSWORD ?? "" }
  : {};
if (!serverName) {
  console.error("Uso: node test/e2e-sessoes.mjs <servidor> [ambiente]");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "zTstDbg1.prw");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-ses-"));
const fonte = (nome, corpo) => {
  const arquivo = path.join(dir, nome);
  fs.writeFileSync(arquivo, `#include "totvs.ch"\r\n\r\n${corpo.replace(/\n/g, "\r\n")}`, "latin1");
  return arquivo;
};
const doc = (nome) =>
  `/*/{Protheus.doc} ${nome}\nFonte temporario do E2E das sessoes do tds-mcp.\n@type user function\n@author tds-mcp\n@since 16/10/2026\n/*/\n`;

// Avisos repetidos (W0008) e um fonte limpo no mesmo lote.
const AVISOS = fonte(
  "zTstSesA.prw",
  `${doc("zTstSesA")}User Function zTstSesA()\n    Local cA := ""\n    Local nX := 0\n    For nX := 1 To 3\n        cA := ValType()\n        cA := ValType()\n        cA := ValType()\n    Next\nReturn cA\n`
);
const LIMPO = fonte("zTstSesB.prw", `${doc("zTstSesB")}User Function zTstSesB()\nReturn .T.\n`);
// Parâmetro com nome que o protheus.ch traduz: C2003 na linha da declaração.
const C2003 = fonte(
  "zTstSesC.prw",
  `#include "protheus.ch"\n\n${doc("zTstSesC")}User Function zTstSesC()\nReturn zTstSesX("01")\n\nStatic Function zTstSesX(cFilial)\nReturn cFilial\n`
);
// Dois nomes que só diferem depois do 10º caractere (contando o U_).
const COL1 = fonte("zTstSesD.prw", `${doc("zTstSesCar")}User Function zTstSesCar()\nReturn .T.\n`);
const COL2 = fonte("zTstSesE.prw", `${doc("zTstSesCan")}User Function zTstSesCan()\nReturn .F.\n`);
// Valor devolvido pelo canal do UserException.
const RET = fonte(
  "zTstSesR.prw",
  `${doc("zTstSesR")}User Function zTstSesR()\n    Local nSoma := 1 + 2\n    UserException("RESULTADO: soma=" + cValToChar(nSoma))\nReturn nSoma\n`
);

// servers.json de teste: o real mais um servidor fora do ar (porta fechada).
const realServers = path.join(os.homedir(), ".totvsls", "servers.json");
const servers = JSON.parse(fs.readFileSync(process.env.TDS_MCP_SERVERS_JSON ?? realServers, "utf-8"));
servers.configurations.push({ id: "tdsmcp-fora", name: "TdsMcpForaDoAr", type: "totvs_server_protheus", address: "127.0.0.1", port: 1, environment: "X" });
const serversTeste = path.join(dir, "servers.json");
fs.writeFileSync(serversTeste, JSON.stringify(servers));

const mcp = new Client({ name: "e2e-sessoes", version: "0.0.1" });
await mcp.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "..", "dist", "index.js")],
    env: { ...process.env, TDS_MCP_SERVERS_JSON: serversTeste },
  })
);
async function call(name, args = {}) {
  const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  let parsed;
  try {
    parsed = JSON.parse(r.content?.[0]?.text ?? "");
  } catch {
    parsed = r.content?.[0]?.text;
  }
  return { isError: !!r.isError, data: parsed };
}
let falhas = 0;
function check(nome, condicao, detalhe) {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}
const short = (v) => String(JSON.stringify(v)).slice(0, 400);
const compilados = [];

try {
  // Troca de servidor.
  const conn = await call("tds_use_server", { servidor: serverName, ambiente: environment, ...credenciais });
  check("conecta no servidor", conn.data?.conectado === true, `${conn.data?.servidor}/${conn.data?.ambiente}`);
  const fora = await call("tds_use_server", { servidor: "TdsMcpForaDoAr" });
  check("servidor fora do ar: erro diz que a porta não aceita conexão", fora.isError && /não aceita conexão/.test(fora.data?.erro ?? ""), short(fora.data));
  const lista = await call("tds_list_servers");
  check("depois da falha, a sessão anterior continua ativa", lista.data?.sessaoAtiva?.servidor === conn.data?.servidor, short(lista.data?.sessaoAtiva));
  const info = await call("tds_rpo_info", {});
  check("e responde (tds_rpo_info)", !info.isError, short(info.data).slice(0, 200));
  const deNovo = await call("tds_use_server", { servidor: serverName, ambiente: environment, ...credenciais });
  const info2 = await call("tds_rpo_info", {});
  check(
    "reconectar no mesmo servidor não derruba a conexão nova",
    deNovo.data?.conectado === true && !info2.isError && info2.data?.totalPatchesAplicados === info.data?.totalPatchesAplicados,
    short({ antes: info.data?.totalPatchesAplicados, depois: info2.data?.totalPatchesAplicados })
  );

  // Detalhe agrupado e só os fontes com aviso.
  const comp = await call("tds_compile", { arquivos: [AVISOS, LIMPO], recompile: true, temporario: true });
  if (comp.data?.sucesso) compilados.push("ZTSTSESA.PRW", "ZTSTSESB.PRW");
  const warn = comp.data?.resultados ?? [];
  check(
    "compile: só o fonte com aviso em resultados, o limpo na contagem",
    comp.data?.sucesso === true && warn.length === 1 && /zTstSesA/i.test(warn[0].arquivo) && comp.data?.compiladosSemAviso === 1 && !comp.data?.reconexao,
    short(comp.data)
  );
  check("compile: W0008 repetido vira uma linha com as linhas", /W0008 .*\(3x, linhas \d+, \d+, \d+\)/.test(warn[0]?.detalhe ?? ""), warn[0]?.detalhe);

  // C2003 na declaração.
  const c23 = await call("tds_compile", { arquivos: [C2003], recompile: true, temporario: true });
  if (c23.data?.sucesso) compilados.push("ZTSTSESC.PRW");
  check(
    "C2003 na linha da Static Function: causaProvavel aponta o tds_generate_ppo",
    c23.data?.sucesso === false && /declaração \(zTstSesX/.test(c23.data?.causaProvavel ?? "") && /tds_generate_ppo/.test(c23.data?.causaProvavel ?? ""),
    short({ causa: c23.data?.causaProvavel, r: c23.data?.resultados })
  );

  // Colisão de nome: a verificação de sintaxe avisa sem gravar nada.
  const col = await call("tds_syntax_check", { arquivos: [COL1, COL2] });
  check("syntax_check: nomes que colidem nos 10 primeiros caracteres", (col.data?.avisoColisaoDeNome ?? []).some((a) => /U_ZTSTSESCAR/.test(a) && /U_ZTSTSESCAN/.test(a)), short(col.data?.avisoColisaoDeNome ?? col.data));

  // Retorno pelo UserException.
  const cr = await call("tds_compile", { arquivos: [RET], recompile: true, temporario: true });
  if (cr.data?.sucesso) compilados.push("ZTSTSESR.PRW");
  const run = await call("tds_run", { programa: "u_zTstSesR", timeoutSeg: 60 });
  check(
    "tds_run: UserException(\"RESULTADO: ...\") volta como concluido com retorno",
    !run.isError && run.data?.resultado === "concluido" && run.data?.retorno === "soma=3" && /ZTSTSESR/i.test(run.data?.retornoEm ?? ""),
    short(run.data)
  );

  // Parada que o agente ainda não leu: a troca de breakpoints avisa.
  const bp = await call("tds_debug_start", { programa: "u_zTstDbg1", modo: "headless", breakpoints: [{ arquivo: SRC, linha: 29 }], aguardarSeg: 0 });
  await new Promise((r) => setTimeout(r, 15000));
  const troca = await call("tds_debug_breakpoints", { arquivo: SRC, breakpoints: [] });
  check(
    "tds_debug_breakpoints com parada não lida avisa que ela continua",
    bp.data?.estado !== "parado" && (troca.data?.avisos ?? []).some((a) => /parada ainda não foi lida/.test(a)),
    short({ inicio: bp.data?.estado, troca: troca.data })
  );
  const parada = await call("tds_debug_wait", { timeoutSeg: 30 });
  check("tds_debug_wait mostra a parada anterior à troca", parada.data?.estado === "parado" && parada.data?.local?.linha === 29, short(parada.data?.local));
  const fim = await call("tds_debug_step", { acao: "continuar" });
  check("sem breakpoints, o programa termina", fim.data?.estado === "encerrado", short(fim.data));
  await call("tds_debug_stop");
  // Troca com o programa já parado e visto: sem aviso.
  const bp2 = await call("tds_debug_start", { programa: "u_zTstDbg1", modo: "headless", breakpoints: [{ arquivo: SRC, linha: 29 }], aguardarSeg: 60 });
  const troca2 = await call("tds_debug_breakpoints", { arquivo: SRC, breakpoints: [] });
  check("parada já lida: troca sem aviso", bp2.data?.estado === "parado" && !troca2.data?.avisos, short(troca2.data));
  await call("tds_debug_step", { acao: "continuar" });
  await call("tds_debug_stop");
} finally {
  if (compilados.length) {
    const del = await call("tds_rpo_delete", { fontes: compilados });
    check("remove do RPO os fontes do teste", !del.isError, short(del.data));
  }
  await mcp.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(falhas ? `\n${falhas} FALHA(S)` : "\nTODOS OS CASOS PASSARAM");
process.exit(falhas ? 1 : 0);
