# Edições em arquivos do upstream

Cada arquivo do Code - OSS editado pelo Singularity entra aqui, com o motivo. Quanto menor esta lista, mais barato é sincronizar com o upstream. A lista exata também pode ser obtida do Git:

```bash
git diff --name-only 1.144.0...HEAD
```

Base atual: tag `1.144.0`, commit `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`.

| Arquivo | Motivo | Tag em que foi feita |
|---|---|---|
| `product.json` | Identidade Singularity IDE: nome, pastas de dados (inclusive a compartilhada), protocolo de URL, identificadores do instalador do Windows (GUIDs novos e fixos), URL de relato de problemas. Campos de macOS e Linux acompanham o novo namespace. Também `openToWelcomeMainPage: true`, para a primeira abertura mostrar a página inicial. | 1.144.0 |
| `src/vs/workbench/contrib/mcp/common/mcpConfiguration.ts` | Uma linha: a descoberta automática de servidores MCP da configuração do GitHub Copilot CLI deixa de vir ativada por padrão. Isola a nova IDE de configurações de outras ferramentas. Esta tag não oferece `configurationDefaults` no `product.json` para isso. | 1.144.0 |
| `README.md` | Substituído pelo README do Singularity. | 1.144.0 |
| `src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts` | Uma linha: `workbench.welcomePage.experimentalOnboarding` passa a ter padrão `false`. É esse setting que abre, na primeira execução, o modal que convida a entrar no GitHub Copilot (`startupPage.ts` → `welcomeOnboarding`). O setting tem escopo de aplicação, e o ponto de extensão `configurationDefaults` não aceita esse escopo, então não há como mudar o padrão por extensão. O usuário ainda pode ligá-lo. | 1.144.0 |
| `src/vs/workbench/browser/media/code-icon.svg` | Troca o logotipo do VS Code (titlebar, boas-vindas, banners, tooltip de atualização) pelo símbolo Event Minimal. Um arquivo de imagem. | 1.144.0 |
| `src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.ts` | Duas linhas: o subtítulo da página de boas-vindas deixa de ser o slogan do VS Code, e o rodapé "coleta dados de uso" só aparece se o produto tiver telemetria (este build não tem). | 1.144.0 |
| `src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts` | Uma linha: o walkthrough "Get started with VS Code" (`Setup`) fica oculto, pois seus passos pedem login no Copilot. O walkthrough do Singularity vem da extensão `singularity-welcome`. | 1.144.0 |
| `src/vs/workbench/browser/workbench.contribution.ts` | Uma linha: `workbench.secondarySideBar.defaultVisibility` passa a `hidden`, para o painel de Chat não abrir sozinho. O chat continua disponível. Por extensão o padrão chegaria depois do layout. | 1.144.0 |
| `src/vs/code/electron-browser/workbench/workbench.ts` | Duas linhas: importa e chama `showSingularityIntro()` logo depois do splash das partes. Todo o resto da abertura está em arquivos novos (`singularityIntro.ts`, `src/vs/base/common/singularityIntroLogic.ts`, `src/vs/workbench/contrib/singularityIntro/`). A chamada nunca lança: qualquer falha remove o overlay. | 1.144.0 |
| `src/vs/workbench/workbench.desktop.main.ts` | Uma linha: importa a contribuição que registra a configuração `singularity.startup.intro` e avisa o overlay quando o workbench está restaurado. | 1.144.0 |
| `src/vs/platform/theme/electron-main/themeMainServiceImpl.ts` | Uma linha: o fundo nativo padrão da janela escura passa de `#1F1F1F` para `#07080C` (fundo do Event Minimal Dark), para o primeiro quadro combinar com a abertura. Só vale quando ainda não há cor de tema guardada. | 1.144.0 |
| `eslint.config.js` | Um bloco novo: os três arquivos próprios da abertura usam o cabeçalho "Copyright (c) Singularity IDE contributors. Licensed under the MIT License." em vez do cabeçalho da Microsoft, que o lint exigia de todos os arquivos de `src/`. Os demais arquivos continuam com a regra original. | 1.144.0 |
| `src/vs/workbench/browser/parts/editor/media/letterpress-{dark,light,hcDark,hcLight}.svg` | Quatro imagens: a marca d'água do editor vazio (as três barras do VS Code) passa a ser a marca Event Minimal (âmbar no escuro, `#A64E05` no claro, branco e preto no alto contraste). Só o conteúdo dos arquivos mudou; nenhum código nem CSS. Os atalhos da tela vazia (Open Chat, Show All Commands...) ficam como estão. | 1.144.0 |
| `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts` | **Duas linhas.** (2) `chat.disableAIFeatures` passa a ter padrão `true`: é o mecanismo oficial do Code - OSS para esconder os recursos de IA embutidos. Some a aba Chat da barra lateral secundária, o botão e o item de status do Copilot (e o do Codex), o convite de login do Copilot, "Open Chat" da tela vazia e "Toggle Chat"/"Agent Status" da barra de título. Os serviços internos e a API pública de Chat e de modelos de linguagem continuam (o E2E `scripts/e2e/chat-compat-check.cjs` confere com uma extensão de terceiros); o usuário pode religar tudo em Configurações. A única superfície de agentes passa a ser o aba de editor Agentes da extensão `singularity-agents` (`docs/singularity-agents.md`). (1) `chat.titleBar.signIn.enabled` passa a ter padrão `false`. O botão "Sign In" da barra de título era o do Copilot (`workbench.action.chat.signInIndicator`, em `chatSetupContributions.ts`) e abria o setup do Copilot. No lugar dele, a barra de título mostra a entrada de conta GitHub do Singularity (arquivos novos em `src/vs/workbench/contrib/singularityAccount/`). O usuário ainda pode ligar o botão do Copilot. | 1.144.0 |
| `src/vs/workbench/workbench.desktop.main.ts` | Mais uma linha: importa `singularityAccountTitleBar`, a entrada de conta GitHub na barra de título (ação no menu `TitleBarAdjacentCenter` e item de visualização próprio). Ela só lê estado público publicado pela extensão `singularity-account` por context keys. | 1.144.0 |
| `eslint.config.js` | O bloco de cabeçalho do Singularity passa a cobrir também `src/vs/workbench/contrib/singularityAccount/**`. | 1.144.0 |
| `build/gulpfile.vscode.ts` | Quatro mudanças no empacotamento do Windows: (1) chave `singularityBuild.shipBuiltInCopilot` (padrão desligada) que, desligada, não empacota a extensão Copilot embutida, não roda o passo do shim de ripgrep do Copilot e não inclui `bin/copilot-shim`: o runtime `@github/copilot` só pode ser redistribuído sem modificações, e este build o poda; (2) o passo `patchWin32DependenciesTask` (que reescrevia metadados de versão e removia assinaturas dos binários de terceiros) deixa de ser agendado: os binários saem como foram construídos; (3) remoção das funções e imports que só esse passo usava (`glob`, `rcedit`, `promisify`); (4) comentários. Detalhes em `docs/hub-robustness-pending.md` e `docs/local-packaged-build.md`. | 1.144.0 |
| `src/vs/workbench/contrib/browserView/electron-browser/{browserEditor.ts,browserView.contribution.ts}`, `.../features/{browserTabManagementFeatures.ts,browserWelcomeFeature.ts}` | Singularity Browser: só textos visíveis. A categoria dos comandos passa de "Browser" para "Singularity Browser", "Open Integrated Browser" vira "Open Browser", e rótulos, dica de link local e título da tela de boas-vindas dizem "Singularity Browser". Ids de comando, atalhos e lógica ficam como estão. Detalhes em `docs/singularity-browser.md`. | 1.144.0 |
| `src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts` | Uma linha: `workbench.browser.enableChatTools` passa a ter padrão `false`, para agentes não controlarem páginas do navegador sem o usuário ligar. O `configurationDefaults` do `product.json` só vale para a versão web, então o padrão mudou na declaração. | 1.144.0 |
| `resources/win32/*` (`code.ico`, `sessions.ico`, `code_150x150.png`, `code_70x70.png`, 14 `inno-*.bmp`, `VisualElementsManifest.xml`) | Marca Event Minimal: ícone do executável e da barra de tarefas, mosaicos e imagens do instalador. O manifesto passa a usar o fundo `#07080C` e o nome curto `Singularity`. Arquivos binários que o upstream muda raramente. | 1.144.0 |
| `resources/linux/code.png`, `resources/server/code-192.png`, `code-512.png`, `favicon.ico` | Mesmo ícone, para Linux e servidor web (sem rpm `.xpm` nem macOS por enquanto). | 1.144.0 |

