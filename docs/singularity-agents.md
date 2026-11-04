# Singularity Agentes

O Singularity é uma IDE independente, construída a partir do Code - OSS, com o seu próprio sistema de orquestração de agentes de codificação. A experiência é uma só:

**Singularity IDE → Agentes → Serviço de agentes → Provedor → Modelo → Esforço → Executar tarefa.**

Não é "VS Code → Chat → Copilot → extensão". O **Singularity** é o orquestrador; o **Singularity Hub** gerencia sessões, processos, eventos e execução; **OpenCode, Claude Code, Codex CLI e Gemini CLI** são *serviços de agentes* que o Singularity controla. O OpenCode tem um harness próprio por dentro, mas na interface é só um serviço de agentes: o usuário nunca vê "Harness: OpenCode".

## O que o usuário vê

- A barra lateral secundária tem **uma** aba, **Agentes**. Não há aba Chat, botão do Copilot, convite para entrar no Copilot, onboarding promocional nem a entrada "Open Chat" da tela vazia.
- O painel tem as sessões em cima e **um único compositor** embaixo: workspace, quatro seletores dependentes e uma caixa de tarefa.
- Abre-se pelo item **Agentes** da barra de status, pelo comando **Singularity: Abrir painel de agentes** ou pelo botão de layout da barra lateral secundária.

### Os quatro seletores

| Seletor | De onde vem | Regra |
|---|---|---|
| **Serviço de agentes** | catálogo de integrações do Hub | só o OpenCode tem adapter, então só ele é selecionável. Claude Code, Codex CLI e Gemini CLI aparecem como "(em breve)" e não podem ser escolhidos nem executados. |
| **Provedor** | `provider.list` do OpenCode, lido pelo Hub | só provedores que não estão desativados e que têm ao menos um modelo utilizável. Nada de lista fixa. |
| **Modelo** | `model.list` do OpenCode, lido pelo Hub | só modelos ativos e habilitados do provedor escolhido. O modelo padrão do serviço vem pré-selecionado. Um filtro de texto aparece quando a lista é longa. |
| **Esforço** | as *variantes* do modelo (`variants`) | cada modelo traz os seus níveis (por exemplo `low, medium, high, xhigh, max`). "Padrão do modelo" não envia nada. Modelo sem variantes: o seletor fica desabilitado e diz "Sem controle de esforço". Esforço não é temperatura nem limite de tokens. |

A cascata é: trocar o serviço recarrega os provedores; trocar o provedor troca os modelos; trocar o modelo troca os níveis de esforço, e um nível que o novo modelo não tem é limpo (nunca inventado). **O texto digitado nunca se perde**: o compositor é desenhado uma vez e só as listas de opções são atualizadas.

Os níveis conhecidos têm nome legível (Nenhum, Mínimo, Baixo, Médio, Alto, Extra alto, Máximo); qualquer outro é mostrado como o serviço o chamou.

### Sessões

Cada sessão está ligada a serviço, workspace, estado real e id da sessão no Hub, e mostra o **modelo e o esforço que o próprio serviço informa** (não só o que foi pedido). Não é preciso criar a sessão antes: ao enviar, se não há sessão em uso, o Singularity a cria no workspace escolhido, já com o modelo e o esforço. Com uma sessão em uso, trocar modelo ou esforço no compositor muda a sessão antes do prompt. A saída aparece em streaming no mesmo painel. Há **Cancelar tarefa** no compositor e **Encerrar** em cada sessão. Fechar a IDE não encerra o Hub nem as sessões; ao reabrir, elas voltam.

## Arquitetura

```
Painel (webview) ──mensagens──> extensão singularity-agents ──JSON-RPC──> Singularity Hub ──HTTP local──> OpenCode v2
   render.js / main.js              extension.js, hubClient.js              catalog.ts, opencode.ts
```

