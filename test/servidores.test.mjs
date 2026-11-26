// Teste do cadastro de servidor no servers.json - usa arquivo temporario e validacao simulada;
// nao conecta em servidor nenhum e nao toca no servers.json real.
// Uso: node test/servidores.test.mjs
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cadastrarServidor, gerarIdServidor } from "../dist/servidores.js";
import { serversJsonPath } from "../dist/session.js";

let falhas = 0;
function check(nome, condicao, detalhe = "") {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}
async function erroDe(fn) {
  try {
    await fn();
    return "";
  } catch (e) {
    return e.message;
  }
}

const existentes = [
  {
    id: "abc123def456ghi789jkl012mno345",
    type: "totvs_server_protheus",
    name: "Cliente_Dev",
    port: 5555,
    address: "dev.exemplo.test",
    buildVersion: "7.00.240223P",
    secure: false,
    includes: ["C:\\inc"],
    environments: ["DEV"],
    username: "usuario.teste",
    environment: "DEV",
    token: "token-ficticio-1",
    informations: { versao: "x" },
  },
  {
    id: "zzz999yyy888xxx777www666vvv555",
    type: "totvs_server_protheus",
    name: "Cliente_Hml",
    port: 6666,
    address: "http://hml.exemplo.test",
    buildVersion: "7.00.240223P",
    secure: true,
    includes: ["C:\\inc"],
    environments: ["HML"],
    token: "token-ficticio-2",
  },
];
const conteudoBase = () => ({
  version: "0.2.2",
  includes: ["C:\\inc", "C:\\inc2"],
  permissions: { authorizationtoken: "autorizacao-ficticia" },
  connectedServer: existentes[0],
  configurations: structuredClone(existentes),
  savedTokens: [["abc123def456ghi789jkl012mno345DEV", { id: "abc123def456ghi789jkl012mno345", token: "token-salvo" }]],
  lastConnectedServer: "Cliente_Dev",
  rpoToken: "rpo-ficticio",
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-srv-"));
const arquivo = path.join(dir, "servers.json");
const antes = process.env.TDS_MCP_SERVERS_JSON;
process.env.TDS_MCP_SERVERS_JSON = arquivo;

function gravar(obj, { indentacao = "\t", quebra = "\n", fim = false, bom = false } = {}) {
  let t = JSON.stringify(obj, null, indentacao);
  if (quebra === "\r\n") t = t.replace(/\n/g, "\r\n");
  fs.writeFileSync(arquivo, (bom ? "\uFEFF" : "") + t + (fim ? quebra : ""));
}
const lerRaw = () => fs.readFileSync(arquivo, "utf-8");
const lerJson = () => JSON.parse(lerRaw().replace(/^\uFEFF/, ""));
const backups = () => fs.readdirSync(dir).filter((f) => f.endsWith(".bak"));

let chamadas = [];
const validaOk = (secure = 0, build = "7.00.240223P") => async (host, porta, tipo) => {
  chamadas.push([host, porta, tipo]);
  return { build, secure };
};
const validaFalha = async () => {
  throw new Error("timeout");
};
const novo = { nome: "Servidor_Novo", endereco: "novo.exemplo.test", porta: 7777, ambientes: ["PROD", "TESTE"] };

try {
  // Caso feliz
  gravar(conteudoBase());
  check("o teste aponta para o arquivo temporario", serversJsonPath() === arquivo);
  const original = lerRaw();
  const r = await cadastrarServidor(novo, validaOk(1, "7.00.250101P"));
  const j = lerJson();
  const entrada = j.configurations.at(-1);
  check("entrada nova no fim de configurations", j.configurations.length === 3 && entrada.name === "Servidor_Novo");
  check(
    "so as chaves do grupo inicial, na ordem do TDS",
    Object.keys(entrada).join() === "id,type,name,port,address,buildVersion,secure,includes,environments",
    Object.keys(entrada).join()
  );
  check(
    "tipo, endereco, porta e ambientes",
    entrada.type === "totvs_server_protheus" && entrada.address === "novo.exemplo.test" && entrada.port === 7777 && entrada.environments.join() === "PROD,TESTE"
  );
  check("build e secure vem da validacao", entrada.buildVersion === "7.00.250101P" && entrada.secure === true);
  check(
    "validacao chamada com endereco, porta e tipo",
    chamadas.length === 1 && chamadas[0].join() === "novo.exemplo.test,7777,totvs_server_protheus",
    chamadas.join()
  );
  check("id em base 36 de 30 caracteres, igual ao retornado", /^[0-9a-z]{30}$/.test(entrada.id) && r.id === entrada.id);
  check(
    "retorno com build, segura, ambientes, arquivo e proximo passo",
    r.build === "7.00.250101P" && r.segura === true && r.ambientes.length === 2 && r.arquivo === arquivo && /tds_use_server/.test(r.proximoPasso) && r.avisos.length === 0
  );

  // Backup
  const bks = backups();
  check(
    "backup criado ao lado do arquivo, com o conteudo anterior",
    bks.length === 1 && r.backup === path.join(dir, bks[0]) && fs.readFileSync(r.backup, "utf-8") === original,
    bks.join()
  );
  check("sem arquivo temporario sobrando", fs.readdirSync(dir).every((f) => !f.endsWith(".tmp")));

  // Preservacao
  const base = conteudoBase();
  check("entradas existentes intactas (tokens inclusive)", JSON.stringify(j.configurations.slice(0, 2)) === JSON.stringify(base.configurations));
  const semConfigs = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => k !== "configurations")));
  check("chaves do topo intactas", semConfigs(j) === semConfigs(base));
  check("ordem das chaves do topo preservada", Object.keys(j).join() === Object.keys(base).join());

  // includes padrao e informado
  check("sem includes: usa a lista global do topo", entrada.includes.join("|") === "C:\\inc|C:\\inc2");
  gravar(conteudoBase());
  await cadastrarServidor({ ...novo, includes: ["D:\\meus", " D:\\meus ", "D:\\outros"] }, validaOk());
  check("includes informados valem sobre os globais (sem repetidos)", lerJson().configurations.at(-1).includes.join("|") === "D:\\meus|D:\\outros");

  // segura divergente
  gravar(conteudoBase());
  const div = await cadastrarServidor({ ...novo, segura: true }, validaOk(0));
  check(
    "segura informado divergente: vale a validacao e o retorno avisa",
    div.segura === false && lerJson().configurations.at(-1).secure === false && div.avisos.length === 1 && /validação/.test(div.avisos[0]),
    div.avisos.join()
  );
  gravar(conteudoBase());
  const igual = await cadastrarServidor({ ...novo, segura: true }, validaOk(1));
  check("segura coincidente: sem aviso", igual.segura === true && igual.avisos.length === 0);

  // Duplicatas
  gravar(conteudoBase());
  const bruto = lerRaw();
  const backupsAntes = backups().length;
  let e = await erroDe(() => cadastrarServidor({ ...novo, nome: "cliente_dev" }, validaOk()));
  check("duplicata por nome (sem diferenciar maiusculas) diz qual servidor existe", /"Cliente_Dev"/.test(e) && /mesmo nome/.test(e), e);
  e = await erroDe(() => cadastrarServidor({ ...novo, endereco: "dev.exemplo.test", porta: 5555 }, validaOk()));
  check("duplicata por endereco+porta diz qual servidor existe", /"Cliente_Dev"/.test(e) && /endereço e porta/.test(e), e);
  e = await erroDe(() => cadastrarServidor({ ...novo, endereco: "HML.exemplo.test", porta: 6666 }, validaOk()));
  check("endereco comparado sem esquema e sem diferenciar maiusculas", /"Cliente_Hml"/.test(e), e);
  chamadas = [];
  await erroDe(() => cadastrarServidor({ ...novo, nome: "Cliente_Dev" }, validaOk()));
  check("duplicata e recusada antes de validar no servidor", chamadas.length === 0);
  check("duplicata nao altera o arquivo nem cria backup", lerRaw() === bruto && backups().length === backupsAntes);
  const outraPorta = await cadastrarServidor({ ...novo, endereco: "dev.exemplo.test", porta: 5556 }, validaOk());
  check("mesmo endereco em outra porta e aceito", !!outraPorta.id);

  // Validacao falha
  gravar(conteudoBase());
  const antesFalha = lerRaw();
  const arquivosAntes = fs.readdirSync(dir).sort().join();
  e = await erroDe(() => cadastrarServidor(novo, validaFalha, { explicarFalha: async (m) => `${m} [porta fechada]` }));
  check("validacao que falha: nada gravado e sem backup novo", lerRaw() === antesFalha && fs.readdirSync(dir).sort().join() === arquivosAntes);
  check(
    "erro claro com o motivo, o contexto da porta e a dica do modo debug do TCloud",
    /timeout/.test(e) && /porta fechada/.test(e) && /modo debug/.test(e) && /Nada foi gravado/.test(e),
    e
  );
  e = await erroDe(() => cadastrarServidor(novo, validaOk(0, "")));
  check("validacao sem build tambem nao grava", /build/.test(e) && lerRaw() === antesFalha, e);

  // Entrada invalida
  for (const [rotulo, parcial, esperado] of [
    ["nome vazio", { nome: "  " }, /nome/],
    ["endereco vazio", { endereco: "" }, /endereço/],
    ["porta fora da faixa", { porta: 70000 }, /Porta/],
    ["porta nao inteira", { porta: 80.5 }, /Porta/],
    ["sem ambientes", { ambientes: [" "] }, /ambiente/],
  ]) {
    e = await erroDe(() => cadastrarServidor({ ...novo, ...parcial }, validaOk()));
    check(`entrada invalida: ${rotulo}`, esperado.test(e) && lerRaw() === antesFalha, e);
  }

  // Estilo do arquivo
  for (const [rotulo, estilo] of [
    ["CRLF, 2 espacos e quebra final", { indentacao: "  ", quebra: "\r\n", fim: true }],
    ["tabulacao, LF, sem quebra final", { indentacao: "\t", quebra: "\n", fim: false }],
    ["BOM, 4 espacos e quebra final", { indentacao: "    ", quebra: "\n", fim: true, bom: true }],
  ]) {
    gravar(conteudoBase(), estilo);
    await cadastrarServidor(novo, validaOk());
    const depois = lerRaw();
    const linhas = depois.replace(/^\uFEFF/, "").split(/\r?\n/);
    check(`estilo preservado (${rotulo}): quebra de linha`, estilo.quebra === "\r\n" ? !/[^\r]\n/.test(depois) : !depois.includes("\r"));
    check(`estilo preservado (${rotulo}): BOM e quebra final`, depois.startsWith("\uFEFF") === !!estilo.bom && /\n$/.test(depois) === estilo.fim);
    check(`estilo preservado (${rotulo}): indentacao`, linhas[1] === `${estilo.indentacao}"version": "0.2.2",`, JSON.stringify(linhas[1]));
  }

  // Arquivo inexistente ou malformado
  fs.rmSync(arquivo);
  e = await erroDe(() => cadastrarServidor(novo, validaOk(), { arquivo }));
  check("servers.json inexistente: erro orientando, nada criado", /não encontrado/.test(e) && !fs.existsSync(arquivo), e);
  e = await erroDe(() => cadastrarServidor(novo, validaFalha));
  check("override apontando para arquivo que nao existe: recusa em vez de cair em outro servers.json", /TDS_MCP_SERVERS_JSON/.test(e) && /Nada foi gravado/.test(e), e);
  fs.writeFileSync(arquivo, "{ nao e json");
  e = await erroDe(() => cadastrarServidor(novo, validaOk(), { arquivo }));
  check("servers.json invalido: erro e arquivo intacto", /JSON válido/.test(e) && lerRaw() === "{ nao e json", e);

  // Id
  const ids = new Set(Array.from({ length: 200 }, () => gerarIdServidor()));
  check("ids gerados nao se repetem", ids.size === 200);
  check("id nao repete um existente", gerarIdServidor(["a"]).length === 30);
} finally {
  if (antes === undefined) delete process.env.TDS_MCP_SERVERS_JSON;
  else process.env.TDS_MCP_SERVERS_JSON = antes;
  fs.rmSync(dir, { recursive: true, force: true });
}

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DE CADASTRO DE SERVIDOR PASSARAM");
