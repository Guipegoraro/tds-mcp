// Teste da recusa de operações no RPO durante a depuração (DebugManager), sem adaptador nem AppServer.
// Uso: node test/debug-manager.test.mjs
import assert from "node:assert/strict";
import { DebugManager } from "../dist/debug.js";

let falhas = 0;
function check(nome, condicao, detalhe = "") {
  if (!condicao) falhas++;
  console.log(`${condicao ? "PASS" : "FAIL"}  ${nome}${detalhe ? `\n      ${detalhe}` : ""}`);
}

/** Sessão como o DebugManager a enxerga; os campos privados só são privados no TypeScript. */
const sessao = ({ porTdsRun = false, ended = false, vivo = true, stop } = {}) => ({
  programa: "u_zTeste",
  servidor: "SrvTeste",
  iniciadaEm: new Date(2026, 9, 6, 14, 5),
  porTdsRun,
  dap: { alive: vivo, kill() {} },
  stop,
  get encerrada() {
    return ended || !this.dap.alive;
  },
});
const novo = () => new DebugManager(10);
const recusa = (m) => m.recusaNaDepuracao("compilar");

check("sem sessão, nada é recusado", recusa(novo()) === undefined);

const aberta = novo();
aberta.current = sessao();
const msgAberta = recusa(aberta) ?? "";
check(
  "sessão aberta do tds_debug_start: recusa com programa, servidor, hora e tds_debug_stop",
  /Recusado durante a depuração/.test(msgAberta) &&
    msgAberta.includes("u_zTeste em SrvTeste (desde 14:05)") &&
    /tds_debug_stop antes de compilar/.test(msgAberta) &&
    !/tds_run/.test(msgAberta),
  msgAberta
);

const run = novo();
run.current = sessao({ porTdsRun: true });
const msgRun = recusa(run) ?? "";
check("tds_run em andamento: manda esperar, sem tds_debug_stop", /tds_run de u_zTeste/.test(msgRun) && !/tds_debug_stop/.test(msgRun), msgRun);

const iniciando = novo();
iniciando.starting = { programa: "u_zIni", servidor: "SrvTeste", desde: new Date(), porTdsRun: true };
check("start em andamento já conta", /tds_run de u_zIni/.test(recusa(iniciando) ?? ""), recusa(iniciando));

const morta = novo();
morta.current = sessao({ vivo: false });
check("sessão com o adaptador já encerrado não recusa", recusa(morta) === undefined);

const terminada = novo();
terminada.current = sessao({ ended: true });
check("sessão terminada (evento lido) não recusa", recusa(terminada) === undefined);

const encerrando = novo();
encerrando.stopping = sessao();
const msgEnc = recusa(encerrando) ?? "";
check("sessão em encerramento: pede para tentar de novo", /sendo encerrada; tente compilar de novo/.test(msgEnc), msgEnc);

// Ciclo real do stop(): recusa até o encerramento da sessão (adaptador e navegador) terminar.
let liberar;
const fim = new Promise((r) => (liberar = r));
const parando = novo();
parando.current = sessao({ stop: () => fim });
const p = parando.stop();
const durante = recusa(parando) ?? "";
check("durante o stop() real: recusa como encerramento", /sendo encerrada/.test(durante), durante);
liberar();
await p;
check("terminado o stop(): nada é recusado", recusa(parando) === undefined, recusa(parando));

const ocupado = novo();
ocupado.current = sessao();
let erroStart = "";
await ocupado.start({ programa: "u_outro", active: { def: { name: "SrvTeste" } } }).catch((e) => (erroStart = e.message));
check("start com sessão aberta continua recusado", /Depurador ocupado: u_zTeste em SrvTeste desde 14:05/.test(erroStart), erroStart);

assert.equal(falhas, 0, `${falhas} caso(s) falharam`);
console.log("\nTODOS OS CASOS DO DEBUGMANAGER PASSARAM");
