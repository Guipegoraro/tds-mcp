# Depurar AdvPL — referência

Consultado a partir do [SKILL.md](SKILL.md). Comportamentos medidos com o depurador do
tds-vscode 2.1.4 (tds-da 1.4.x), chrome-devtools-mcp 1.10 e AppServer 24.3 / release
12.1.2510; outra versão pode diferir.

## Modo navegador

1. `tds_debug_start` com `modo: "navegador"` devolve `abrirCom`: `url`
   (`...webapp/?DEBUG=<id>&E=<amb>&P=<programa>`) e `isolatedContext` (`tds-<id>`).
2. Abra com `new_page` do chrome-devtools passando **os dois**: `url` e
   `isolatedContext`. O contexto isolado é uma janela com armazenamento limpo. No perfil
   normal o webapp lembra o último programa e a opção do TOTVS WebAgent (agente local
   da TOTVS para arquivos e impressão), troca a URL pelo formulário "Parâmetros
   Iniciais" e roda o programa fora do depurador.
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
   `fecharAba`). O stop derruba a thread parada num breakpoint; a que roda ou espera um
   diálogo continua no AppServer, já sem depurador, até a aba fechar. Cada sessão
   esquecida deixa também uma janela a mais. A janela `about:blank` é a do próprio
   chrome-devtools: fica aberta enquanto ele estiver ativo e não fecha por `close_page`.

Erro de execução na tela: "SMARTCLIENT um problema foi encontrado na execução". O
botão "Detalhes" traz mensagem, linha, pilha com as variáveis de cada nível e o
ambiente; leia com `take_snapshot` e clique "Fechar" — só então a thread termina e o
depurador registra o erro.

Arquivo gerado no modo navegador: o download fica com o navegador do chrome-devtools e
não volta em `arquivosBaixados`; `tds_server_files` só lista pastas do servidor, não
baixa. Para receber o arquivo, rode um wrapper (seção "Wrapper de teste") com `tds_run`
ou no modo headless. Se o usuário quer ver a tela do `Pergunte` e também o arquivo,
são duas execuções: uma no navegador com `modulo`, outra com o wrapper.

## Rotina dentro do módulo (`modulo`)

`tds_debug_start` com `programa: "u_zRotina"`, `modulo: "04"` e `modo: "navegador"`. A
rotina roda como pelo menu: empresa, filial, data base, `MV_`, variáveis do módulo
(`cModulo`, `nModulo`), `Pergunte` com tela e data com século. Sem argumentos: o SIGABPM
só repassa módulo e rotina. Telas de entrada (variam por ambiente e versão):

1. Login: usuário e senha do Protheus, os mesmos usados no `tds_use_server`; sem eles,
   peça ao usuário. `fill` nos dois campos e "Entrar".
2. Data base, empresa (campo "Grupo") e filial, preenchidos com o último acesso desse
   usuário. Se o usuário pediu outra empresa ou filial, troque com `fill` antes de
   "Entrar".
3. Aviso de base de desenvolvimento, quando o ambiente for de desenvolvimento: "Fechar".
4. Diálogos de entrada do módulo (no Estoque: "Moedas", com as taxas do dia, uma vez por
   dia): confirme.
5. A rotina começa; o breakpoint para.

A carga do módulo pode levar minutos; enquanto carrega, `take_snapshot` mostra
"Carregando" ou vem vazio. No `tds_monitor_users` a thread aparece como programa
`SIGABPM`. Códigos comuns: 02 SIGACOM, 04 SIGAEST, 05 SIGAFAT, 06 SIGAFIN, 10 SIGAPCP,
34 SIGACTB; `modulo` aceita o código ou o nome.

## Wrapper de teste

Para rotina com parâmetro e ambiente, ou cenário montado (registro posicionado,
respostas de pergunta). Nome: `prefixoWrapper` (devolvido por `tds_use_server`, único por
pessoa e máquina) + 3 letras da rotina, e o arquivo com o mesmo nome (`zTK3FRel.prw`).
No mesmo RPO outro desenvolvedor pode ter o dele, e compilar por cima troca o wrapper do
colega. Não passe de 8 caracteres depois do `U_`: o AdvPL só considera os 10 primeiros
do nome da função.

