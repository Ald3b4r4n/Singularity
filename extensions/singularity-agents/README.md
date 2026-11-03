# Singularity Agents

Painel multiagente do Singularity IDE, na barra lateral secundária (à direita).

Nesta versão **não há Hub**: o painel mostra o estado vazio e não faz nenhuma conexão, não inicia nenhum agente e não inventa sessões.

- `extension.js`: registra a view (webview), os comandos e o item da barra de status.
- `hub.js`: a interface que o futuro Singularity Hub vai implementar e o único cliente atual (`DisconnectedHubClient`).
- `media/render.js`: desenha o painel a partir de um objeto de estado (`{ hub, sessions }`). É compartilhado com os testes.
- `test/run.cjs`: `node test/run.cjs`.

Comandos: `Singularity: Abrir painel de agentes` e `Singularity: Configurações do painel de agentes`. Configuração: `singularity.agents.showStatusBarItem`.

## Conexão com o Hub

`hubClient.js` adapta o `HubSupervisor` do pacote `singularity-hub` ao `HubClient` de `hub.js`. O painel só mostra "Hub conectado" depois de um handshake autenticado e compatível; o estado anterior da webview nunca é restaurado. O token vive só no extension host.

Comandos: `Singularity: Iniciar o Hub`, `Singularity: Encerrar o Hub`. Configurações: `singularity.agents.hub.autoStart` (inicia o Hub ao abrir o painel) e `singularity.agents.hub.nodePath` (escopo de máquina).
Fechar a janela da IDE não encerra o Hub.
