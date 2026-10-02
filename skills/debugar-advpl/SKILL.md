---
name: debugar-advpl
description: "Depurar ou executar rotina AdvPL/TLPP no AppServer pelo MCP tds (tds_debug_*, tds_run). Use para depurar (breakpoint, valor de variável em execução), rodar/testar uma User Function no servidor, ou reproduzir erro de execução (error.log)."
---

# Depurar AdvPL/TLPP

As tools `tds_debug_*` e `tds_run` ligam o depurador da TOTVS ao AppServer conectado e
rodam o programa no SmartClient HTML (webapp). As descrições das tools são a fonte do
que cada parâmetro faz; aqui está o processo. Modo navegador, REST/jobs e problemas
comuns: [REFERENCE.md](REFERENCE.md).

O estado devolvido é **parado** (há local, pilha e variáveis), **executando** (não parou
no prazo) ou **encerrado** (programa terminou; erro vem em `erroDeExecucao` ou numa
mensagem `ERROR`).

## Passos

1. **Licença.** Pergunte ao usuário: "Posso executar/depurar `<programa>` em
   `<servidor>/<ambiente>`?" O programa roda de verdade, grava o que gravar, e parado num
   breakpoint segura a thread no servidor. A licença vale para aquele servidor nesta
   conversa.
   Concluído quando: o usuário autorizou servidor e ambiente.

2. **Fonte alinhado.** `tds_use_server` no servidor autorizado (com `usuario` e `senha`
   quando o usuário os passar; valem só para a sessão) e `tds_compile` do fonte local: o
   depurador casa breakpoint por nome de arquivo e linha.
   Concluído quando: a compilação deu `sucesso` ou `SKIPPED`, e o `tds_debug_start` não
   trouxer `avisos` de fonte divergente.

3. **Caminho.**
   - Saber se roda ou qual erro dá: `tds_run`.
   - Rotina sem tela: `tds_debug_start` modo `headless`.
   - Rotina com tela: modo `navegador`, operando as telas pelo chrome-devtools
     (REFERENCE.md, "Modo navegador").
   - StartJob, REST, job: modo `job`, só em AppServer de desenvolvimento dedicado
     (REFERENCE.md, "REST e jobs").

4. **Breakpoints no caso certo.** Ponha o breakpoint numa linha com instrução
   (atribuição, chamada, `If`, `While`, `For`, `Return`); `avisos` aponta linha onde o
   depurador não para. Prefira `condicao` que isole o caso investigado
   (`nI == 50`, `SA1->A1_COD == "000123"`) a parar em toda passagem; em laço longo, use
   `rastro` para colher valores sem parar.
   Concluído quando: estado `parado` no ponto esperado (ou `executando` no modo
   navegador, aguardando a tela) e nenhum aviso de linha.

5. **Inspeção — o motivo da sessão.** Leia local, pilha, variáveis e `alteradas`;
   aprofunde com `tds_debug_variables` (chamadores pelo `frame`, `Public`, `Table`),
   `tds_debug_watch` e `tds_debug_evaluate`. Atribuição (`x := v`) altera o programa:
   use para testar hipótese e registre o que alterou.
   Concluído quando: a pergunta que motivou a depuração tem resposta com valores
   observados na execução.

6. **Navegação.** `tds_debug_step` para avançar; para interromper um programa rodando ou
   rodar até uma linha, inclua o breakpoint com `tds_debug_breakpoints`.

7. **Encerramento.** `tds_debug_stop` ao terminar, inclusive quando a sessão falhou.
   Concluído quando: `encerrada` e `tds_monitor_users` filtrado pela rotina sem thread
   dela.

## Relato

Relate o observado: linha, valores das variáveis relevantes, o que mudou entre paradas,
erro com fonte/linha. Separe observado de hipótese. Se alterou variável com `:=`, diga
qual e o valor.
