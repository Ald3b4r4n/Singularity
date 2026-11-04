# Singularity Agentes

**Agentes** abre em uma aba de editor. **Sessões**, na lateral direita, permite abrir e encerrar sessões. O compositor oferece Provedor, Modelo e Esforço com opções vindas do catálogo do OpenCode pelo Singularity Hub.

Veja a [arquitetura e os testes](../../docs/singularity-agents.md).

## Arquivos

- `extension.js`: registra o editor e a lateral de sessões, os comandos e o item da barra de status; recebe as mensagens do painel e fala com o Hub (catálogo, criar sessão com modelo e esforço, trocar modelo, enviar, cancelar, encerrar). Guarda as preferências no `globalState`.
- `selection.js`: ajudantes puros da escolha de modelo que viaja ao Hub (testados sem VS Code).
- `hubClient.js`: adapta o `HubSupervisor` do pacote `singularity-hub`. O token do Hub vive só no extension host e nunca chega à webview.
- `hub.js`: a interface de Hub e o cliente desconectado.
- `media/render.js`: lógica pura do painel (seleção de modelo, estado inicial e sessões), compartilhada com os testes.
- `media/main.js`: liga o DOM; o compositor é desenhado uma vez, então a seleção de modelo preserva o rascunho.
- `media/sessions.js`: navegação da lateral de sessões.
- `media/agents.css`: layout responsivo e estilos que acompanham o tema.

Comandos: `Singularity: Abrir Agentes`, `Singularity: Configurações do painel de agentes`, `Singularity: Iniciar o Hub`, `Singularity: Encerrar o Hub`. Configurações: `singularity.agents.showStatusBarItem`, `singularity.agents.hub.autoStart` (inicia o Hub ao abrir o painel) e `singularity.agents.hub.nodePath` (escopo de máquina). Fechar a janela da IDE não encerra o Hub.

## Testes

`node test/run.cjs`. O E2E real é `scripts/e2e/agents-check.cjs`.
