# Singularity Remote 2.0: orquestração multiagente pelo Android

O Remote 2.0 permite **iniciar e acompanhar** comparações e equipes de agentes pelo celular. O Hub continua sendo o único orquestrador:
o gateway só valida o que o celular pede e chama as mesmas operações que a IDE usa. Os motores (comparação, equipe, worktrees isolados,
snapshots, revisão e correção, recuperação) não foram reimplementados.

## O que o celular pode fazer

| Operação | Rota | Observações |
|---|---|---|
| Nova comparação | `POST /api/comparisons` | 2 ou 3 agentes distintos; provedor, modelo e esforço por agente |
| Cancelar agente ou comparação | `POST /api/comparisons/:id/cancel` | `participantId` opcional |
| Selecionar solução para revisão | `POST /api/comparisons/:id/select` | só marca; não aplica |
| Nova equipe | `POST /api/teams` | implementador, revisor e testador independentes; 0 a 2 ciclos de correção |
| Cancelar / retomar equipe | `POST /api/teams/:id/cancel`, `/resume` | retomar só quando a equipe está pausada |
| Selecionar solução final | `POST /api/teams/:id/choose` | só marca; não aplica |
| Validação independente | `POST /api/teams/:id/validate` | **só por perfil cadastrado** (abaixo) |
| Consultar | `GET /api/comparisons/:id`, `/api/teams/:id`, listas, diffs | sem caminhos nem comandos |
| Perfis de teste | `GET /api/validation-profiles` | só id e nome |

Continuam **proibidos** pelo gateway: aplicar alterações, desfazer (rollback), limpar worktrees, shell remoto, gerenciamento de processos,
credenciais, encerrar o Hub e qualquer JSON-RPC genérico. Essas operações nem estão na lista fechada de métodos do Hub que o gateway aceita.

## Segurança de cada operação nova

- Dispositivo pareado, workspace autorizado (id opaco, nunca caminho), `confirm: true` e `X-Request-Id` obrigatórios.
- O catálogo real manda: o gateway consulta o catálogo do provedor e recusa (422) serviço indisponível, modelo que não existe ou esforço
  que o modelo não tem, antes de iniciar qualquer coisa.
- Limites: texto da comparação até 16000 caracteres, da equipe até 7000, no máximo 3 agentes, no máximo 2 ciclos de correção; os limites de
  fluxos simultâneos continuam sendo os do Hub (ele recusa iniciar outra comparação ou equipe enquanto uma está ativa).
- Respostas sem caminhos, comandos, tokens nem segredos.

### Perfis de teste (validação independente)

O celular **nunca** informa um executável nem uma linha de comando. Quem cadastra é o dono, na IDE Windows, em
**Singularity: Perfis de teste do acesso remoto**: nome, executável (caminho absoluto existente) e argumentos, por workspace, com uma
confirmação que mostra o comando exato. O celular só vê o nome e escolhe um perfil; o gateway entrega ao Hub exatamente o comando
cadastrado, já aprovado. Sem perfil, a equipe fica aguardando e a tela diz que a autorização é feita no Windows.

## Idempotência das novas operações

Usam o mesmo registro persistente dos envios (`remote/requests.json`), agora com a **ação** e o **alvo** na identidade: dispositivo +
ação + workspace/alvo + identificador, vinculados a um digest HMAC do conteúdo (o texto não é guardado). Valem as mesmas regras:
gravado antes de chamar o Hub, requisição simultânea com o mesmo id recebe "em processamento", mesmo id com outro conteúdo é recusado
(409), e um estado indeterminado nunca é repetido sozinho.

A reconciliação consulta evidências reais do Hub: uma comparação ou equipe criada depois do início do envio, com a mesma tarefa e os
mesmos modelos, resolve o envio sem criar outra (e devolve o mesmo identificador). Um cancelamento, seleção, retomada, escolha ou
validação é reconciliado pelo estado que o Hub mostra. Quando a evidência não decide, o estado fica "desconhecido" e a pessoa escolhe
verificar de novo, reenviar mesmo assim ou descartar. Não há promessa de "exatamente uma vez" fim a fim.

## No celular

- **Comparação → Nova comparação**: workspace, tarefa, 2 ou 3 agentes e, para cada um, provedor (OpenCode Go e Zen separados), modelo e
  esforço do catálogo real. A confirmação diz que os agentes trabalharão em cópias isoladas e que nada é aplicado ao projeto.
- **Equipe → Nova equipe**: papéis Implementador, Revisor e Testador, cada um com provedor, modelo e esforço, e o máximo de correções.
- **Acompanhamento** (atualiza sozinho a cada 3 s, sem duplicar cartões): tarefa, etapa, agente e modelo, estado, duração, histórico das
  etapas, problemas encontrados, correções, versões, revisão, plano de testes, validação independente e o diff da solução.
- **Controles** de dois toques: cancelar agente, cancelar comparação, cancelar equipe, retomar, selecionar para revisão, rodar a
  validação. Quando algo não é permitido, a tela diz o motivo.
- Toque na aba aberta volta para a lista. Uma atualização periódica nunca reconstrói a tela sob um campo em uso (não fecha o teclado).
- Layout sem rolagem horizontal da estrutura em 360 e 320 px, inclusive com o teclado aberto; só o diff rola para o lado.

## Testes

- `singularity-hub` (`npm test`): `orchestration.test.ts` (rotas, validação, catálogo, perfis, métodos proibidos, idempotência,
  reinício, conexão perdida e reconciliação), `ledger.test.ts`, `remote.test.ts`.
- `scripts/e2e/remote-multiagent-ui.cjs`: a interface em Chromium de celular contra o gateway real e um Hub roteirizado (sem modelo).
- `scripts/e2e/remote-multiagent-check.cjs`: comparação e equipe de verdade no pacote Windows, com OpenCode Go (Muse Spark 1.3
  Contributor e DeepSeek V4.1 Flash), duplo toque, id repetido, queda do gateway, queda do Hub, cancelamentos, recusas e a prova de que o
  acesso remoto do proprietário não foi tocado.

Limitações: o navegador emulado não prova teclado, instalação nem rede móvel reais de um Android; o aceite físico do Remote 1.0 já foi
dado e não foi repetido.
