# Adapter do Claude Code no Singularity Hub

Fluxo: Singularity IDE → Agentes → Singularity Hub → Claude Code CLI. O Hub continua sendo o intermediário; o adapter não
usa a API da Anthropic, não lê o terminal e não toca nos arquivos de credencial do CLI.

## Mecanismo escolhido

`claude --print --output-format stream-json --verbose --include-partial-messages`, a interface estruturada e suportada do CLI
(verificada em `claude --help`, versão 2.1.292). Não foi usado o Agent SDK: ele exigiria um segundo caminho de autenticação e
não traz nada que o `stream-json` não entregue aqui (eventos, modelo real, sessões, cancelamento).

- **Autenticação:** a do próprio CLI. O Hub só pergunta `claude auth status --json` e guarda o booleano `loggedIn`; e-mail,
  organização e plano nunca são lidos adiante, registrados ou enviados à webview. Sem login, o serviço aparece como
  "indisponível" com a instrução `claude auth login`.
- **Executável:** o `claude.exe` nativo (resolvido a partir do `claude.cmd` do npm, sem `cmd.exe`), ou o caminho absoluto em
  `SINGULARITY_CLAUDE_CODE`.
- **Um processo por prompt**, dentro de um Job Object criado pelo helper nativo (`singularity-job.exe run-cli ...`). O prompt
  entra pelo stdin, nunca pela linha de comando. O helper entrega ao Hub o stdout (eventos) e o stderr (só usado para
  classificar falhas), e **termina o Job Object se o processo do Hub acabar**.
- **Sessões:** o primeiro prompt usa `--session-id <uuid>`, os seguintes `--resume <uuid>`. O uuid é o id da sessão do Hub.
  `--resume` só é usado depois que o CLI confirmou a conversa (evento `system/init`); uma sessão que nunca iniciou não é
  "retomada" e nenhuma execução nova começa em silêncio.

## Modelos e esforço (origem verificável)

Não há catálogo dinâmico no CLI. O catálogo vem de `claude --help` e é lido a cada minuto, nunca presumido:

- aliases de modelo: `fable`, `opus`, `sonnet` (texto da opção `--model`);
- níveis de esforço: `low`, `medium`, `high`, `xhigh`, `max` (texto da opção `--effort`). O CLI documenta a lista para a
  sessão, não por modelo; o Hub oferece a mesma lista para todos os aliases. No teste real, `opus` e `sonnet` executaram com
  os cinco níveis. `fable` resolve para `claude-fable-5-1`, mas nesta conta o CLI recusou a execução ("requer créditos de
  uso"), que o adapter classifica como `usage-limit`: o alias está documentado, porém a execução com ele não foi verificada.

O modelo realmente usado vem do evento `system/init` (`claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`), não do alias
pedido, e é o que a sessão exibe. Seleções fora do catálogo (modelo, esforço, provedor) são recusadas pelo Hub antes de
qualquer processo.

## Permissões

Sem bypass implícito. O Hub passa `--permission-prompts none` (o que exigiria aprovação é negado) e só aceita criar sessão com
`default`, `plan`, `acceptEdits` ou `dontAsk` (`permissionMode` em `session.create`). `bypassPermissions`, `auto` e `manual`
são recusados: os dois primeiros dispensam a aprovação do usuário, e `manual` exige um host interativo que uma execução
headless não tem. As configurações do usuário no CLI (settings, hooks, MCP) continuam valendo. Ações negadas aparecem no
resumo da sessão ("Uma ação foi negada pela política de permissão (Write)").

## Falhas distinguidas

A classificação usa o rótulo que o próprio CLI põe no turno do assistente (`authentication_failed`, `model_not_found`,
`rate_limit`), o `api_error_status` do resultado, o evento `rate_limit_event` com `status: rejected` e o stderr, nessa ordem.
A sessão recebe `failure` = `authentication`, `usage-limit`, `model` ou `other` e um texto próprio; o texto do CLI não é
repassado. Formatos capturados do CLI real: modelo inexistente, ausência de credenciais (um `CLAUDE_CONFIG_DIR` vazio, sem ler
nenhum token) e um modelo que exige créditos de uso.

## Diferença em relação ao OpenCode na queda do Hub

**Não é equivalente, e não foi simulado.** O OpenCode é um servidor que sobrevive ao Hub e é reanexado depois de uma queda. O
Claude Code roda um processo por prompt, com a saída ligada ao Hub; uma execução não sobrevive a ele. O contrato é:

1. o helper termina o Job Object quando o Hub morre (medido: 1,4 s depois de `SIGKILL`), então nenhum agente fica rodando sem
   supervisão;
2. a execução interrompida aparece como `failed`, nunca como `done` ou `running`, e nada é reiniciado sozinho;
3. a sessão permanece no histórico protegido (DPAPI). `session.reopen` a traz de volta como sessão ativa **sem iniciar
   processo**; o próximo prompt retoma a mesma conversa do CLI com `--resume` (testado: o CLI lembrou a palavra combinada
   no turno que foi cortado).

`resumable` é gravado no arquivo protegido assim que o CLI reporta a sessão, não no fim da execução, justamente para
sobreviver a essa queda.

## Ciclo de vida

Criar → `session.prompt` (processo novo) → eventos `claude.event` (`session.started`, `session.text.delta`,
`session.tool.requested`, `session.completed`/`failed`/`interrupted`) e `session.changed` com o resultado parcial →
`session.interrupt` (termina o Job Object da execução) → `session.stop` (arquiva) → `session.reopen`. O resultado final só é
publicado depois que o processo saiu, para que a sessão nunca esteja `done` com o job ainda vivo. Limites: 8 sessões vivas,
prompt de até 16.000 caracteres, resultado exibido de até 12.000, tempo limite de 30 minutos por execução.

## Testes

- `npm test` (Hub): catálogo, permissões, classificação de falhas, descoberta e o modo `run-cli` do helper (stdio, aspas, recusa
  sem capacidade, término do job com a morte do pai).
- `scripts/e2e/claude-code.cjs` (real, workspace sintético): detecção, login, catálogo, seleção recusada, tarefa controlada que
  cria um arquivo, streaming, modelo realmente usado, processo encerrado, continuação na mesma sessão, cancelamento, troca de
  modelo/esforço, encerramento, reinício do Hub, histórico, reabertura e retomada. `SINGULARITY_E2E_ALL_MODELS=1` roda
  uma tarefa mínima por alias e por nível de esforço.
- `scripts/e2e/claude-code-crash.cjs` (real): o Hub é morto no meio de uma execução com streaming.