```advpl
#include "totvs.ch"

User Function zTK3FRel()
    RpcSetType(3)
    // empresa e filial informadas pelo usuario; o 5o parametro e o modulo
    // (cModulo/nModulo como no menu), ex.: "EST" para Estoque
    RpcSetEnv("01", "0101", , , "EST")
    Pergunte("ZRELOP", .F.)          // carrega as perguntas sem tela...
    MV_PAR01 := "000123"             // ...e define as respostas informadas pelo usuario
    SC2->(DbSetOrder(1))
    SC2->(DbSeek(xFilial("SC2") + "000123"))
    U_zRelOp()
    RpcClearEnv()
Return
```

Rotina que só precisa de parâmetro com tipo (numérico, lógico, data) e não usa
empresa dispensa o `RpcSetEnv`. Para ver o valor de retorno, guarde-o numa variável e
rode no modo headless com `rastro: ["xRet"]` na linha do `Return`: o valor vem em
`mensagens` (nível RASTRO).

```advpl
User Function zTK3FCal()
    Local xRet := U_zCalc(5, .T.)
Return xRet
```

Escreva o wrapper só com ASCII (sem acento, nem em comentário): assim ele é válido em
CP1252, que é o que `tds_compile` exige, mesmo gravado por uma ferramenta que salva em
UTF-8. Grave numa pasta temporária ou de rascunho da tarefa, fora do código do projeto,
compile com `temporario: true` e remova no fim (seção "Fontes temporários").
O `RpcSetEnv` abre o ambiente em modo automático: `Pergunte(.T.)` não mostra tela e a
data sai com ano de 2 dígitos; para reproduzir o que o usuário vê, use `modulo`.

Antes de definir `MV_PARxx` no wrapper, leia o fonte da rotina: se ela chama o próprio
`Pergunte(cPerg, .T.)`, ele recarrega as respostas salvas do usuário e descarta as do
wrapper, e o resultado sai com outros parâmetros. Nesse caso, rode no modo navegador com
`modulo` e responda o `Pergunte` na tela.

Arquivo de entrada (CSV, TXT): o caminho que a rotina recebe vale no AppServer, não na
máquina do desenvolvedor. Use uma pasta do servidor que já tenha o arquivo (confira com
`tds_server_files`) ou peça ao usuário para copiá-lo para lá.

## Headless (`tds_run` e modo `headless`)

- Sem empresa aberta: rotina que usa `xFilial`, SX ou `MV_` vai num wrapper.
- Quando a rotina para num diálogo, `tds_run` devolve `tempoEsgotado` e o
  `tds_debug_wait` devolve `executando`, os dois com `tela` e `botoes`. No headless não
  há como responder: encerre (`tds_run` já encerra; na depuração, `tds_debug_stop`) e
  ajuste o fonte, ou use o modo navegador. Caso comum: relatório que grava arquivo de
  nome fixo para em "O arquivo ... já existe. Deseja sobrescrevê-lo?" a partir da
  segunda execução; o fonte apaga o arquivo antes de gerar (`If File(cArq)` /
  `FErase(cArq)`) ou usa nome único.
- Arquivo enviado ao navegador (PDF do FWMSPrinter, `CpyS2TW`) vem em
  `arquivosBaixados` com o caminho local; `pastaDownloads` (caminho absoluto) escolhe
  onde gravar, por exemplo a pasta da tarefa.

## REST e jobs (modo `job`)

Para depurar só a lógica de um job, ou a função de negócio que um endpoint REST chama,
chame essa função num wrapper, no modo headless: não precisa do modo `job` nem de mexer
no AppServer. O método do endpoint (`@Get` em TLPP, `WSMETHOD`) depende do objeto da
requisição (`oRest`, `Self`) e não roda num wrapper; para depurá-lo, ou a thread exata
que o `StartJob` cria, use o modo `job`. Sem o usuário confirmar que o AppServer é de
desenvolvimento dedicado, fique no wrapper e diga o que ficou de fora.

Só threads criadas depois que o depurador conecta são depuráveis, e o modo `job`
captura toda thread nova do ambiente, inclusive jobs do próprio servidor (ex.:
`FWLSMANAGERPULSE`); quando uma dessas termina, a sessão pode encerrar. Por isso: AppServer
de desenvolvimento dedicado e depurador iniciado primeiro.

