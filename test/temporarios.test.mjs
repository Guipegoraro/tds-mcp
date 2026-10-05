// Teste do registro de fontes temporários — não precisa de AppServer.
// Uso: node test/temporarios.test.mjs
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadTemporarios, prefixoWrapper, registrarCompilacao, removerTemporarios, temporariosDe } from "../dist/temporarios.js";

let falhas = 0;
function check(nome, condicao, detalhe = "") {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}

// prefixo do wrapper: "zT" + 3 caracteres, estável por usuário@máquina
const p = prefixoWrapper("ana", "PC01");
check("prefixo tem zT + 3 caracteres (cabe nos 10 do nome com U_ e 3 letras)", /^zT[0-9A-Z]{3}$/.test(p), p);
check("prefixo estável e sem diferenciar maiúsculas", prefixoWrapper("ANA", "pc01") === p);
const outros = new Set(["bruno@PC02", "carla@PC03", "ana@PC02", "bruno@PC01"].map((k) => prefixoWrapper(...k.split("@"))));
check("usuários ou máquinas diferentes dão prefixos diferentes", outros.size === 4 && !outros.has(p), [...outros].join(","));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-temp-"));
const file = path.join(dir, "sub", "temporarios.json");
const fontes = (lista) => lista.map((t) => t.fonte).sort().join(",");
try {
  check("registro inexistente é lista vazia", loadTemporarios(file).length === 0);

  registrarCompilacao("Dev", "AMB", ["C:\\x\\zTstR02.prw", "C:\\x\\zTstR01.prw"], true, file);
  check("compilação temporária registra os fontes pelo nome do RPO", fontes(temporariosDe("Dev", "AMB", file)) === "ZTSTR01.PRW,ZTSTR02.PRW", fontes(loadTemporarios(file)));
  check("servidor e ambiente comparados sem diferenciar maiúsculas", temporariosDe("dev", "amb", file).length === 2);
  check("outro ambiente não enxerga os temporários", temporariosDe("Dev", "OUTRO", file).length === 0);

  registrarCompilacao("Dev", "AMB", ["C:\\x\\zTstR02.prw"], true, file);
  check("recompilar como temporário não duplica", loadTemporarios(file).length === 2);

  registrarCompilacao("Dev", "OUTRO", ["C:\\x\\zTstR02.prw"], true, file);
  registrarCompilacao("Dev", "AMB", ["C:\\y\\ZTSTR02.PRW"], false, file);
  check(
    "compilar sem a marca tira o fonte do registro só naquele ambiente",
    fontes(temporariosDe("Dev", "AMB", file)) === "ZTSTR01.PRW" && temporariosDe("Dev", "OUTRO", file).length === 1
  );

  const antes = fs.statSync(file).mtimeMs;
  registrarCompilacao("Dev", "AMB", ["C:\\x\\zEntrega.prw"], false, file);
  check("compilação comum de fonte fora do registro não regrava o arquivo", fs.statSync(file).mtimeMs === antes);

  removerTemporarios("Dev", "AMB", ["zTstR01.prw"], file);
  check("remover tira o fonte do registro", temporariosDe("Dev", "AMB", file).length === 0 && loadTemporarios(file).length === 1);
  check("nenhum arquivo temporário de gravação sobra", fs.readdirSync(path.dirname(file)).join() === "temporarios.json", fs.readdirSync(path.dirname(file)).join());

  fs.writeFileSync(file, "{}");
  let erro = "";
  try {
    registrarCompilacao("Dev", "AMB", ["a.prw"], true, file);
  } catch (e) {
    erro = e.message;
  }
  check("registro que não é lista dá erro em vez de ser sobrescrito", /não contém uma lista/.test(erro) && fs.readFileSync(file, "utf8") === "{}", erro);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DE TEMPORARIOS PASSARAM");
