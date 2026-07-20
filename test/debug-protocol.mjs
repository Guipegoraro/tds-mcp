// Debug de protocolo em baixo nível: fala JSON-RPC cru com o advpls.
//
// Envia $totvsserver/validation SEM handshake LSP `initialize` — é assim que o
// advpls espera ser usado. (Enviar `initialize` com params mínimos derruba o
// processo com 0xC0000409; por isso o AdvplsClient não faz handshake.)
//
// Uso: node test/debug-protocol.mjs [host] [porta]
import { spawn } from "node:child_process";
import { resolveAdvplsPath } from "../dist/advpls.js";

const host = process.argv[2] ?? "localhost";
const port = Number(process.argv[3] ?? 1234);

const advplsPath = resolveAdvplsPath();
const proc = spawn(advplsPath, ["language-server", "--notification-level=none"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

proc.on("exit", (code) => console.log("[exit] code=%s", code));
proc.stdout.on("data", (d) => console.log("[stdout]", JSON.stringify(d.toString().substring(0, 800))));
proc.stderr.on("data", (d) => console.log("[stderr]", JSON.stringify(d.toString().substring(0, 300))));

function send(obj) {
  const msg = JSON.stringify(obj);
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(msg, "utf-8")}\r\n\r\n${msg}`);
  console.log("[send]", obj.method);
}

send({
  jsonrpc: "2.0",
  id: 1,
  method: "$totvsserver/validation",
  params: { validationInfo: { server: host, port, serverType: "totvs_server_protheus" } },
});

setTimeout(() => {
  proc.kill();
  process.exit(0);
}, 15000);
