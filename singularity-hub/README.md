# Singularity Hub (v0)

Processo local e independente que o Singularity IDE usa para orquestrar agentes. Esta versão **não executa agentes**: só prova o ciclo de vida, a autenticação e o protocolo. `sessions.list` devolve sempre `[]`.

- TypeScript `strict`, compilado com `tsc`; Node.js 22 ou superior; biblioteca `ws`.
- JSON-RPC 2.0 sobre WebSocket, em `127.0.0.1`, caminho `/ws`.
- Um Hub por usuário. Sobrevive ao fechamento de todas as janelas da IDE.

## Compilar, testar, usar

```bash
cd singularity-hub
npm install
npm run build
npm test          # 41 testes (node:test)
node dist/cli.js start | status | stop
```

A extensão `extensions/singularity-agents` procura o Hub compilado em `../../singularity-hub/dist` e o inicia quando o painel é aberto (`singularity.agents.hub.autoStart`). Sem `npm run build`, o painel mostra o erro em vez de fingir uma conexão.

## Arquivos e execução

Pasta de estado: `%LOCALAPPDATA%\Singularity\Hub` (`SINGULARITY_HUB_HOME` troca a pasta, para perfis isolados e testes).

| Arquivo | Conteúdo |
|---|---|
| `hub.token` | token da instância, novo a cada início |
| `connection.json` | `instanceId`, `pid`, `port`, versões. **Sem token** |
| `hub.lock` | trava de instância única (`pid`, `nonce`) |
| `hub.log` | log; nunca recebe token, cabeçalhos nem conteúdo de requisições |

- A pasta recebe ACL só para o usuário atual (`icacls /inheritance:r`, concessão ao SID). Antes de ler qualquer arquivo, o cliente confere que a pasta e o arquivo pertencem só a esse usuário. Se alguém ampliar a ACL, a conexão é recusada.
- Escrita atômica: arquivo temporário na mesma pasta, `fsync`, `rename`. `connection.json` é escrito por último.
- O Hub é iniciado `detached`, sem janela, `stdio: ignore`, `unref()`. Não é serviço do Windows e não inicia com o sistema. Em desenvolvimento usa o `node.exe` do PATH (ou `SINGULARITY_NODE_PATH`); o Node empacotado (K1) fica para depois.
- Encerramento: `hub.shutdown` autenticado (ou `node dist/cli.js stop`). Ctrl+C e `SIGTERM` também encerram. Os três apagam os arquivos de estado que pertencem à instância.

### Instância única

`hub.lock` é criado com `wx` (exclusivo). Quem perde pergunta "existe um Hub que **prova** quem é?" (ver abaixo). Se sim, sai com código 0. Se não, a trava só é considerada velha quando o `pid` dela morreu ou ela tem mais de 30 s sem Hub; um `pid` vivo ou um arquivo sozinho nunca bastam.

## Autenticação

1. **Descoberta com prova de identidade.** O cliente lê `connection.json` e `hub.token`, envia um nonce novo para `GET /identity` e exige `HMAC-SHA256(token, "singularity-hub/1|instanceId|nonce")`. Só então envia o token. Um processo que ocupou uma porta antiga, ou um `connection.json` adulterado, não consegue a prova e **nunca recebe o token**.
2. **Upgrade autenticado.** `Authorization: Bearer <token>` é verificado no HTTP Upgrade, antes de existir WebSocket. Comparação em tempo constante.
3. Recusados no Upgrade: token ausente ou inválido (401), **qualquer query string** (400), `Host` diferente de `127.0.0.1:porta`/`localhost:porta` (403), qualquer `Origin` (403), caminho diferente de `/ws` (404).
4. Cinco falhas em 60 s bloqueiam novas tentativas por 30 s (429, mesmo com token válido).
5. O token fica no extension host. O estado enviado à webview contém só `{ hub: { status, detail }, sessions }`.

## Protocolo (versão 1)