- **Hub** (`singularity-hub/src`): `catalog.get` devolve serviços, provedores, modelos e níveis de esforço; `session.create` aceita `model: { providerID, modelID, variant? }`; `session.setModel` troca modelo e esforço de uma sessão. A sessão informa o modelo em uso no campo `model`.
- **Catálogo** (`catalog.ts`): um servidor OpenCode curto roda num Job Object do Windows só para ler o catálogo do workspace, é encerrado em seguida, e a resposta fica em cache por um minuto.
- **Extensão** (`extensions/singularity-agents`): é o único ponto de contato com o Hub. O token do Hub nunca chega à webview. As preferências (serviço, provedor, modelo, esforço, workspace) ficam no `globalState`.
- **Painel** (`media/`): `render.js` é puro (testado em Node); `main.js` só liga eventos. CSP estrita, sem conteúdo remoto, só variáveis de tema (Dark, Light e alto contraste valem sem regras próprias).

### O Singularity valida; o OpenCode não

A API do OpenCode **aceita qualquer modelo e qualquer variante sem verificar** (testado: modelo inexistente e nível de esforço que o modelo não tem respondem 204). Por isso o Hub valida cada escolha contra o catálogo que acabou de ler (`validateSelection`): provedor, modelo e nível têm de existir. Nada inventado chega ao serviço.

### Segredos nunca passam

As respostas do OpenCode carregam segredos (cada provedor traz `settings.apiKey` e `headers`). O catálogo é construído por **lista de permissão** (`sanitizeCatalog`): cada campo que chega à IDE é montado a partir de poucos campos tipados (id, nome, ids de esforço). Um campo novo no OpenCode amanhã não vaza. Os testes alimentam o catálogo com chaves falsas e conferem que nada delas aparece; o E2E repete isso com o OpenCode real.

## Chat do Code - OSS

A mudança é na experiência padrão, não na infraestrutura. O padrão de `chat.disableAIFeatures` passou a ser `true` (uma linha, em `chat.shared.contribution.ts`). Isso é o mecanismo oficial do Code - OSS para esconder os recursos de IA embutidos: some a aba Chat, o botão do Copilot, o item de status do Copilot e do Codex, o convite de login e a entrada "Open Chat". Os serviços internos e a API pública de Chat e de modelos de linguagem continuam: o E2E `chat-compat-check.cjs` carrega uma extensão de terceiros que registra um participante de chat e uma ferramenta de modelo, e confere que a superfície da API e o comportamento são iguais aos do padrão do upstream. O usuário pode religar tudo em Configurações (`chat.disableAIFeatures`).

O **login GitHub do Singularity** (barra de título) é outra coisa e não muda: ele não é o login do Copilot.

## Limitações

- Só o OpenCode executa tarefas. Os outros serviços aparecem como "em breve" e não têm adapter.
- O esforço só existe quando o OpenCode informa variantes para o modelo. O catálogo não diz qual o esforço *padrão* de um modelo; por isso "Padrão do modelo" não envia nada.
- O modelo mostrado vem da sessão no OpenCode. Para uma sessão criada sem escolha, o OpenCode só informa o modelo depois da primeira tarefa; o painel diz "modelo padrão do serviço" até lá.
- Permissões de execução são as do OpenCode (a configuração dele); o painel ainda não as edita.
- O painel é uma contribuição embutida do produto (a extensão `singularity-agents` vai no pacote). Ele não é instalado pelo usuário nem aparece no marketplace; migrá-lo para uma view nativa em TypeScript só se justifica se for preciso integrar mais fundo ao workbench.

## Testes

```bash
node extensions/singularity-agents/test/run.cjs                  # 25 verificações: seleção em cascata, render, escape, sem segredos
cd singularity-hub && npm test                                    # 65 testes, incluindo catálogo (lista de permissão) e validação de RPC
node scripts/e2e/agents-check.cjs --out <pasta> [--exe <exe>]     # IDE real, OpenCode real, teclado e mouse reais
node scripts/e2e/chat-compat-check.cjs --out <pasta> [--exe <exe>] # compatibilidade do Chat para extensões de terceiros
```
