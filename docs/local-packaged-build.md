# Build empacotado local (somente teste)

Comando: `npm run gulp vscode-win32-x64-min`. Saída: `D:\dev\VSCode-win32-x64` (cerca de 1,4 GB). Levou cerca de 12 minutos nesta máquina.

Resultado verificado em 2026-11-03: o aplicativo empacotado abre e roda (`Singularity IDE.exe`), com as extensões `singularity-theme`, `singularity-welcome` e `singularity-agents` incluídas em `resources/app/extensions`.

O comando termina com erro no último passo, `prepareBuiltInCopilotRipgrepShim`: "Copilot SDK directory not found" em `extensions/copilot/node_modules/@github/copilot/sdk`. Por causa disso, não rodaram depois dele o `patchWin32Dependencies` e o cache de compilação do Node. Efeitos conhecidos:

- o atalho de ripgrep do Copilot não foi preparado (afeta só recursos do Copilot);
- o pacote não é uma distribuição pronta: serve para testar a abertura e medir o startup;
- a pasta `singularity-hub/` ainda não é copiada para o pacote, então o painel de agentes mostra que o Hub não está compilado.

Nada disso foi corrigido nesta task. Não publicar este pacote.
