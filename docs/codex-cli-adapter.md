# Adapter do Codex CLI no Singularity Hub

Fluxo: Singularity IDE → Agentes → Singularity Hub → Codex CLI. O adapter não usa a API da OpenAI, não lê o terminal e não toca
nos arquivos de credencial do CLI.

## O que foi verificado no CLI instalado (Codex CLI 0.166.0)

| Capacidade | Interface oficial usada | Observação |
|---|---|---|
| Execução não interativa | `codex exec --json` | eventos JSONL no stdout; o prompt entra por stdin (`-`) |
| Autenticação | `codex login status` | a resposta sai no **stderr** ("Logged in using ChatGPT"); só o texto "Logged in" e o método (ChatGPT ou chave) são lidos. Nenhuma chave de API é exigida |
| Catálogo de modelos | `codex debug models` | JSON com `slug`, `display_name`, `visibility` e `supported_reasoning_levels`; é um comando de depuração do CLI, mas é a única fonte oficial e dinâmica do catálogo |
| Esforço | `-c model_reasoning_effort="<nível>"` | os níveis vêm do catálogo, por modelo |
| Sessões e retomada | `thread.started.thread_id` e `codex exec resume <id>` | testado (continuação e reabertura) |
| Permissões | `-s read-only` ou `-s workspace-write` | em `resume` o modo vai por `-c sandbox_mode="…"` |
| Cancelamento | Job Object do helper nativo (`run-cli`) | termina o `codex.exe` e tudo o que ele criou dentro do job |

## Mecanismo

Um processo `codex.exe` por prompt (o `.exe` nativo, resolvido a partir do shim `codex.cmd`, sem `node` nem `cmd.exe`), dentro de
um Job Object criado por `singularity-job.exe run-cli`. O helper termina o job se o Hub morrer. O Hub guarda o `thread_id` no
histórico protegido (DPAPI) assim que o CLI o informa; o próximo prompt usa `codex exec resume <thread_id>`.

## Modelos e esforço (origem verificável)

O catálogo é lido de `codex debug models` a cada minuto e reduzido por lista de permissão (`slug`, nome, níveis); modelos com
`visibility` diferente de `list` (revisor interno, reservas) não são oferecidos, e as instruções internas que o catálogo traz
nunca saem do Hub. Nesta instalação: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6.1-terra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`,
`gpt-5.6-terra`, `gpt-5.6-luna`.

Os níveis são os que **cada modelo** lista: `low`, `medium`, `high`, `xhigh`, `max` e, nos modelos que o listam, `ultra`.
"Padrão do modelo" não envia nada e vale a configuração do próprio Codex. Teste real: cada modelo executou uma tarefa mínima no
menor nível; `gpt-5.6-luna` executou com todos os seus níveis (`low` a `max`); `ultra` foi verificado em `gpt-6.1-sol`.

## Streaming

O Codex emite eventos **por item**, não por token: `agent_message`, `command_execution`, `file_change` etc. chegam ao começar e ao
terminar. Uma tarefa de vários passos aparece passo a passo (as mensagens do agente vão entrando no resultado); uma resposta curta
chega inteira. O streaming por token só existe no protocolo experimental `codex app-server`, que não é usado. O painel mostra os
tipos de passo (`session.file_change.completed` …), nunca o comando nem o caminho: eles podem conter segredos.

## O modelo em uso

O fluxo do Codex **não informa o modelo** que rodou. A sessão mostra o modelo e o esforço **solicitados**, validados contra o
catálogo; não é uma confirmação do CLI. (O Claude Code, ao contrário, informa o modelo real no evento `init`.)

## Permissões

Sem bypass. O painel oferece "Somente leitura" (padrão) e "Escrever no workspace". O Hub só aceita `read-only` e
`workspace-write`; `danger-full-access`, `--dangerously-bypass-approvals-and-sandbox` e qualquer outro valor são recusados antes de
qualquer processo. No modo não interativo o Codex não pede aprovação: o que sair do sandbox falha.

## Falhas distinguidas

`turn.failed`/`error` são classificados em `authentication`, `usage-limit`, `model` ou `other` (formatos capturados do CLI real:
modelo inexistente numa conta ChatGPT, ausência de credenciais num `CODEX_HOME` vazio, nível de esforço inválido). A mensagem
original nunca é repassada: traz ids de requisição e URLs. O stderr do CLI (que inclui ruído de plugins MCP) só serve à
classificação.

## Diferença de recuperação entre os provedores

| | OpenCode | Claude Code | Codex CLI |
|---|---|---|---|
| Processo | servidor que sobrevive ao Hub | um por prompt | um por prompt |
| Queda do Hub no meio da execução | a execução continua e é reanexada | perdida; o job termina | perdida; o job termina |
| Sessão depois | recuperada ao vivo | arquivada, reabrível | arquivada, reabrível |
| Conversa cortada | preservada pelo servidor | **preservada** (o CLI lembrou o turno cortado) | **não preservada**: o CLI só grava o turno ao concluir (testado: depois da queda ele não lembrou a palavra combinada no turno cortado) |

Em todos os casos nada é reiniciado sozinho e a execução interrompida aparece como `failed`.

## Achado de implementação: cancelar cedo

Cancelando uma execução retomada ~4 s depois do início, o helper terminava o job (`stopped`), o processo saía, mas o evento
`close` do Node nunca disparava (algum descendente fora do job mantinha os pipes abertos) e a sessão ficava `running` para sempre.
Os dois adapters agora concluem na saída do processo (`exit` + 750 ms para o último texto) e fecham os pipes. Também foi
corrigida uma corrida em que a sessão aparecia `done` enquanto ainda estava ocupada: o resultado final só é publicado depois de a
sessão ficar livre.

## Testes

- `npm test` (Hub): catálogo (lista de permissão, níveis por modelo), permissões, classificação de falhas, descoberta, RPC.
- `scripts/e2e/codex-cli.cjs` (real, workspace sintético): detecção, login, catálogo, seleção recusada, tarefa que cria um arquivo,
  streaming por item, continuação, cancelamento, troca de modelo/esforço, encerramento, reinício do Hub, histórico, reabertura e
  retomada. `SINGULARITY_E2E_ALL_MODELS=1` roda um modelo por vez e todos os níveis do modelo principal.
- `scripts/e2e/codex-cli-crash.cjs`: o Hub é morto no meio de uma execução.