## Ainda não tocado, mas previsto

*   Ícones dos tipos de arquivo em `resources/win32/*.ico` (cerca de 25), `resources/linux/rpm/code.xpm` e ícones do macOS.
*   Inclusão da extensão `extensions/singularity-theme` no build empacotado: em desenvolvimento ela é carregada sem alterar nenhum arquivo do upstream; o pacote final ainda precisa ser conferido.
*   A extensão `extensions/singularity-agents` (painel de agentes na barra lateral secundária) não editou nenhum arquivo do upstream: usa o ponto de extensão público `viewsContainers.secondarySidebar`.
*   O módulo `singularity-hub/` (processo do Hub, TypeScript) e a ligação em `extensions/singularity-agents` não editaram nenhum arquivo do upstream. Em desenvolvimento a extensão procura `../../singularity-hub/dist`; empacotar o Hub no build da IDE ainda não foi feito.

### Windows installer

- `build/gulpfile.vscode.win32.ts` and `build/win32/code.iss` use the Singularity product identity and separate existing AppIds for user and system installs. Setup and uninstall require the user to close the IDE, Hub and tunnels. Setup does not use Restart Manager to close or restart applications.
- `scripts/package-win32.cjs --installer` builds and validates the Windows payload, stamps the main IDE executable and compiles the user and system installers. `product.json` supplies the Singularity release version. The upstream Code - OSS version remains available for extension compatibility.
- The native About dialog displays the Singularity release version. Existing file associations, shell integration, and the upstream license and third-party notices are preserved.

