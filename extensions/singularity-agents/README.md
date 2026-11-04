# Singularity Agentes

Central de agentes do Singularity IDE, na barra lateral secundária (à direita). É a **única** superfície de agentes do produto: o Chat tradicional e os controles do Copilot ficam desligados por padrão (`chat.disableAIFeatures`). A visão geral, a arquitetura e as limitações estão em [`docs/singularity-agents.md`](../../docs/singularity-agents.md).

O painel tem as sessões em cima e **um compositor único** embaixo, com quatro seletores dependentes: **Serviço de agentes → Provedor → Modelo → Esforço**. As opções vêm do Singularity Hub, que as lê do próprio serviço (hoje só o OpenCode tem adapter; Claude Code, Codex CLI e Gemini CLI aparecem como "em breve"). O Hub valida cada escolha contra o catálogo real antes de enviá-la ao serviço.

## Arquivos

- `extension.js`: registra a view (webview), os comandos e o item da barra de status; recebe as mensagens do painel e fala com o Hub (catálogo, criar sessão com modelo e esforço, trocar modelo, enviar, cancelar, encerrar). Guarda as preferências no `globalState`.
- `selection.js`: ajudantes puros da escolha de modelo que viaja ao Hub (testados sem VS Code).
- `hubClient.js`: adapta o `HubSupervisor` do pacote `singularity-hub`. O token do Hub vive só no extension host e nunca chega à webview.
- `hub.js`: a interface de Hub e o cliente desconectado.
- `media/render.js`: lógica pura do painel (seleção em cascata, cartões de sessão), compartilhada com os testes.
- `media/main.js`: liga o DOM; o compositor é desenhado uma vez, então o texto digitado nunca se perde.
- `media/agents.css`: só variáveis de tema.

Comandos: `Singularity: Abrir painel de agentes`, `Singularity: Configurações do painel de agentes`, `Singularity: Iniciar o Hub`, `Singularity: Encerrar o Hub`. Configurações: `singularity.agents.showStatusBarItem`, `singularity.agents.hub.autoStart` (inicia o Hub ao abrir o painel) e `singularity.agents.hub.nodePath` (escopo de máquina). Fechar a janela da IDE não encerra o Hub.

## Testes

`node test/run.cjs` (25 verificações). O E2E real é `scripts/e2e/agents-check.cjs`.