Receita da documentação do depurador do tds-vscode:

1. No appserver.ini do servidor de desenvolvimento: comentar o `[OnStart]` (ou deixar só
   os jobs necessários, com `RefreshRate=30`) e `[General] BUILDKILLUSERS=1` (compilar
   derruba todas as conexões da instância); reiniciar o AppServer.
2. Encerrar threads antigas com `tds_monitor_users` + `tds_monitor_kill_user`, com
   autorização do usuário.
3. Compile antes de iniciar o depurador (com `BUILDKILLUSERS=1`, compilar derruba a
   sessão): o fonte do serviço e uma função que dispare o job e espere, como temporário:
   `User Function zStartRest()` → `StartJob("HTTP_START", GetEnvServer(), .F.)` →
   `Sleep(300000)`. Quando essa função termina, a sessão pode encerrar: o `Sleep` dá o
   tempo de disparar a requisição.
4. `tds_debug_start` modo `job`, `programa: "u_zStartRest"` e breakpoint no fonte do
   serviço.
5. Dispare a requisição por fora (curl, Postman, a tela que chama a API); endereço,
   porta e autenticação do endpoint vêm do usuário. Depois, `tds_debug_wait`.

Verificado: breakpoint em função iniciada por `StartJob` para, com os parâmetros
recebidos visíveis. Não verificado: REST na porta multiprotocolo da 12.1.2510 (há
relato aberto na TOTVS de breakpoint que não para nesse cenário).

## Fontes temporários

`tds_compile` com `temporario: true` registra o fonte em
`~/.claude/tds-mcp/temporarios.json` (por servidor e ambiente); compilar de novo sem a
marca tira do registro. O registro é desta máquina: wrapper que um colega compilou fica
fora dele. `tds_rpo_temporarios` lista e diz se ainda está no RPO;
`tds_rpo_delete` remove só os registrados. Antes de remover, confirme com o usuário
fontes, servidor e ambiente. Fonte fora do registro sai apenas com
`foraDoRegistro: true` quando o usuário pede aquele fonte pelo nome; objeto oficial
TOTVS é sempre recusado.

## Problemas comuns

- **Formulário "Parâmetros Iniciais" no lugar do programa**: a URL foi aberta fora do
  contexto isolado. Feche a aba e abra de novo com `new_page` + `isolatedContext`.
- **Sessão de depuração encerrada sozinha**: depois de `debugIdleMinutes`
  (`~/.tds-mcp/config.json`) sem uso
  (padrão 10 min; no modo navegador, 30), a próxima chamada falha dizendo qual aba
  fechar. Feche-a (`list_pages` mostra `isolatedContext=tds-<id>` e a URL com
  `DEBUG=<id>`), confira com `tds_monitor_users` se sobrou thread da execução e, com
  autorização do usuário, encerre-a com `tds_monitor_kill_user`. Depois, inicie de novo.
- **"exige autenticação ... token de reconexão do TDS não funcionou"**: o token salvo
  pelo VS Code expirou. Peça usuário e senha e passe em `tds_use_server`, ou o usuário
  conecta no servidor pelo VS Code (renova o token).
- **AppServer reiniciado ou MCP reconectado**: a sessão do tds-mcp cai; `tds_use_server`
  de novo.
- **`executando` sem parar**: o programa espera interação (veja `tela` ou
  `take_snapshot`), a linha do breakpoint não é executada nesse caminho, ou o RPO tem
  outra versão do fonte (veja `avisos`).
- **Chamada que passa de ~100 s** pode ir para segundo plano no cliente: use
  `timeoutSeg`/`aguardarSeg` até 100 e repita o `tds_debug_wait`.
- **Webapp em porta própria**: o padrão é `http(s)://<endereço>:<porta>/webapp/` (porta
  multiprotocolo); outra URL vai em `webappUrls` no `~/.tds-mcp/config.json`, por nome
  do servidor no servers.json do TDS:
  `"webappUrls": { "NomeDoServidor": "http://host:porta/webapp/" }`.
- **`Array {size=NIL}` num frame chamador**: expanda com `caminho` para ver os itens.