| Método | Descrição |
|---|---|
| `hub.hello` | `{ client:{name,version?}, protocol:{min,max} }` → `{ protocol, hub:{name,version,instanceId,pid,startedAt}, capabilities, seq }`. Obrigatório antes de qualquer outro método (`-32002`). Versão incompatível: `-32001` com `data.supported`. |
| `sessions.list` | → `[]` nesta versão. |
| `session.subscribe` | `{ sessionId?, fromSeq? }` → `{ subscriptionId, seq, replayed }`. Sessão inexistente: `-32004`. `fromSeq` já descartado: `-32005`. Eventos chegam como notificações `session.event { subscriptionId, event:{seq,type,sessionId?,data?}, replay? }`. |
| `hub.shutdown` | Responde `{ ok:true }`, avisa os clientes com `hub.shuttingDown` e encerra. |

Erros padrão do JSON-RPC (`-32700`, `-32600`, `-32601`, `-32602`, `-32603`). Sem lotes. O log de eventos (`EventLog`) é sequenciado e limitado a 1000 itens, só em memória.

## Limites

Mensagem recebida: 64 KiB (excedeu: fecha com 1009). 50 mensagens/s com rajada de 100 (fecha com 1008). Máximo de 16 clientes (503). Cliente que não lê e acumula mais de 1 MiB de saída é derrubado. Ping a cada 15 s; sem pong, a conexão é encerrada.

## Para os adapters futuros

`HubServer.publish()` já sequencia e distribui eventos. Adapters entrarão como módulos que chamam `publish()` e alteram a lista de sessões, sem mexer no editor.

## Distribuição

No pacote do Windows o Hub fica em `resources/app/singularity-hub` com um Node.js próprio em `runtime/node.exe`. `findNode()` usa, nesta ordem: `SINGULARITY_NODE_PATH`, o runtime embutido e, só em checkouts de desenvolvimento, o PATH. Montagem e verificação: `scripts/package-hub.cjs`. Ver `docs/local-packaged-build.md`.

## Limitações conhecidas

- A remoção de uma trava velha tem uma janela mínima entre ler e apagar (o `nonce` é conferido antes de apagar). Duas tentativas simultâneas de remover a mesma trava velha são tratadas, mas não há exclusão mútua do sistema operacional.
- A prova de identidade protege contra impostores e arquivos adulterados, **não** contra outro processo do mesmo usuário, que já poderia ler o token.

## Adapter OpenCode no Windows

O Hub detecta `opencode.exe` no PATH, incluindo o layout do pacote npm
`@opencode/cli`. O servidor privado usa loopback, uma porta exclusiva e
uma senha Basic efêmera via `OPENCODE_PASSWORD`. A inicialização confirma
HTTP 401 sem credencial e confere a especificação em `/openapi.json`.
O contrato implementado é o v2 observado em OpenCode 2.2.5.

Cada sessão tem um servidor próprio associado a um Windows Job Object
antes de executar. Cancelar usa o endpoint de interrupção. Encerrar
pede interrupção e remoção da sessão, termina o Job e confirma zero
processos ativos. Fechar a IDE apenas desconecta seu cliente. Recuperar
sessões após a perda do próprio Hub fica para outro ciclo.

Compile com `npm --prefix singularity-hub run build` e
`singularity-hub\native\build.cmd` (Visual Studio Build Tools com C++ x64).
O empacotamento Windows já compila e inclui o helper. Para testar com a
configuração real do OpenCode, execute `node scripts/e2e/opencode-hub.cjs`.
O teste usa um workspace temporário e registra somente nomes de eventos,
estado final, diagnóstico sanitizado e resultado da limpeza.


### Painel Singularity Agents

Abra o painel, escolha **Criar sessão** e selecione a pasta do workspace.
O modelo vem da configuração do OpenCode para essa pasta. Os eventos
SSE da sessão atualizam o estado e o texto da resposta no painel. A
reabertura da IDE consulta a sessão existente no Hub.

O E2E do pacote Windows fica em `scripts/e2e/opencode-panel.cjs`.
A variável `SINGULARITY_E2E_OPENCODE_MODEL` pode indicar um modelo
disponível. Ela escreve a escolha somente no workspace sintético.
A variável `SINGULARITY_E2E_POWERSHELL` aceita o caminho do PowerShell
usado pelo teste de mouse e teclado.