### Release e verificação de atualizações

- `extensions/singularity-update` usa o `product.json` do aplicativo e verifica releases do repositório oficial. Atestações de manifesto e instalador são verificadas pelo GitHub CLI.
- `.github/workflows/singularity-release.yml` e `scripts/prepare-singularity-release.cjs` preparam os instaladores, o manifesto e os hashes da tag.

### Instalação de atualizações pelo workbench

- `desktop.contribution.ts` registra o comando interno para o host nativo quando o produto habilita a instalação. `nativeHostMainService.ts` verifica arquivos não salvos em todas as janelas, preserva o veto do lifecycle e chama o assistente interativo do Inno após a saída. O arquivo é conferido novamente antes da execução.
- `code.iss` reaproveita os argumentos de relançamento na ação de abrir a IDE após instalação interativa. A extensão do Hub expõe apenas o estado de conexão para a verificação prévia.

### Convergência do atualizador

- `desktop.contribution.ts` mantém um único registro do comando interno. O host nativo rejeita todas as solicitações de execução até que a procedência possa ser validada na fronteira nativa com proteção do arquivo durante o lançamento.
- `extensions/singularity-update/provenance.js` usa Sigstore JS 5.0.0, Apache-2.0, com dependências fixadas pelo lockfile. A consulta às atestações públicas usa a API do GitHub sem credenciais.
