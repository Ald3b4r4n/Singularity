# E2E real do Singularity IDE (Windows)

Teste de ponta a ponta que usa o mouse e o teclado reais do Windows, como uma pessoa, com perfil isolado e um workspace temporário (com repositório Git). Nada do usuário é tocado e tudo é apagado no fim (`--keep` mantém).

```bash
node scripts/e2e/run.cjs --dev D:\dev\singularity --hub --out .\e2e-out    # a partir do código (precisa de npm run compile-client)
node scripts/e2e/run.cjs --exe "D:\dev\VSCode-win32-x64\Singularity IDE.exe" --hub --out .\e2e-out   # build empacotado
```

Saída: `report.json` e capturas PNG em `--out`. Código de saída 0 se tudo passar.

## O que cobre

Abertura e foco da janela, Ctrl+P e digitação num arquivo (conferido no disco), troca Dark/Light/Dark, terminal (`git status`), visão de Controle de Código-Fonte, Command Palette ("Singularity:"), extensões embutidas, painel Singularity Agents, fechamento como usuário, reabertura (workspace e arquivo restaurados) e, com `--hub`, o Hub: conectado com 0 sessões, vivo depois de fechar a IDE, mesma instância depois de reabrir, encerramento explícito liberando os arquivos.

## Scripts de cada funcionalidade

| Script | O que prova |
|---|---|
| `run.cjs` | abertura, arquivos, temas, terminal, Git, extensões, painel Agentes e Hub |
| `agents-check.cjs` | **Agentes**: sem Chat nem Copilot; seletores Serviço → Provedor → Modelo → Esforço iguais ao catálogo do Hub; tarefa real no OpenCode com streaming; trocar esforço; cancelar; encerrar; sobreviver a fechar e reabrir; painel estreito, Dark, Light e alto contraste |
| `opencode-recovery-guardrails.cjs` | após falhas reais do Hub: helper ausente, credencial incorreta e registro DPAPI adulterado são recusados sem executar prompt nem duplicar a sessão; o Job original é encerrado na limpeza |
| `chat-compat-check.cjs` | a infraestrutura de Chat continua para extensões de terceiros (extensão de sonda em `chat-compat-ext/`) |
| `browser-check.cjs` | Singularity Browser |
| `titlebar-account-check.cjs`, `login-live.cjs`, `push-check.cjs` | conta GitHub, login e push real (o proprietário aprova os códigos) |

## Segurança contra janela errada

Toda entrada do sistema (`keys`, `paste`, `click`, `runCommand` em `lib.cjs`) passa por `guard()`: se a janela em primeiro plano não for a janela principal **desta instância** (identificada pela linha de comando com o diretório do perfil), nada é enviado e a execução termina com erro. Antes de cada bloco de passos, `front()` tenta trazer a janela para frente uma vez; se não conseguir, aborta. Cliques fora da janela são recusados.

Se o computador estiver sendo usado por outra pessoa durante o teste, o guard vai parar o teste em vez de digitar em outro lugar. Não rode isto enquanto usa o computador.

## Limites

- A confirmação do que a interface mostra usa o DevTools (`--remote-debugging-port`), só para leitura (título, classes do tema, texto das visões). As ações são entradas reais.
- O conteúdo do painel Agentes (webview) não é lido pelo DevTools do workbench puro; `agents-check.cjs` o alcança com Playwright por CDP (`page.frames()`), só para ler, e confere o estado também pelo próprio Hub. As ações são cliques e teclas reais.
- Os atrasos entre passos (`sleep`) são fixos e foram ajustados para esta máquina; em outra, pode ser preciso aumentá-los.
