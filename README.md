# tds-mcp

Servidor [MCP](https://modelcontextprotocol.io) que dá a um assistente de IA (Claude Code,
Claude Desktop, ou qualquer cliente MCP) a capacidade de **compilar fontes AdvPL/TLPP,
gerar e aplicar patches e inspecionar o RPO** de servidores TOTVS Protheus.

Por baixo usa o `advpls` — o mesmo TDS Language Server que a extensão
[tds-vscode](https://github.com/totvs/tds-vscode) utiliza — falando JSON-RPC via stdio.
Reaproveita a configuração que você já tem no TDS: servidores, ambientes, includes e tokens.

> **Não distribui binários da TOTVS.** O `advpls` é localizado na extensão tds-vscode já
> instalada na sua máquina. Você precisa ter o TDS instalado e um servidor configurado.

## Requisitos

- **Windows** (veja [Limitações](#limitações))
- Node.js 18+
- Extensão [totvs.tds-vscode](https://marketplace.visualstudio.com/items?itemName=totvs.tds-vscode)
  instalada, com pelo menos um servidor configurado e **já conectado uma vez** pelo VS Code
- AppServer Protheus acessível (build 7.00.x)

## Instalação

```bash
git clone https://github.com/Guipegoraro/tds-mcp.git
cd tds-mcp
npm install          # o script "prepare" já compila o TypeScript
```

Registre no Claude Code:

```bash
claude mcp add --scope user tds node "<caminho-do-clone>/dist/index.js"
```

Ou, em qualquer cliente MCP, via configuração JSON:

```json
{
  "mcpServers": {
    "tds": {
      "command": "node",
      "args": ["C:\\caminho\\para\\tds-mcp\\dist\\index.js"]
    }
  }
}
```

## Como a conexão funciona (zero-config)

O MCP lê `~/.totvsls/servers.json` — o arquivo global onde o TDS guarda seus servidores.
Você não precisa cadastrar nada duas vezes:

```
Cliente MCP (Claude)
  └── tds-mcp (Node, stdio)
        ├── lê ~/.totvsls/servers.json  (servidores, ambientes, includes, tokens)
        ├── spawn advpls.exe language-server
        └── JSON-RPC: $totvsserver/connect, compilation, patchGenerate, patchApply, ...
```

O arquivo é procurado na mesma ordem que o TDS usa: `TDS_MCP_SERVERS_JSON` (override) →
`.vscode/servers.json` do workspace (opção *Workspace server config*) → `~/.totvsls/servers.json`.
`tds_list_servers` mostra em `arquivoConfig` qual está em uso.

Autenticação, em ordem:

1. **Token de reconexão salvo pelo TDS** — funciona sem senha nenhuma. Se expirar, basta
   conectar no servidor pelo VS Code uma vez para renovar.
2. **Credenciais em `~/.tds-mcp/config.json`** — fallback opcional (veja
   [Configuração](#configuração)).

A conexão do MCP é independente da do VS Code: ambos podem estar conectados ao mesmo tempo.

## Tools

| Tool | Descrição | Efeito |
|---|---|---|
| `tds_list_servers` | Servidores do servers.json, ambientes, sessão ativa e binário advpls em uso | read-only |
| `tds_use_server` | Conecta/autentica em servidor + ambiente (token do TDS, ou `usuario`/`senha` informados — não gravados). Aceita id, nome ou parte única do nome; parte que casa com mais de um servidor é recusada | sessão |
| `tds_compile` | Compila fontes/pastas no RPO; `sucesso` só com resultado comprovado para cada fonte (resposta vazia ou status desconhecido vem em `inconclusivo`) | **grava no RPO** |
| `tds_syntax_check` | Verifica sintaxe com o linter do TDS (erros e avisos com linha); não usa o AppServer | nenhum |
| `tds_generate_ppo` | Fonte pré-processado (debug de `#define`/`#include`) | nenhum |
| `tds_rpo_objects` | Lista objetos do RPO (filtro + datas) | read-only |
| `tds_rpo_functions` | Lista funções do RPO (fonte + linha) | read-only |
| `tds_rpo_info` | Versão do RPO + histórico de patches aplicados | read-only |
| `tds_patch_generate` | Gera PTM com manifesto e rastreabilidade | read-only no RPO |
| `tds_patch_validate` | Valida patch contra o RPO sem aplicar | read-only |
| `tds_patch_info` | Lista o conteúdo de um `.ptm` | read-only |
| `tds_patch_apply` | **Aplica** patch no RPO (deploy) | **destrutivo** |
| `tds_server_log` | Últimas mensagens do advpls + caminho e versões do tds-ls/extensão | read-only |
| `tds_server_files` | Pastas e arquivos de uma pasta do AppServer | read-only |
| `tds_server_permissions` | Operações que o usuário pode executar no AppServer | read-only |
| `tds_monitor_users` | Sessões (threads) conectadas: usuário, ambiente, programa, memória | read-only |
| `tds_monitor_send_message` | Envia mensagem ao usuário de uma sessão | **afeta usuário** |
| `tds_monitor_app_kill_user` | Pede à aplicação da sessão que se encerre | **destrutivo** |
| `tds_monitor_kill_user` | Derruba a sessão imediatamente | **destrutivo** |
| `tds_run` | Executa uma função num SmartClient HTML invisível: concluído, erro (fonte/linha + pilha com variáveis) ou tempo esgotado (texto da tela) | **executa código** |
| `tds_debug_start` | Inicia depuração (modos headless, navegador para operar telas pelo chrome-devtools, job para StartJob/REST); `modulo` roda a rotina dentro do módulo pelo SIGABPM | **executa código** |
| `tds_debug_wait` / `tds_debug_step` | Espera parada / continua, próxima, entrar, sair; devolve local, pilha, Local/Private/Static, watches e o que mudou | depuração |
| `tds_debug_breakpoints` | Troca os breakpoints de um fonte (também com o programa rodando); condição, contagem, logpoint e rastro | depuração |
| `tds_debug_variables` | Variáveis por escopo (Local, Private, Public, Static, Table) e frame; expande array/JSON/tabela | read-only |
| `tds_debug_evaluate` | Avalia expressão no ponto de parada; `x := v` altera o programa | **executa código** |
| `tds_debug_watch` / `tds_debug_stop` | Expressões observadas a cada parada / encerra a sessão e libera a thread | depuração |

### Segurança operacional (leia antes de usar em cliente)

`tds_compile`, `tds_patch_generate` e `tds_patch_apply` **alteram o RPO de um servidor real**, e as
tools de ação do monitor (`tds_monitor_*`) **afetam usuários conectados**, e
`tds_run`, `tds_debug_start` e `tds_debug_evaluate` **executam código no servidor**.
Recomendação forte: configure seu cliente MCP para **sempre pedir confirmação** nelas.
No Claude Code, em `~/.claude/settings.json`:

```json
{
  "permissions": {
    "ask": [
      "mcp__tds__tds_compile",
      "mcp__tds__tds_patch_generate",
      "mcp__tds__tds_patch_apply",
      "mcp__tds__tds_monitor_send_message",
      "mcp__tds__tds_monitor_kill_user",
      "mcp__tds__tds_monitor_app_kill_user",
      "mcp__tds__tds_run",
      "mcp__tds__tds_debug_start",
      "mcp__tds__tds_debug_evaluate"
    ]
  }
}
```

As ações do monitor identificam a sessão pela thread e conferem na lista atual do monitor antes
de agir.
Uma thread parada num breakpoint fica presa no AppServer até o depurador sair: `tds_debug_stop`
libera, e a sessão também encerra sozinha por inatividade (`debugIdleMinutes`) e quando o tds-mcp fecha.
As demais tools são read-only e podem ser liberadas sem risco.

## Execução e depuração

Usa o debugAdapter da TOTVS (`@totvs/tds-da`, o mesmo do VS Code, localizado ao lado do advpls) e
o SmartClient HTML (webapp) do AppServer, num Chromium/Chrome/Edge headless controlado pelo
tds-mcp. O processo para o agente (pedir licença, alinhar fonte e RPO, escolher o modo,
inspecionar, encerrar) está na skill [`skills/debugar-advpl`](skills/debugar-advpl/SKILL.md) deste repositório.
Para o Claude Code enxergá-la, ligue a pasta nas skills do usuário (Windows, sem admin):

```bat
mklink /J "%USERPROFILE%\.claude\skills\debugar-advpl" "<repo>\skills\debugar-advpl"
```

No modo navegador o tds-mcp devolve `abrirCom` (`url` e `isolatedContext`) para o agente abrir
com `new_page` do chrome-devtools. O contexto isolado é necessário: o perfil normal do navegador
guarda o último programa e o uso do TOTVS WebAgent, e o webapp então descarta os parâmetros da URL
e roda o programa fora do depurador. `tds_debug_wait` informa `conectado` enquanto nenhum webapp
abriu a sessão.

Com `modulo` (código ou nome, ex.: `04` ou `SIGAEST`) a rotina roda pelo SIGABPM dentro do módulo,
com o ambiente que o usuário tem no menu (empresa, filial, data base, variáveis do módulo). A tela
pede login e confirma os diálogos de entrada do módulo; a rotina roda sem argumentos. Sem `modulo`,
a função é o programa inicial e roda sem empresa aberta.

Limitações do depurador TOTVS que as tools contornam: `evaluate` só no frame do topo (outros
frames via `tds_debug_variables`), sem `setVariable` (use `x := v`), pause não interrompe thread
em `Sleep` (inclua breakpoint), logpoint só interpola nome de variável numérica (use `rastro`),
erro de execução não para o depurador (a tela de erro é capturada e devolvida).


## Como ler o resultado de uma compilação

Uma compilação pode falhar em **dois níveis independentes** — e olhar só um deles faz erro
parecer sucesso:

| Nível | Onde aparece | Exemplo |
|---|---|---|
| **Build** | `returnCode != 0` + `falhaDeBuild` | `COMPILEERROR-300` (sem acesso exclusivo ao RPO), `40840` (token expirado) |
| **Fonte** | `resultados[].status` = `ERROR`/`FATAL` | erro de sintaxe (`returnCode -1`) |

Uma falha de **build** acontece antes/fora da compilação individual: `resultados` pode vir
**vazio ou só com `SUCCESS`**, e ainda assim **nada foi gravado no RPO** (o build é revertido).

> **Sempre use o booleano `sucesso`** (ou `sintaxeOk`) — ele já combina os dois níveis.
> Nunca conclua sucesso apenas porque não há itens `ERROR` em `resultados`.

Quando falha, a resposta também vem marcada como erro no protocolo MCP (`isError`) e inclui
`logDoServidor` com as mensagens do AppServer — é lá que aparece, por exemplo, a dica
`BuildKillUsers = 1` do `COMPILEERROR-300`.

**Sucesso sem gravação:** fontes já atualizados no RPO voltam com status `SKIPPED` (quando
`recompile=false`). Isso conta como sucesso, mas **nada foi escrito** — se todos forem
ignorados, a resposta traz o campo `aviso` dizendo isso. Confira `ignorados` antes de
afirmar que algo foi compilado.

Valores de `returnCode` medidos em AppServer 7.00.240223P: `0` sucesso, `-1` erro de fonte
(sintaxe / arquivo inexistente), `-300` sem acesso exclusivo ao RPO, `40840` token expirado.

## Encoding: fontes precisam estar em CP1252

O compilador Protheus só aceita **Windows-1252**. Um fonte em UTF-8 com acentos vai para o
RPO com caracteres corrompidos — às vezes **sem erro de compilação**, o que é pior que falhar.
Como agentes de IA gravam em UTF-8 por padrão, `tds_compile` e `tds_syntax_check`
**verificam antes de enviar e recusam** o que não estiver em CP1252:

- arquivo 100% ASCII → passa (é idêntico nos dois encodings)
- bytes altos que **não** formam UTF-8 válido → assume CP1252 → passa
- UTF-8 válido com acentos, ou BOM UTF-8 → **bloqueia**, dizendo qual arquivo e como converter
- CP1252 com trechos em UTF-8 (agente editou parte de um fonte CP1252) → **bloqueia** e aponta
  as linhas; converter o arquivo inteiro corromperia os acentos que já estavam certos. Linha que
  também tem acento CP1252 (ex.: `StrTran(cTxt, "Ã§", "ç")`) não conta. Quando a sequência é
  intencional (tabela de conversão de UTF-8), o usuário confirma as linhas e o agente repete com
  `aceitarMisto: true`; `tds_compile` e `tds_syntax_check` listam o que foi liberado em
  `encodingMistoAceito`
- UTF-16 (BOM `FF FE`/`FE FF` ou bytes nulos, saída padrão do `Out-File` do PowerShell 5) → **bloqueia**

O arquivo **nunca é alterado** pelo MCP — a conversão é decisão sua (`convert_encoding` do
MCP file-tools, ou *Save with Encoding → Windows 1252* no VS Code). Recursos binários
(`.png`, `.bmp`, `.res`) não passam pela checagem.

## Semântica das datas (importante — evita conclusão errada)

O campo de data que o RPO expõe por objeto (`dataFonte` em `tds_rpo_objects`, `date` em
`tds_patch_info`, `rpoDate` no manifesto, `dataPatch`/`dataRPO` em `tds_patch_validate`)
é o **mtime do arquivo-fonte registrado no momento da compilação** — **não** o instante
em que a compilação ocorreu.

- `dataFonte` == mtime do arquivo em disco (±2s) → o RPO **contém o conteúdo atual**.
- mtime do disco > `dataFonte` → fonte alterado depois da última compilação → recompilar.
- **Nunca** compare com data de commit git: commit posterior ao mtime é normal (editou num
  dia, commitou no outro) e **não** significa RPO desatualizado.

Exceção: `tds_rpo_info.dataGeracao` e as datas do histórico de patches (`geradoEm`,
`aplicadoEm`) são datas de evento reais.

## Rastreabilidade de patches

Cada `tds_patch_generate` produz em `<patchesRoot>/<cliente>/<ticket>/`:

- `DDMMAA_HHMM_<ticket>_<customizacao>.ptm` — data/hora (padrão brasileiro) lideram o nome,
  seguidas do ticket e do identificador da customização, ex.
  `011026_1706_00018662_balanca_refugo_req_op.ptm`. Colisão no mesmo minuto ganha segundos
  (`DDMMAA_HHMMSS`). `customizacao` é obrigatório: snake_case minúsculo, sem acento, até 40
  caracteres.
- `DDMMAA_HHMM_<ticket>_<customizacao>.manifest.json` — título do tcloud, título e descrição
  recomendados, sha256, fontes com data do RPO, servidor/ambiente/build de origem, autor, commit
  git (opcional)
- `historico.jsonl` — append-only por ticket (gerações, validações, aplicações)
- `<patchesRoot>/historico-global.jsonl` — histórico consolidado

Título recomendado (data e hora primeiro): `19/07/2026 20:37 — Cliente ticket — FONTE.PRW`

Título do tcloud (`tituloTcloud`, obrigatório, até 60 caracteres, validado na entrada e devolvido
no retorno e no manifesto): ticket + o que muda, ex. `18662 Balança refugo: regras, data e
requisição na OP`.

## Configuração

Opcional. Copie `config.example.json` para `~/.tds-mcp/config.json`:

```json
{
  "patchesRoot": "C:\\TOTVS\\patches",
  "advplsPath": "",
  "credentials": {
    "NomeDoServidorNoTDS": { "user": "usuario", "password": "senha" }
  },
  "webappUrls": { "NomeDoServidorNoTDS": "http://servidor:8080/webapp/" },
  "debugIdleMinutes": 10
}
```

- `patchesRoot` — raiz da árvore de patches (padrão `C:\TOTVS\patches`)
- `advplsPath` — só se o advpls não estiver na extensão instalada (sem ele, usa a extensão
  tds-vscode de maior versão; `tds_server_log` mostra qual binário está em uso). Também aceita a variável
  de ambiente `TDS_MCP_ADVPLS`
- `credentials` — **senhas em texto plano**. Prefira deixar vazio e usar o token do TDS.
  O arquivo fica fora do repositório; nunca o versione.
- `webappUrls` — URL do webapp por servidor, quando não for `http(s)://<endereço>:<porta>/webapp/`
  (porta multiprotocolo)
- `debugIdleMinutes` — minutos sem uso até a sessão de depuração encerrar (padrão 10; no modo
  navegador vale o triplo, porque o uso das telas pelo chrome-devtools não passa pelo tds-mcp)
- `debugAdapterPath`, `chromiumPath` — só se o debugAdapter ou o navegador não forem
  encontrados (também `TDS_MCP_DEBUG_ADAPTER` e `TDS_MCP_CHROMIUM`)

Um caminho informado (`advplsPath`, `debugAdapterPath`, `chromiumPath` ou as variáveis de
ambiente) que não existe é erro: o tds-mcp não troca por outro binário sem avisar. Campo com
tipo errado ou JSON inválido no config é ignorado com aviso em `avisosConfig` do `tds_server_log`.

## Desenvolvimento e testes

```bash
npm run build                                  # compila TypeScript
npm test                                       # testes de lógica e do linter local (não precisa de AppServer;
                                               # o do linter usa o advpls da extensão TDS e é pulado sem ela)

node test/smoke.mjs <servidor> [ambiente]      # read-only: conecta e inspeciona o RPO
node test/debug-protocol.mjs [host] [porta]    # JSON-RPC cru (diagnóstico de protocolo)
node test/debug-returncode.mjs <srv> [amb]     # read-only: returnCode em cada cenário
node test/e2e-readonly.mjs <servidor> [amb]    # read-only: E2E pelo servidor MCP
node test/e2e-admin-readonly.mjs <srv> [amb]   # read-only: binário, privilégios, pastas e monitor
node test/e2e-debug.mjs <servidor> [amb]       # COMPILA test/zTstDbg1.prw e executa/depura as funções dele
node test/e2e-monitor-acoes.mjs <srv> [amb]    # COMPILA test/zTstDbg1.prw; mensagem, app kill e kill na thread do teste

node test/e2e-mcp.mjs <servidor> [ambiente]    # E2E: COMPILA um fonte de teste no RPO
node test/cleanup.mjs <servidor> [ambiente]    # remove o fonte de teste do RPO
```

Os E2E aceitam `TDS_MCP_TEST_USER` e `TDS_MCP_TEST_PASSWORD` para autenticar com usuário e senha
quando o token salvo pelo TDS expirou.

O E2E compila `test/zTstMcp1.prw` (User Function inofensiva) e gera um patch. **Use apenas
em ambiente de desenvolvimento descartável** e rode o cleanup depois.

## Limitações

- **Verificação de sintaxe**: no tds-ls 2.2.x o modo `syntaxOnly` da compilação não passa pelo
  AppServer (é o linter local, que só reporta para arquivo aberto num workspace LSP). Por isso
  `tds_syntax_check` sobe um language server próprio, abre os fontes e colhe os diagnósticos do
  linter, com as pastas de include do servidor (sem elas o linter não acha nem o `PRTOPDEF.CH`
  implícito; pasta que não existe na máquina sai em `includesAusentes`). O linter é mais rigoroso
  que o compilador em alguns casos (ex.: `For` com variável não Local vira aviso W0004 na
  compilação; o tds-mcp rebaixa esse caso); na dúvida, compile num ambiente de desenvolvimento.

- **Windows apenas** por enquanto: a resolução do binário procura
  `bin/windows/advpls.exe` na extensão tds-vscode. O `advpls` existe para Linux e macOS
  (`@totvs/tds-ls`), então o suporte é uma mudança pequena em `resolveAdvplsPath()` —
  PRs bem-vindos.
- **Prazos do advpls**: compilação e patch (gerar, aplicar, validar, ler) têm 30 min para
  responder; os demais pedidos, 5 min. O prazo não cancela nada no servidor: depois de um
  timeout de compilação o build pode continuar e gravar no RPO, então confira com
  `tds_rpo_objects` antes de repetir.
- **O protocolo `$totvsserver/*` não é um contrato público da TOTVS.** Ao atualizar a
  extensão TDS, o binário muda junto; se algo quebrar, `tds_server_log` ajuda a
  diagnosticar. A especificação viva é
  [`src/protocolMessages.ts`](https://github.com/totvs/tds-vscode/blob/master/src/protocolMessages.ts).
- O advpls **não aceita** o handshake LSP `initialize` com params mínimos (derruba o
  processo com `0xC0000409`). Os requests `$totvsserver/*` são enviados diretamente — é o
  que o `@totvs/tds-languageclient` oficial também faz.
- Fora do escopo (mas mapeados no protocolo): `defragRPO`, `rpoCheckIntegrity`,
  `deletePrograms`, `wsdlGenerate`.

## Alternativas headless

Se você precisa de CI/CD em vez de um assistente:

- `advpls cli <script.ini>` — modo CLI oficial do TDS Language Server (script INI em CP1252)
- `appserver.exe -compile` — compilação/patch direto pelo AppServer, usado nos pipelines
  oficiais da TOTVS ([totvs/protheus-ci-universo](https://github.com/totvs/protheus-ci-universo))

## Créditos

Este projeto não é afiliado à TOTVS. O protocolo foi derivado do código-fonte público do
[tds-vscode](https://github.com/totvs/tds-vscode) (Apache-2.0) e da documentação do
[tds-ls](https://github.com/totvs/tds-ls). As regras de encoding CP1252, a lista de
extensões compiláveis e parte do troubleshooting seguem a skill oficial
`advpl-tlpp-compile` (Engenharia Protheus, MIT). Protheus, AdvPL, TLPP e TOTVS são marcas de
seus respectivos proprietários.

## Licença

MIT — veja [LICENSE](LICENSE).
