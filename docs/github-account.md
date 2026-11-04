# Conta GitHub no Singularity

## Decisão

O Singularity não usa o provedor de autenticação do GitHub que vem com o Code - OSS. Ele está ligado ao aplicativo OAuth da Microsoft/VS Code (`01ab8ac9400c4e429b23`), aceita apenas os esquemas de retorno `vscode://` e domínios da Microsoft (`src/vs/.../github-authentication/src/common/env.ts`) e só faz sentido para aquele aplicativo. Reutilizar esse identificador faria o Singularity se passar pelo app da Microsoft, por isso não é feito.

O login do Singularity usa o **OAuth device flow** (RFC 8628) com um **aplicativo OAuth próprio**:

- só precisa do *client id*, que é público: **não há segredo no produto nem no repositório**;
- não precisa de URL de retorno nem de esquema de URI registrado;
- funciona sem navegador embutido: o usuário abre a página do GitHub e digita um código curto.

## O que o proprietário precisa criar (uma vez)

1. Em GitHub → Settings → Developer settings → **OAuth Apps** → *New OAuth App*:
   - Application name: `Singularity IDE`
   - Homepage URL: `https://github.com/Ald3b4r4n/Singularity`
   - Authorization callback URL: qualquer URL válida (não é usada pelo device flow), por exemplo `https://github.com/Ald3b4r4n/Singularity`
2. Na página do aplicativo, marcar **Enable Device Flow**.
3. Copiar o **Client ID** (não o Client secret; o device flow não usa segredo).
4. Informar o Client ID para configurar a build. Ele fica na configuração `singularity.account.githubClientId` (escopo de máquina). Sem ele, a conta fica indisponível e o produto diz isso.

Não colar o Client secret em lugar nenhum do projeto.

## O que foi implementado

Extensão `extensions/singularity-account` (embutida, sem alterar arquivos do upstream):

- `github.js`: device flow (pedido do código, espera com `authorization_pending`, `slow_down` e `expired_token`, cancelamento), leitura da conta (`/user`) com apenas login, nome, avatar e id.
- `extension.js`: comandos **Entrar com GitHub**, **Sair**, **Trocar de conta** e **Gerenciar conta**, item na barra de status com o login. O token fica no `SecretStorage` (credencial do sistema); o `globalState` guarda só dados públicos da conta. Uma conta com token revogado é desconectada sozinha ao ser verificada.
- Escopo pedido no login: `read:user` (identidade). Publicar exige mais permissão e será pedido separadamente (Task 3).
- Os testes (`node extensions/singularity-account/test/run.cjs`) usam um GitHub simulado e cobrem: código de dispositivo sem segredo, recusa sem client id (e nunca usar o id da Microsoft), espera, `slow_down`, expiração, negação, cancelamento, leitura da conta sem e-mail, token revogado e o manifesto.

## O que não foi feito, e por quê

- **Botão "Sign In" da barra de título.** Ele abre o menu de contas do núcleo, que hoje mistura o Copilot. Trocar esse caminho exige mudança no núcleo do workbench (serviço de contas); fica registrado como pendência de núcleo, para ser feito com a mesma cautela dos outros patches. Enquanto isso o login do Singularity está disponível pelo Command Palette e pelo item da barra de status.
- **Git.** Estar logado no Singularity não autoriza `git push` por si só. A autorização de transporte será dada ao Git de forma explícita, por processo (sem alterar o Git global nem o gerenciador de credenciais do usuário), na Task 3.
- **Teste contra o GitHub real.** Depende do client id do aplicativo, que só o proprietário pode criar. Os testes atuais usam um GitHub simulado; o fluxo real ainda não foi executado.

## Entrada na barra de título

O botão "Sign In" que o Code - OSS mostra na barra de título é o do **Copilot** (`workbench.action.chat.signInIndicator`, em `chatSetupContributions.ts`): ele abre o setup do Copilot. No Singularity esse botão fica desligado por padrão (`chat.titleBar.signIn.enabled: false`) e a mesma posição mostra a conta GitHub do produto.

| Estado | O que aparece | Clique |
|---|---|---|
| Desconectado | botão **Entrar com GitHub** | inicia o fluxo OAuth do Singularity (`singularity.account.signIn`) |
| Conectado | avatar, login e ponto verde; a dica diz se a publicação está autorizada | abre o menu da conta (`singularity.account.manage`): conta conectada, autorizar ou remover a publicação, trocar de conta, sair |

Arquitetura: a extensão `singularity-account` continua sendo a única dona do OAuth, dos tokens (SecretStorage) e da autorização de publicação. Ela publica só estado público, por `setContext`: `singularity.account.ready`, `signedIn`, `login`, `name`, `avatar` (data URI da imagem pública já guardada em cache) e `publishAuthorized` (booleano). O workbench lê essas chaves e desenha a entrada (`src/vs/workbench/contrib/singularityAccount/browser/singularityAccountTitleBar.ts`); nenhum token chega ao renderer. O teste `test/workbench-state.test.cjs` garante que o código que publica o estado não lê tokens.

O item da barra de status continua, como indicador complementar da mesma conta: mesmos comandos, mesmo estado, sem segundo login. Em janelas abaixo de 760 px a entrada mostra só o avatar ou o ícone.

Teste: `node scripts/e2e/titlebar-account-check.cjs --out <pasta> [--exe <exe>]` (cliques e teclas reais; o proprietário aprova o código no navegador).
