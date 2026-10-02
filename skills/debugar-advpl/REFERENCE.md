# Depurar AdvPL — referência

Consultado a partir do [SKILL.md](SKILL.md). Medido com tds-da 1.4.x (tds-vscode 2.1.4)
e AppServer 24.3 / release 12.1.2510.

## Modo navegador

1. `tds_debug_start` com `modo: "navegador"` devolve `url`
   (`...webapp/?DEBUG=<id>&E=<amb>&P=<programa>`).
2. Abra a `url` na aba existente do chrome-devtools: `list_pages`, depois
   `navigate_page` nela. Se aparecer diálogo `beforeunload` (da sessão anterior do
   webapp), `handle_dialog` com `accept`.
3. Opere a tela até a ação que leva ao breakpoint. `take_snapshot` lê textos, campos e
   botões (componentes `wa-*`; rótulo com tecla de atalho aparece partido, "D" +
   "etalhes"). Campo caractere: `fill`. Campo numérico com máscara (`@E 999`): `fill`
   acrescenta ao valor existente — clique no campo, `press_key` `Control+A` e
   `type_text`.
4. `tds_debug_wait` espera a parada. Parado, a tela congela; depois de
   `tds_debug_step continuar`, opere a tela de novo (MsgInfo, confirmações). Estado
   `executando` com `dica`: o programa espera algo na tela.

Erro de execução na tela: "SMARTCLIENT um problema foi encontrado na execução". O
botão "Detalhes" traz mensagem, linha, pilha com as variáveis de cada nível e o
ambiente; leia com `take_snapshot` e clique "Fechar" — só então a thread termina e o
depurador registra o erro.

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

## Problemas comuns

- **"exige autenticação ... token de reconexão do TDS não funcionou"**: o token salvo
  pelo VS Code expirou. Peça usuário e senha e passe em `tds_use_server`, ou o usuário
  conecta no servidor pelo VS Code (renova o token).
- **AppServer reiniciado**: a sessão do tds-mcp cai; `tds_use_server` de novo.
- **`executando` sem parar**: o programa espera interação (modo navegador), a linha do
  breakpoint não é executada nesse caminho, ou o RPO tem outra versão do fonte (veja
  `avisos`).
- **Webapp em porta própria**: o padrão é `http(s)://<endereço>:<porta>/webapp/` (porta
  multiprotocolo); outra URL vai em `webappUrls` no `~/.tds-mcp/config.json`, por nome
  do servidor.
- **`Array {size=NIL}` num frame chamador**: expanda com `caminho` para ver os itens.
