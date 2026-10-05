---
name: debugar-advpl
description: "Depurar ou executar rotina AdvPL/TLPP no AppServer pelo MCP tds (tds_debug_*, tds_run). Use para depurar (breakpoint, valor de variável em execução), rodar/testar uma User Function ou relatório no servidor, ou reproduzir erro de execução (error.log)."
---

# Depurar AdvPL/TLPP

As tools `tds_debug_*` e `tds_run` ligam o depurador da TOTVS ao AppServer conectado e
rodam o programa no SmartClient HTML (webapp). As descrições das tools são a fonte do
que cada parâmetro faz; aqui está o processo. Modo navegador, módulo, REST/jobs e
problemas comuns: [REFERENCE.md](REFERENCE.md).

O estado devolvido é **parado** (há local, pilha e variáveis), **executando** (não parou
no prazo; no headless vêm `tela` e `botoes`, no navegador vem `conectado`) ou
**encerrado** (programa terminou; erro vem em `erroDeExecucao` ou numa mensagem
`ERROR`). Arquivo que o programa manda ao navegador (PDF, `CpyS2TW`) vem em
`arquivosBaixados`, com o caminho local.

## Passos

1. **Licença.** Pergunte ao usuário: "Posso executar/depurar `<programa>` em
   `<servidor>/<ambiente>`?" O programa roda de verdade, grava o que gravar, e parado num
   breakpoint segura a thread no servidor. A licença vale para aquele servidor nesta
   conversa.
   Concluído quando: o usuário autorizou servidor e ambiente.

2. **Caminho.** Escolha pelo que a rotina precisa:
   - Saber se roda ou qual erro dá, sem tela: `tds_run`.
   - Rotina sem tela: `tds_debug_start` modo `headless`.
   - Rotina que usa o ambiente do usuário (empresa e filial abertas, `Pergunte`, `MV_`,
     tabela posicionada pelo menu) ou tem tela: modo `navegador` com `modulo` (código ou
     nome, ex.: `"04"` / `"SIGAEST"`) e a rotina em `programa`. O tds-mcp abre pelo
     SIGABPM; você faz o login e confirma os diálogos de entrada no chrome-devtools
     (REFERENCE.md, "Rotina dentro do módulo").
   - Rotina que precisa de parâmetros e de ambiente ao mesmo tempo: wrapper `U_zTst...`
     que monta o cenário e chama a rotina, compilado como **temporário** (passo 3).
     O wrapper com `RpcSetEnv` roda em modo automático: `Pergunte` não mostra tela e a
     data sai com ano de 2 dígitos; para ver o que o usuário vê, use `modulo`.
   - StartJob, REST, job: modo `job`, só em AppServer de desenvolvimento dedicado
     (REFERENCE.md, "REST e jobs").
   Concluído quando: o caminho escolhido cobre o que a rotina precisa de ambiente e de
   parâmetro.

3. **Fonte alinhado.** `tds_use_server` no servidor autorizado (com `usuario` e `senha`
   quando o usuário os passar; valem só para a sessão) e `tds_compile` do fonte local: o
   depurador casa breakpoint por nome de arquivo e linha. Wrapper e fonte de teste vão
   com `temporario: true`, o que permite removê-los do RPO no fim.
   Concluído quando: a compilação deu `sucesso` ou `SKIPPED`, e o `tds_debug_start` não
   trouxer `avisos` de fonte divergente.

4. **Breakpoints no caso certo.** Ponha o breakpoint numa linha com instrução
   (atribuição, chamada, `If`, `While`, `For`, `Return`); `avisos` aponta linha onde o
   depurador não para. Prefira `condicao` que isole o caso investigado
   (`nI == 50`, `SA1->A1_COD == "000123"`) a parar em toda passagem; em laço longo, use
   `rastro` para colher valores sem parar.
   Concluído quando: estado `parado` no ponto esperado (ou `executando` com
   `conectado: true` no modo navegador, aguardando a tela) e nenhum aviso de linha.

5. **Espera.** `tds_debug_wait` com `timeoutSeg` até 100 por chamada; repita enquanto
   vier `executando`. A cada `executando`, leia a tela (`tela`/`botoes` no headless,
   `take_snapshot` no navegador): um diálogo esperando resposta não termina sozinho.

6. **Inspeção — o motivo da sessão.** Leia local, pilha, variáveis e `alteradas`;
   aprofunde com `tds_debug_variables` (chamadores pelo `frame`, `Public`, `Table`),
   `tds_debug_watch` e `tds_debug_evaluate`. Atribuição (`x := v`) altera o programa:
   use para testar hipótese e registre o que alterou.
   Concluído quando: a pergunta que motivou a depuração tem resposta com valores
   observados na execução.

7. **Navegação.** `tds_debug_step` para avançar; para interromper um programa rodando ou
   rodar até uma linha, inclua o breakpoint com `tds_debug_breakpoints`.

8. **Encerramento.** `tds_debug_stop` ao terminar, inclusive quando a sessão falhou. No
   modo navegador, siga o `fecharAba` do retorno: `list_pages` e `close_page` da aba do
   contexto `tds-<id>`; programa que não estava parado num breakpoint segue no AppServer
   até a aba sair. Wrapper
   temporário que cumpriu o papel: `tds_rpo_temporarios` mostra o que ficou no RPO;
   remova com `tds_rpo_delete` depois de o usuário confirmar.
   Concluído quando: `encerrada`, nenhuma aba `tds-*` aberta no chrome-devtools e
   `tds_monitor_users` filtrado pela rotina sem thread dela.

## Relato

Relate o observado: linha, valores das variáveis relevantes, o que mudou entre paradas,
erro com fonte/linha, arquivos gerados (`arquivosBaixados`). Separe observado de
hipótese. Se alterou variável com `:=`, diga qual e o valor. Diga se ficou fonte
temporário no RPO.
