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

Autenticação, em ordem:

1. **Token de reconexão salvo pelo TDS** — funciona sem senha nenhuma. Se expirar, basta
   conectar no servidor pelo VS Code uma vez para renovar.
2. **Credenciais em `~/.tds-mcp/config.json`** — fallback opcional (veja
   [Configuração](#configuração)).

A conexão do MCP é independente da do VS Code: ambos podem estar conectados ao mesmo tempo.

## Tools

| Tool | Descrição | Efeito |
|---|---|---|
| `tds_list_servers` | Servidores do servers.json, ambientes e sessão ativa | read-only |
| `tds_use_server` | Conecta/autentica em servidor + ambiente | sessão |
| `tds_compile` | Compila fontes/pastas no RPO | **grava no RPO** |
| `tds_syntax_check` | Valida sintaxe sem commitar no RPO | nenhum |
| `tds_generate_ppo` | Fonte pré-processado (debug de `#define`/`#include`) | nenhum |
| `tds_rpo_objects` | Lista objetos do RPO (filtro + datas) | read-only |
| `tds_rpo_functions` | Lista funções do RPO (fonte + linha) | read-only |
| `tds_rpo_info` | Versão do RPO + histórico de patches aplicados | read-only |
| `tds_patch_generate` | Gera PTM com manifesto e rastreabilidade | read-only no RPO |
| `tds_patch_validate` | Valida patch contra o RPO sem aplicar | read-only |
| `tds_patch_info` | Lista o conteúdo de um `.ptm` | read-only |
| `tds_patch_apply` | **Aplica** patch no RPO (deploy) | **destrutivo** |
| `tds_server_log` | Últimas mensagens do advpls (diagnóstico) | read-only |

### Segurança operacional (leia antes de usar em cliente)

`tds_compile`, `tds_patch_generate` e `tds_patch_apply` **alteram o RPO de um servidor real**.
Recomendação forte: configure seu cliente MCP para **sempre pedir confirmação** nessas três.
No Claude Code, em `~/.claude/settings.json`:

```json
{
  "permissions": {
    "ask": [
      "mcp__tds__tds_compile",
      "mcp__tds__tds_patch_generate",
      "mcp__tds__tds_patch_apply"
    ]
  }
}
```

As demais tools são read-only e podem ser liberadas sem risco.

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

- `DDMMAA_HHMM_<slug>.ptm` — data/hora (padrão brasileiro) lideram o nome, ex.
  `190726_2037_tec10r06.ptm`. Colisão no mesmo minuto ganha segundos (`DDMMAA_HHMMSS`).
- `DDMMAA_HHMM_<slug>.manifest.json` — título e descrição recomendados, sha256, fontes com
  data do RPO, servidor/ambiente/build de origem, autor, commit git (opcional)
- `historico.jsonl` — append-only por ticket (gerações, validações, aplicações)
- `<patchesRoot>/historico-global.jsonl` — histórico consolidado

Título recomendado (data e hora primeiro): `19/07/2026 20:37 — Cliente ticket — FONTE.PRW`

## Configuração

Opcional. Copie `config.example.json` para `~/.tds-mcp/config.json`:

```json
{
  "patchesRoot": "C:\\TOTVS\\patches",
  "advplsPath": "",
  "credentials": {
    "NomeDoServidorNoTDS": { "user": "usuario", "password": "senha" }
  }
}
```

- `patchesRoot` — raiz da árvore de patches (padrão `C:\TOTVS\patches`)
- `advplsPath` — só se o advpls não estiver na extensão instalada. Também aceita a variável
  de ambiente `TDS_MCP_ADVPLS`
- `credentials` — **senhas em texto plano**. Prefira deixar vazio e usar o token do TDS.
  O arquivo fica fora do repositório; nunca o versione.

## Desenvolvimento e testes

```bash
npm run build                                  # compila TypeScript
npm test                                       # testes de lógica (não precisa de AppServer)

node test/smoke.mjs <servidor> [ambiente]      # read-only: conecta e inspeciona o RPO
node test/debug-protocol.mjs [host] [porta]    # JSON-RPC cru (diagnóstico de protocolo)
node test/debug-returncode.mjs <srv> [amb]     # read-only: returnCode em cada cenário
node test/e2e-readonly.mjs <servidor> [amb]    # read-only: E2E pelo servidor MCP

node test/e2e-mcp.mjs <servidor> [ambiente]    # E2E: COMPILA um fonte de teste no RPO
node test/cleanup.mjs <servidor> [ambiente]    # remove o fonte de teste do RPO
```

O E2E compila `test/zTstMcp1.prw` (User Function inofensiva) e gera um patch. **Use apenas
em ambiente de desenvolvimento descartável** e rode o cleanup depois.

## Limitações

- **Windows apenas** por enquanto: a resolução do binário procura
  `bin/windows/advpls.exe` na extensão tds-vscode. O `advpls` existe para Linux e macOS
  (`@totvs/tds-ls`), então o suporte é uma mudança pequena em `resolveAdvplsPath()` —
  PRs bem-vindos.
- **O protocolo `$totvsserver/*` não é um contrato público da TOTVS.** Ao atualizar a
  extensão TDS, o binário muda junto; se algo quebrar, `tds_server_log` ajuda a
  diagnosticar. A especificação viva é
  [`src/protocolMessages.ts`](https://github.com/totvs/tds-vscode/blob/master/src/protocolMessages.ts).
- O advpls **não aceita** o handshake LSP `initialize` com params mínimos (derruba o
  processo com `0xC0000409`). Os requests `$totvsserver/*` são enviados diretamente — é o
  que o `@totvs/tds-languageclient` oficial também faz.
- Fora do escopo da v1 (mas mapeados no protocolo): monitor de usuários conectados,
  `defragRPO`, `rpoCheckIntegrity`, `deletePrograms`, `wsdlGenerate`.

## Alternativas headless

Se você precisa de CI/CD em vez de um assistente:

- `advpls cli <script.ini>` — modo CLI oficial do TDS Language Server (script INI em CP1252)
- `appserver.exe -compile` — compilação/patch direto pelo AppServer, usado nos pipelines
  oficiais da TOTVS ([totvs/protheus-ci-universo](https://github.com/totvs/protheus-ci-universo))

## Créditos

Este projeto não é afiliado à TOTVS. O protocolo foi derivado do código-fonte público do
[tds-vscode](https://github.com/totvs/tds-vscode) (Apache-2.0) e da documentação do
[tds-ls](https://github.com/totvs/tds-ls). Protheus, AdvPL, TLPP e TOTVS são marcas de
seus respectivos proprietários.

## Licença

MIT — veja [LICENSE](LICENSE).
