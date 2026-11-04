# Singularity Agentes

O Singularity Hub orquestra os provedores de codificação integrados à IDE. Na aba **Agentes**, a tarefa segue a ordem **Provedor → Modelo → Esforço**.

## Agentes e Sessões

**Agentes** é uma aba de editor. O primeiro uso abre a aba junto com a experiência de boas-vindas. Depois, o workbench restaura as abas abertas. Use **Singularity: Abrir Agentes** ou o item **Agentes** da barra de status para reabrir. A aba pode mudar de grupo e conviver com arquivos de código. O workbench mantém uma instância do editor de Agentes.

A lateral direita **Sessões** mostra workspace, modelo e estado. Selecione uma sessão para abrir a tarefa no editor. Encerrar exige confirmação. O Hub mantém as sessões quando a IDE é fechada.

O compositor oferece três seletores:

| Seletor | Origem |
|---|---|
| **Provedor** | Integrações do Hub. OpenCode está operacional. |
| **Modelo** | Catálogo real do OpenCode. A escolha mantém o ID do provedor de inferência e do modelo. |
| **Esforço** | Variantes informadas pelo modelo. Padrão do modelo usa a configuração do provedor. |

Os atalhos da tela inicial preparam um rascunho. Use **Ctrl+Enter** ou **Enviar** para iniciar uma sessão ou continuar a atual. O modelo e o esforço podem mudar entre tarefas da mesma sessão. O editor mostra o último prompt enviado, a resposta e os eventos durante a execução. **Cancelar tarefa** interrompe a execução atual.

## Arquitetura

```
Editor (webview) ──mensagens──> extensão singularity-agents ──JSON-RPC──> Singularity Hub ──HTTP local──> OpenCode v2
   render.js / main.js              extension.js, hubClient.js              catalog.ts, opencode.ts
```

- **Hub** (`singularity-hub/src`): `catalog.get` devolve serviços, provedores, modelos e níveis de esforço; `session.create` aceita `model: { providerID, modelID, variant? }`; `session.setModel` troca modelo e esforço de uma sessão. A sessão informa o modelo em uso no campo `model`.
- **Catálogo** (`catalog.ts`): um servidor OpenCode curto roda num Job Object do Windows só para ler o catálogo do workspace, é encerrado em seguida, e a resposta fica em cache por um minuto.
- **Extensão** (`extensions/singularity-agents`): é o único ponto de contato com o Hub. O token do Hub nunca chega à webview. As preferências (serviço, provedor, modelo, esforço, workspace) ficam no `globalState`.
- **Editor e lateral** (`media/`): `render.js` é puro (testado em Node); `main.js` só liga eventos. CSP estrita, sem conteúdo remoto, cores e tipografia do tema ativo.

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
- O editor e a lateral são registrados pela extensão embutida `singularity-agents`.

## Testes

```bash
node extensions/singularity-agents/test/run.cjs                  # catálogo, renderização e mensagens da webview
cd singularity-hub && npm test                                    # 65 testes, incluindo catálogo (lista de permissão) e validação de RPC
node scripts/e2e/agents-check.cjs --out <pasta> [--exe <exe>]     # IDE real, OpenCode real, teclado e mouse reais
node scripts/e2e/chat-compat-check.cjs --out <pasta> [--exe <exe>] # compatibilidade do Chat para extensões de terceiros
```

## Histórico local

O Hub guarda até 20 turnos por sessão em arquivos DPAPI no subdiretório `history` do diretório de dados do Hub. Por padrão, esse diretório é `%LOCALAPPDATA%/Singularity/Hub`. O usuário pode excluir o histórico de uma sessão encerrada pelo cartão na lateral. Históricos encerrados expiram após 30 dias e são removidos na inicialização do Hub. Os logs técnicos seguem uma política separada. O histórico abre no workspace de origem e sessões encerradas são somente leitura.
