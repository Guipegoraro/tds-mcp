---
name: debugar-advpl
description: "Depurar ou executar rotina AdvPL/TLPP no AppServer pelo MCP tds (tds_debug_*, tds_run). Use para depurar (breakpoint, valor de variável em execução), rodar/testar uma User Function ou relatório no servidor, ou reproduzir erro de execução (error.log)."
---

# Depurar AdvPL/TLPP

As tools `tds_debug_*` e `tds_run` ligam o depurador da TOTVS ao AppServer conectado e
rodam o programa no SmartClient HTML (webapp). As descrições das tools são a fonte do
que cada parâmetro e campo de retorno significa; aqui está o processo. Modo navegador,
módulo, headless, REST/jobs, temporários e problemas comuns:
[REFERENCE.md](REFERENCE.md).

Dois vocabulários de resultado:

- `tds_run` devolve `resultado`: **concluido**, **erro** (mensagem, fonte/linha, pilha) ou
  **tempoEsgotado** (vêm `tela` e `botoes`; a execução é encerrada).
- `tds_debug_start`/`wait`/`step` devolvem `estado`: **parado** (local, pilha,
  variáveis), **executando** (não parou no prazo; headless traz `tela` e `botoes`,
  navegador traz `conectado`) ou **encerrado** (programa terminou; erro em
  `erroDeExecucao` ou mensagem de nível `ERROR`).

Arquivo que o programa manda ao navegador (PDF, `CpyS2TW`) vem em `arquivosBaixados`,
com o caminho local, nos modos headless e job.

## Passos

1. **Licença.** Pergunte ao usuário: "Posso executar/depurar `<programa>` em
   `<servidor>/<ambiente>`?" e, se for compilar algo (passo 3), cite os fontes na mesma
   pergunta. O programa roda de verdade, grava o que gravar, e parado num breakpoint
   segura a thread no servidor; compilar troca no RPO a versão que estiver lá (num
   ambiente compartilhado, a de um colega). Ambiente de produção: confirme de novo, à
   parte, antes de executar ou compilar. A licença vale para aquele servidor nesta
   conversa.
   Concluído quando: o usuário autorizou servidor, ambiente e o que será compilado.

