// Contador de senha errada da conta do Windows, usado pelos e2e que abrem navegador.
import { execFileSync } from "node:child_process";

/** Contador e limite de senhas erradas da conta local (limite 0 = sem bloqueio); texto com o motivo quando não dá para medir. */
export function lerConta() {
  const script =
    "$ErrorActionPreference='Stop'; if ($env:USERDOMAIN -ne $env:COMPUTERNAME) { 'conta de domínio'; exit }; " +
    "$u=[adsi]\"WinNT://$env:COMPUTERNAME/$env:USERNAME,user\"; " +
    "if ($u.InvokeGet('IsAccountLocked')) { 'conta bloqueada'; exit }; " +
    "\"$($u.BadPasswordAttempts.Value) $($u.MaxBadPasswordsAllowed.Value)\"";
  try {
    const saida = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
    const m = /^(\d+) (\d+)$/.exec(saida);
    return m ? { erros: Number(m[1]), limite: Number(m[2]) } : saida;
  } catch (e) {
    return `contador indisponível: ${e.message.split("\n")[0]}`;
  }
}

/** Motivo para não medir agora, ou undefined: conta local, desbloqueada, contador em zero e margem até o limite. */
export function motivoParaPular(margem) {
  const conta = lerConta();
  if (typeof conta === "string") return conta;
  // O Windows zera o contador sozinho: só partindo de zero um zero no fim significa que nada foi contado.
  if (conta.erros !== 0) return `contador em ${conta.erros}; espere zerar (net accounts mostra a janela)`;
  // Se a medição falhar, cada abertura custa uma tentativa.
  if (conta.limite !== 0 && conta.limite <= margem) return `limite de ${conta.limite} tentativas não dá margem para medir`;
}
