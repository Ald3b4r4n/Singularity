# Hub v0: pendências de robustez (antes de executar agentes)

Registradas durante a revisão do commit `0d4de0ec`. Nenhuma foi alterada na task da abertura.

1. **Ambiente herdado.** `hubEnvironment()` (`singularity-hub/src/launch.ts`) copia o ambiente do processo pai, menos `ELECTRON_*`, `VSCODE_*`, `ORIGINAL_XDG*` e `CHROME_*`. O Hub precisa só de alguns itens (`SystemRoot`, `LOCALAPPDATA`, `USERNAME`, `PATH` mínimo, `SINGULARITY_*`). Trocar a lista de exclusão por uma lista de inclusão.
2. **Trava velha.** A remoção em `instance.ts` lê o conteúdo, confere o `nonce` e apaga; entre a leitura e o `rm` outro processo pode ter criado uma trava nova. Estudar uma exclusão do sistema operacional (arquivo mantido aberto sem compartilhamento, ou mutex nomeado) e testar com muitos iniciadores simultâneos.
3. **`--test-force-exit`.** O runner dos testes do Hub não termina sozinho. Identificar os handles abertos (timers, sockets, processos filhos dos testes) e remover a opção.
4. **Ciclo de vida no Windows fora do harness.** O teste de "Hub dentro de um Job Object" rodou dentro do ambiente de execução desta sessão. Repetir com a IDE iniciada pelo Explorer ou por atalho, e com logoff/shutdown, antes de depender da sobrevivência do processo.
