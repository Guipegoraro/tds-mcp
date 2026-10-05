# Depurar AdvPL — referência

Consultado a partir do [SKILL.md](SKILL.md). Medido com tds-da 1.4.x (tds-vscode 2.1.4),
chrome-devtools-mcp 1.10 e AppServer 24.3 / release 12.1.2510.

## Modo navegador

1. `tds_debug_start` com `modo: "navegador"` devolve `abrirCom`: `url`
   (`...webapp/?DEBUG=<id>&E=<amb>&P=<programa>`) e `isolatedContext` (`tds-<id>`).
2. Abra com `new_page` do chrome-devtools passando **os dois**: `url` e
   `isolatedContext`. O contexto isolado é uma janela com armazenamento limpo; o perfil
   normal guarda o último programa e o TOTVS WebAgent, e o webapp então troca a URL pelo
   formulário "Parâmetros Iniciais" e roda o programa fora do depurador.
3. Opere a tela até a ação que leva ao breakpoint. `take_snapshot` lê textos, campos e
   botões (componentes `wa-*`; rótulo com tecla de atalho aparece partido, "D" +
   "etalhes"). Campo caractere: `fill`. Campo numérico com máscara (`@E 999`): `fill`
   acrescenta ao valor existente — clique no campo, `press_key` `Control+A` e
   `type_text`. Botão que não responde ao `click`: com ele em foco, `press_key` `Enter`.
4. `tds_debug_wait` (até 100 s por chamada) acompanha. `conectado: false` = nenhum webapp
   abriu esta sessão: confira a aba (passo 2). `conectado: true` com `executando` = o
   programa espera algo na tela. Parado, a tela congela; depois de
   `tds_debug_step continuar`, opere a tela de novo (MsgInfo, confirmações).
5. Ao terminar, `tds_debug_stop` e `close_page` da aba `tds-<id>` (o retorno traz
   `fecharAba`). Aba aberta mantém a thread viva no AppServer, já sem depurador, e cada
   sessão esquecida deixa uma janela a mais.

Erro de execução na tela: "SMARTCLIENT um problema foi encontrado na execução". O
botão "Detalhes" traz mensagem, linha, pilha com as variáveis de cada nível e o
ambiente; leia com `take_snapshot` e clique "Fechar" — só então a thread termina e o
depurador registra o erro.

## Rotina dentro do módulo (`modulo`)

`tds_debug_start` com `programa: "u_zRotina"`, `modulo: "04"` e `modo: "navegador"`. A
rotina roda como pelo menu: empresa, filial, data base, `MV_` e variáveis do módulo
(`CFILEXNU = "SIGAEST"`, `AMODULOS`). Sem argumentos: o SIGABPM só repassa módulo e rotina. Telas, na
ordem em que apareceram no 1234 (variam por ambiente):

1. Login (usuário e senha do Protheus): `fill` nos dois campos e "Entrar".
2. Empresa/filial/data base, já preenchidos com o último acesso: confira e "Entrar".
3. Aviso "Este ambiente utiliza base de Desenvolvimento": "Fechar" (aparece sempre na
   base de desenvolvimento).
4. Diálogos de entrada do módulo (no Estoque: "Moedas", com as taxas do dia):
   "Confirmar".
5. A rotina começa; o breakpoint para.

A carga pode levar minutos na base local; enquanto carrega, `take_snapshot` mostra
"Carregando" ou vem vazio. Códigos comuns: 02 SIGACOM, 04 SIGAEST, 05 SIGAFAT,
06 SIGAFIN, 10 SIGAPCP, 34 SIGACTB.

## Headless (`tds_run` e modo `headless`)

- `executando` traz `tela` e `botoes`: diálogo esperando resposta não termina sozinho.
  Relatório que grava arquivo de nome fixo para no "O arquivo ... já existe. Deseja
  sobrescrevê-lo?" a partir da segunda execução: o fonte apaga o arquivo antes de gerar
  (`If File(cArq)` / `FErase(cArq)`) ou usa nome único.
- Arquivo enviado ao navegador (PDF do FWMSPrinter, `CpyS2TW`) vem em
  `arquivosBaixados`; `pastaDownloads` escolhe onde gravar (ex.: a pasta do ticket).
  Sem WebAgent (headless), o FWMSPrinter com `lViewPDF` gerou o PDF no `\spool\` do
  servidor e o enviou ao navegador.

## REST e jobs (modo `job`)

Só threads criadas depois que o depurador conecta são depuráveis, e o modo `job`
captura toda thread nova do ambiente, inclusive jobs do próprio servidor (ex.:
`FWLSMANAGERPULSE`); quando uma dessas termina, a sessão pode encerrar. Por isso: AppServer
de desenvolvimento dedicado e depurador iniciado primeiro.

Receita da TOTVS (docs/debugger.md do tds-vscode):

1. No appserver.ini do servidor de desenvolvimento: comentar o `[OnStart]` (ou deixar só
   os jobs necessários, com `RefreshRate=30`) e `[General] BUILDKILLUSERS=1` (compilar
   derruba todas as conexões da instância); reiniciar o AppServer.
2. Encerrar threads antigas com `tds_monitor_users` + `tds_monitor_kill_user`, com
   autorização do usuário.
3. `tds_debug_start` modo `job`, breakpoint no fonte do serviço e `programa` uma função
   que dispare o job e espere:
   `User Function zStartRest()` → `StartJob("HTTP_START", GetEnvServer(), .F.)` →
   `Sleep(60000)`.
4. Dispare a requisição por fora (curl, Postman, a tela que chama a API) e
   `tds_debug_wait`.

Verificado: breakpoint em função iniciada por `StartJob` para, com os parâmetros
recebidos visíveis. Sem verificação aqui: REST na porta multiprotocolo da 12.1.2510 (há
relato aberto na TOTVS de breakpoint que não para nesse cenário).

## Fontes temporários

`tds_compile` com `temporario: true` registra o fonte em
`~/.claude/tds-mcp/temporarios.json` (por servidor e ambiente); compilar de novo sem a
marca tira do registro. `tds_rpo_temporarios` lista e diz se ainda está no RPO;
`tds_rpo_delete` remove só os registrados, com confirmação do usuário. Fonte fora do
registro sai apenas com `foraDoRegistro: true` quando o usuário pede aquele fonte pelo
nome; objeto oficial TOTVS é sempre recusado.

## Problemas comuns

- **Formulário "Parâmetros Iniciais" no lugar do programa**: a URL foi aberta fora do
  contexto isolado. Feche a aba e abra de novo com `new_page` + `isolatedContext`.
- **"exige autenticação ... token de reconexão do TDS não funcionou"**: o token salvo
  pelo VS Code expirou. Peça usuário e senha e passe em `tds_use_server`, ou o usuário
  conecta no servidor pelo VS Code (renova o token).
- **AppServer reiniciado ou MCP reconectado**: a sessão do tds-mcp cai; `tds_use_server`
  de novo.
- **`executando` sem parar**: o programa espera interação (veja `tela` ou
  `take_snapshot`), a linha do breakpoint não é executada nesse caminho, ou o RPO tem
  outra versão do fonte (veja `avisos`).
- **Chamada de `tds_debug_wait` que passa de ~120 s** vai para segundo plano no cliente:
  use `timeoutSeg` até 100 e repita.
- **Webapp em porta própria**: o padrão é `http(s)://<endereço>:<porta>/webapp/` (porta
  multiprotocolo); outra URL vai em `webappUrls` no `~/.tds-mcp/config.json`, por nome
  do servidor.
- **`Array {size=NIL}` num frame chamador**: expanda com `caminho` para ver os itens.