2. **Caminho.** Escolha pelo que a rotina precisa:
   - Saber se roda ou qual erro dá, sem tela, sem empresa e em até ~100 s: `tds_run`
     com `timeoutSeg` adequado (padrão 60; no tempo esgotado a execução é interrompida no
     meio). A função roda sem empresa aberta (sem `xFilial`, SX, `MV_`). O `tds_run` não
     devolve o valor de retorno: para ver o que a função devolve, use o wrapper com
     `rastro` no `Return` (REFERENCE.md, "Wrapper de teste").
   - Rotina sem tela, ou processamento que pode passar de 100 s: `tds_debug_start` modo
     `headless`, repetindo `tds_debug_wait` (também sem empresa aberta).
   - Rotina que usa o ambiente do usuário (empresa e filial, `Pergunte`, `MV_`) ou tem
     tela: modo `navegador` com `modulo` e a rotina em `programa`. Sem o módulo no
     pedido, pergunte ao usuário em qual módulo a rotina roda. Você faz o login e
     confirma as telas de entrada no chrome-devtools (REFERENCE.md, "Rotina dentro do
     módulo").
   - Rotina com parâmetro numérico, lógico ou data (`argumentos` chegam sempre como
     caractere e não combinam com `modulo`), com parâmetro e ambiente ao mesmo tempo,
     chamada por StartJob/agendamento, ou cujo arquivo gerado (PDF) você precisa
     conferir: wrapper que monta o cenário e chama a rotina, com nome = `prefixoWrapper`
     (devolvido por `tds_use_server`, único por pessoa e máquina) + 3 letras da rotina,
     ex.: `U_zTK3FRel` (no mesmo RPO outro desenvolvedor pode ter o dele), rodado com
     `tds_run` ou no modo headless (o arquivo volta em `arquivosBaixados`) e compilado
     como **temporário** (REFERENCE.md, "Wrapper de teste"). Empresa, filial e respostas
     de pergunta (`MV_PARxx`) vêm do usuário; sem elas, pergunte. Função que já recebe
     empresa e filial e abre o próprio ambiente roda direto, com elas em `argumentos`.
   - Rotina que depende do TOTVS WebAgent (arquivo na máquina do usuário, Excel,
     `GetRemoteType()` 1): o modo navegador já o liga; nos outros, `webAgent: true`
     (REFERENCE.md, "TOTVS WebAgent").
   - O caminho HTTP de um REST, ou a thread exata que o StartJob cria: modo `job`, só
     quando o usuário confirmar que o AppServer é exclusivo dele (nenhum outro
     desenvolvedor ou usuário conectado; "é o de desenvolvimento" não basta) e quem
     ajusta o appserver.ini (REFERENCE.md, "REST e jobs").
   - Pedido com arquivo e linha, sem dizer que rotina executa aquele trecho: pergunte a
     rotina ou o menu de entrada; o `programa` é o ponto de entrada, não a função que
     contém a linha.
   Concluído quando: o caminho escolhido cobre o que a rotina precisa de ambiente e de
   parâmetro.

3. **Fonte alinhado.** `tds_use_server` no servidor autorizado (com `usuario` e `senha`
   quando o usuário os passar; valem só para a sessão). Confira a rotina testada e os
   fontes dos breakpoints: `tds_rpo_objects` mostra a data do fonte no RPO (compare com a
   do arquivo local) e o `tds_debug_start` traz em `avisos` o arquivo local diferente do
   RPO, dizendo qual lado é mais novo. Se o arquivo local é mais novo, pergunte se o
   teste é da versão local (compilar) ou da que está no RPO. Se o RPO é mais novo (outra
   pessoa compilou depois), não compile por cima: pergunte ao usuário. Para rodar o que já está no RPO, não compile. Compilar fonte
   que a licença do passo 1 não citou pede nova pergunta. Wrapper e fonte de teste vão
   com `temporario: true`, o que permite removê-los do RPO no fim.
   - Compilação com erro: o RPO continua com a versão anterior e os breakpoints cairiam
     nas linhas dela. Mostre o erro ao usuário e pergunte se corrige o fonte ou depura a
     versão do RPO (aí sem breakpoint pelo arquivo local alterado).
   - `avisos` de fonte divergente depois do start: `tds_debug_stop`, compile (com
     licença para aquele fonte) e inicie de novo; não compile com a sessão aberta. O
     aviso compara datas de arquivo. Quando ele disse "arquivo local mais novo" e o
     `tds_compile` devolveu `SKIPPED`, o conteúdo é o mesmo do RPO (a data mudou por um
     checkout do git, por exemplo) e o aviso pode ser ignorado. Quando disse "RPO mais
     novo", `SKIPPED` não prova nada: só compile a versão local se o usuário pedir, com
     `recompile: true`.
   Concluído quando: o RPO tem a versão do fonte dos breakpoints (sem `avisos` de fonte
   divergente) ou o usuário decidiu depurar a versão do RPO.

4. **Breakpoints no caso certo.** Para investigar um erro de execução sem saber onde
   ele está, rode primeiro sem breakpoint: `erroDeExecucao` traz fonte, linha e pilha;
   depois ponha o breakpoint antes da linha do erro e rode de novo. Ponha o breakpoint
   numa linha com instrução (atribuição, chamada, `If`, `While`, `For`, `Return`);
   `avisos` aponta linha onde o
   depurador não para. Prefira `condicao` que isole o caso investigado
   (`nI == 50`, `SA1->A1_COD == "000123"`) a parar em toda passagem; em laço longo, use
   `rastro` para colher valores sem parar.
   Concluído quando: estado `parado` no ponto esperado (ou `executando` com
   `conectado: true` no modo navegador, aguardando a tela) e nenhum aviso de linha.

5. **Espera.** `tds_debug_wait` com `timeoutSeg` até 100 por chamada; repita enquanto
   vier `executando`. A cada `executando`, leia a tela (`tela`/`botoes` no headless,
   `take_snapshot` no navegador): um diálogo esperando resposta não termina sozinho. No
   headless não há como responder a ele: encerre e ajuste o fonte ou use o modo
   navegador.

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
   até a aba sair. Wrapper temporário que cumpriu o papel: `tds_rpo_temporarios` mostra
   o que ficou no RPO; remova com `tds_rpo_delete` depois de o usuário confirmar fontes,
   servidor e ambiente.
   Concluído quando: `encerrada`, nenhuma aba `tds-*` aberta no chrome-devtools e
   `tds_monitor_users` sem thread da execução: filtre pelo programa inicial (`SIGABPM` com
   `modulo`, senão o nome da função ou do wrapper). A sua é a de `computador` igual ao
   `maquinaLocal` do `tds_use_server` (sem diferenciar maiúsculas). Exceção: thread
   criada por StartJob ou REST (modo `job`) nasce no AppServer e traz o computador do
   servidor; procure-a pelo nome da função do job e pela hora de conexão, e confira se o
   wrapper que espera (`Sleep`) também terminou. No mesmo servidor pode haver sessão de
   outro
   desenvolvedor com o mesmo programa e usuário. Derrubar thread (`tds_monitor_*`) só
   com autorização do usuário e quando a identificação não deixa dúvida; com dúvida,
   mostre a lista e pergunte.

## Relato

Relate o observado: linha, valores das variáveis relevantes, o que mudou entre paradas,
erro com fonte/linha, arquivos gerados (`arquivosBaixados`). Quando a rotina depende do
WebAgent (pedido com `webAgent: true` ou ligado pelo modo navegador) e o retorno trouxe
`webAgent.ativo: false`, diga que o caminho do agente não foi testado e que a rotina pode
ter seguido o outro ramo. Separe observado de
hipótese. Se alterou variável com `:=`, diga qual e o valor. Diga se ficou fonte
temporário no RPO.
