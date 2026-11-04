# Singularity Browser

O Singularity Browser é o navegador integrado que o Code - OSS 1.144.0 já traz (`src/vs/workbench/contrib/browserView`). Ele não foi reescrito: o Singularity só mudou o nome e o padrão de segurança dos agentes.

## O que já existia no Code - OSS (e foi verificado na IDE)

- Abas de navegador como abas de editor, com barra de endereço, voltar, avançar e atualizar.
- Abrir páginas externas e `localhost`; título da aba segue o título da página.
- Divisão lado a lado com qualquer editor; abas restauradas ao reabrir a IDE.
- Developer Tools (F12), zoom, favoritos, histórico, permissões por site e armazenamento por escopo.
- Botão de globo na barra de título (`workbench.browser.showInTitleBar`).

## O que mudou no Singularity

| Mudança | Onde |
|---|---|
| Nome: categoria "Singularity Browser", comando **Singularity Browser: Open Browser**, título de boas-vindas e rótulos | quatro arquivos de `browserView/electron-browser` (só textos) |
| `workbench.browser.enableChatTools` desligado por padrão | `browserEditorChatFeatures.ts` (uma linha) |

Os ids dos comandos (`workbench.action.browser.*`) e os atalhos não mudaram. O tema segue o Event Minimal Dark e Light sem CSS próprio. A lista de arquivos do upstream tocados está em `UPSTREAM-TOUCHPOINTS.md`.

## Comandos e atalhos

| Ação | Como |
|---|---|
| Abrir | Paleta → **Singularity Browser: Open Browser**; botão de globo na barra de título; `Ctrl+Alt+;` |
| Endereço | `Ctrl+L` |
| Voltar / avançar | `Alt+←` / `Alt+→` |
| Atualizar | `F5` ou `Ctrl+R` (`Ctrl+Shift+R`: recarga completa) |
| Developer Tools | `F12` |
| Dividir | `Ctrl+]` (editor ao lado) |
| Limpar armazenamento | Paleta → **Singularity Browser: Clear Storage (Global / Workspace)** |

## Segurança

Verificado no código e no E2E (`scripts/e2e/browser-check.cjs`):

- Cada página roda numa `WebContentsView` com `nodeIntegration: false`, `contextIsolation: true` e `sandbox: true` (`src/vs/platform/browserView/electron-main/browserView.ts`). No E2E, uma página local sonda `require`, `process`, `module`, `vscode`, `acquireVsCodeApi`, `electron` e `ipcRenderer`: todos `undefined`. `fetch('file:///...')` é bloqueado. A única ponte visível à página é `window.__vscode_helpers` com `getElement` (devolve elementos do próprio DOM da página) e `getFrameToken` (um token opaco); não há IPC nem API da IDE ao alcance da página (`preload-browserView.ts`).
- As páginas usam sessões próprias do navegador (`persist:vscode-browser`, caminho por espaço de trabalho ou efêmera), separadas da sessão da IDE. O token do GitHub fica no `SecretStorage` da extensão de conta e não é enviado à página: o E2E confere que nenhuma requisição da página carrega token.
- **Agentes**: `workbench.browser.enableChatTools` vem desligado. O botão "Share with Agent" é por aba e começa desligado; compartilhar é uma escolha explícita do usuário. A automação por agentes (Singularity Agents, OpenCode etc.) ainda não está ligada ao navegador e fica para outra etapa.
- O Hub e o host de extensões não são expostos à página. Páginas externas não executam processos locais.

Limites conhecidos: o armazenamento padrão é `global` para espaços locais (cookies compartilhados entre projetos); para isolar por projeto, use `workbench.browser.dataStorage: workspace` ou o escopo efêmero.

## Como testar

```bash
node scripts/e2e/browser-check.cjs --out <pasta>                 # build de desenvolvimento
node scripts/e2e/browser-check.cjs --out <pasta> --exe <exe>     # aplicativo empacotado
```

O teste abre um servidor local em `127.0.0.1`, usa teclado e mouse reais, confere o que o navegador pediu ao servidor (e não só o DOM da IDE), tira capturas reais nos temas Dark e Light e termina com `BROWSER CHECK PASSED`.
