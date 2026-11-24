// Teste do perfil do navegador headless — não precisa de AppServer nem de navegador.
// Uso: node test/webapp.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { criarPerfil, marcarSenhaNaoVazia, prepararArgumentos, removerPerfil, removerPerfisOrfaos } from "../dist/perfil.js";
import { HeadlessWebapp } from "../dist/webapp.js";

let falhas = 0;
function check(nome, condicao, detalhe = "") {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsmcp-webapp-"));
try {
  const antes = Date.now();
  marcarSenhaNaoVazia(dir);
  const depois = Date.now();
  const senha = JSON.parse(fs.readFileSync(path.join(dir, "Local State"), "utf8")).password_manager;
  check("Local State diz que a senha não é vazia", senha.os_password_blank === false);
  const gravado = senha.os_password_last_changed;
  check("data gravada como texto, como o Chromium grava int64", typeof gravado === "string" && /^\d+$/.test(gravado), gravado);
  // Microssegundos desde 1601: 01/01/2020 00:00 UTC é 13222310400000000.
  const epoca = 13222310400000n - BigInt(Date.UTC(2020, 0, 1));
  const ms = Number(BigInt(gravado) / 1000n - epoca);
  check("data gravada é a hora atual na escala do Chromium", ms >= antes && ms <= depois, new Date(ms).toISOString());

  // Sem executável não há navegador: sobra o perfil como o open() o preparou para ele.
  const base = path.join(dir, "base");
  let erro = "";
  await HeadlessWebapp.open(path.join(dir, "nao-existe.exe"), "about:blank", base).catch((e) => (erro = e.message));
  const perfil = fs.readdirSync(base).find((n) => n.startsWith("chromium-profile-"));
  check("open() marca o perfil que entrega ao navegador", !!erro && !!perfil && fs.existsSync(path.join(base, perfil, "Local State")), erro);

  const perfis = path.join(dir, "perfis");
  const meu = criarPerfil(perfis);
  check("criarPerfil marca o perfil", fs.existsSync(path.join(meu, "Local State")));
  const morto = spawnSync(process.execPath, ["-e", ""]).pid;
  const vivo = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  // Pid reaproveitado pelo Windows: o processo vive, mas ninguém renova a pasta.
  const reaproveitado = path.join(perfis, `perfil-${vivo.pid}-velho`);
  for (const n of [`perfil-${morto}-abc`, `perfil-${vivo.pid}-abc`, "outra-pasta"]) fs.mkdirSync(path.join(perfis, n));
  fs.mkdirSync(reaproveitado);
  const anteontem = new Date(Date.now() - 48 * 3600_000);
  fs.utimesSync(reaproveitado, anteontem, anteontem);
  try {
    removerPerfisOrfaos(perfis);
  } finally {
    vivo.kill();
  }
  const restantes = fs.readdirSync(perfis).sort().join(", ");
  const esperado = [path.basename(meu), `perfil-${vivo.pid}-abc`, "outra-pasta"].sort().join(", ");
  check("removerPerfisOrfaos apaga só o perfil de processo encerrado ou sem renovação", restantes === esperado, restantes);
  removerPerfisOrfaos(path.join(dir, "nao-existe"));
  check("removerPerfisOrfaos aceita pasta que não existe", true);

  // Processo com a pasta como diretório corrente segura a remoção até sair.
  const preso = path.join(dir, "preso");
  fs.mkdirSync(preso);
  const segura = spawn(process.execPath, ["-e", "console.log(1);setTimeout(() => {}, 1500)"], { cwd: preso, stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((r) => segura.stdout.once("data", r));
  check("removerPerfil desiste no prazo com a pasta em uso", !removerPerfil(preso, 300) && fs.existsSync(preso));
  check("removerPerfil insiste até a pasta ser solta", removerPerfil(preso, 10000) && !fs.existsSync(preso));

  const arg = (...a) => {
    const r = prepararArgumentos(a);
    return `${r.usaPerfil} ${r.args.join(" ")}`;
  };
  check(
    "--isolated sai em todas as formas",
    ["--isolated", "--isolated=true", "--isolated true"].every((f) => arg("--headless", ...f.split(" "), "--slim") === "true --headless --slim")
  );
  check(
    "navegador ou perfil do usuário: argumentos intactos",
    ["--browserUrl http://x", "--browser-url=http://x", "-u http://x", "--wsEndpoint ws://x", "--autoConnect", "--userDataDir=C:/x", "--user-data-dir C:/x"].every(
      (f) => arg(...f.split(" ")) === `false ${f}`
    )
  );
  check("argumento repassado ao Chrome não é confundido", arg("--chromeArg=--user-data-dir-x").startsWith("true "));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DO PERFIL DO NAVEGADOR PASSARAM");
