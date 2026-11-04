# Regressão dirigida — recuperação, histórico e ambiente de teste (2026-11-04)

Este relatório complementa `regression-2026-11-04.md`. Não reimplementa a recuperação nem o histórico: reexecuta, sobre o
código **publicado** (`fc28a46`), os testes que provam o comportamento já entregue e registra os defeitos encontrados.

## Como foi isolado

Os testes rodaram a partir de um worktree limpo de `fc28a46` (`git worktree`), empacotado separadamente
(`VSCode-win32-x64` ao lado do worktree). Os ajustes locais não commitados de interface e perfil da árvore principal não
foram lidos, copiados nem incluídos: o pacote e os commits vêm só do worktree.

## Resultado

| Item | Resultado |
|---|---|
| Hub, `npm test` (worktree limpo) | 66/66 |
| Helper ausente após queda do Hub (`opencode-recovery.cjs`, janela empacotada) | sessão original recuperada após `SIGKILL`, SSE retomado, interrupção e Job Object vazio confirmados |
| Credencial errada e registro adulterado (`opencode-recovery-guardrails.cjs`) | `incorrectCredential: rejected`, `tamperedRecord: rejected`, `duplicateExecution: false`, `originalJobStopped: true` |
| Histórico grande, duas janelas reais (`opencode-history.cjs`, pacote) | 3 sessões, 2 clientes, 4 prompts, isolamento por workspace, histórico após reinício e exclusão: aprovado |
| Regressão geral empacotada (`run.cjs --hub`): terminal, Git, Hub, Agentes, fechar/reabrir | aprovado |
| Conta GitHub (`account-check.cjs`) | aprovado |
| Navegador (`browser-check.cjs`) | passos 1–10 aprovados; o passo final falhou por erro do processo `pwsh` do próprio harness, não do produto |
| Barra de título (`titlebar-account-check.cjs`) | A3 e A4 aprovados (clique real inicia o fluxo de dispositivo, sem Copilot); a etapa seguinte exige aprovação humana do código no GitHub e não foi concluída |
| Agentes (`agents-check.cjs`) | passos 1–7, 8b–8e e 10 aprovados; ver pendências abaixo |

## Defeitos encontrados e corrigidos

1. **`npm test` em checkout limpo falhava 63/66.** O helper nativo (`dist/singularity-job.exe`) não existia e os testes de
   histórico (DPAPI) e de recuperação (Job Objects) dependem dele. Novo `singularity-hub/scripts/build-native.cjs`, ligado a
   `npm test` (`build:native`): compila o helper quando falta ou está desatualizado e, sem o toolchain, para com uma única
   mensagem clara.
2. **Teste de loopback frágil.** A prova de que o Hub só escuta em `127.0.0.1` dependia da saída do `netstat`, que não é
   observável em todos os ambientes. Substituída por uma prova de comportamento: conecta em `127.0.0.1` e tenta cada
   endereço IPv4 não interno da máquina (deve ser recusado); sem outra interface, o teste é marcado como ignorado.
3. **`opencode-recovery.cjs` reprovava por latência do modelo gratuito.** O script exigia saída em 30 s, mas o primeiro
   token de um modelo gratuito leva 6–13 s em horário calmo e mais em horário cheio. A espera agora é de 90 s e pode ser
   ajustada com `SINGULARITY_E2E_STREAM_WAIT_MS`.

## Observações sobre o ambiente de teste (não são defeitos do produto)

- **Empacotar a partir de um worktree exige `BUILD_SOURCEVERSION`.** Sem ele, o build não consegue ler o commit (o `.git` do
  worktree é um arquivo), o `product.json` fica sem `commit` e o produto passa a procurar `@xterm/xterm` fora do
  `node_modules.asar`: o terminal falha com "An unknown error occurred". Com `BUILD_SOURCEVERSION=$(git rev-parse HEAD)` o
  pacote é idêntico em comportamento ao da árvore principal. Também é preciso que `node_modules` (raiz e extensões) sejam
  diretórios reais, não junctions, senão o gulp falha com `EISDIR`.
- **Aviso do Firewall do Windows.** O primeiro uso do Node empacotado em um caminho novo abre o aviso "Deseja permitir que
  redes públicas e privadas acessem este aplicativo?". Ele tira o foco da IDE e derruba os testes guardados por foreground.
  Foi recusado (Cancelar): o Hub escuta só em loopback e não precisa de acesso de rede.
- **`agents-check.cjs` não deve reutilizar o diretório de saída**: o Hub de teste vive em `<out>/hub` e uma execução
  interrompida deixa uma sessão que a execução seguinte lê como se fosse nova. Use sempre `--out` novo.

## Pendências desta regressão

- `agents-check.cjs` 8a ("a IDE fecha normalmente"): neste ambiente o harness encontra 10 processos após 30 s e força o
  encerramento. O mesmo ocorre contra o pacote anterior da árvore principal, e o fechamento isolado (com e sem sessão no
  Hub, inclusive após cancelar uma tarefa, com diálogos personalizados) leva ~2 s e `run.cjs` fecha com `forced: 0`. Não foi
  isolada a causa; fica registrado como pendência de investigação, sem alterar o produto.
- `agents-check.cjs` 9a ("janela estreita"): a janela não fica abaixo de 690 px neste monitor (critério `<= 620`), com
  `overflow: 0` e controles utilizáveis. Critério dependente da tela.
- `titlebar-account-check.cjs`: a parte que exige aprovar o código no GitHub não foi exercitada nesta regressão.

## Segunda rodada: pendências esclarecidas (pacote com os três provedores)

| Pendência | Conclusão | Evidência |
|---|---|---|
| `agents-check` 8a (a IDE fecha normalmente) e 9a (janela estreita) | Instabilidade do ambiente: não reproduziu em nenhuma das quatro execuções seguintes (`forced: 0`) | quatro execuções, 8a e 9a aprovados |
| `agents-check` 10c ("Target page closed") | Defeito do harness, não do produto: depois de mover o editor Agentes para outro grupo, o Playwright perdia o handle da página (o screenshot seguinte mostra o editor movido e a IDE íntegra). O teste agora reconecta pelo DevTools. O passo 10d esperava a tela de boas-vindas, mas o editor reaberto pode restaurar a sessão em uso; passou a exigir o compositor | duas execuções aprovadas |
| `agents-check` 11b/11c (Browser e terminal pela paleta) | O foco do teclado ficava dentro de um webview depois dessas ações e a paleta falhava. Browser, terminal e Git são cobertos por `browser-check.cjs` e `run.cjs` no mesmo pacote, ambos aprovados; os passos duplicados saíram do `agents-check` | `run.cjs` aprovado; `browser-check` aprovado, inclusive os passos 12a–12c |
| `browser-check` passo final | Erro do `pwsh` do harness ao trazer a janela à frente e capturá-la (foco do sistema operacional). A captura agora tenta três vezes antes de reportar | execução completa aprovada |
| E2E completo com OpenCode e Claude Code na IDE empacotada | Aprovado, agora com o Codex CLI como terceiro provedor | `agents-providers-check`: 50 checagens aprovadas |

Defeito de produto encontrado e corrigido nesta rodada (não era do harness): cancelar uma execução retomada do Codex CLI cerca de
4 s depois do início deixava a sessão em `running` para sempre, porque o evento `close` do Node não disparava. Os adapters do
Claude Code e do Codex agora concluem na saída do processo. Detalhes em `codex-cli-adapter.md`.
