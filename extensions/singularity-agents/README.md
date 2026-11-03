# Singularity Agents

Painel multiagente do Singularity IDE, na barra lateral secundária (à direita).

Nesta versão **não há Hub**: o painel mostra o estado vazio e não faz nenhuma conexão, não inicia nenhum agente e não inventa sessões.

- `extension.js`: registra a view (webview), os comandos e o item da barra de status.
- `hub.js`: a interface que o futuro Singularity Hub vai implementar e o único cliente atual (`DisconnectedHubClient`).
- `media/render.js`: desenha o painel a partir de um objeto de estado (`{ hub, sessions }`). É compartilhado com os testes.
- `test/run.cjs`: `node test/run.cjs`.

Comandos: `Singularity: Abrir painel de agentes` e `Singularity: Configurações do painel de agentes`. Configuração: `singularity.agents.showStatusBarItem`.
