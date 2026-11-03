# Hub: robustez e distribuição

Itens levantados na revisão do commit `0d4de0ec` e tratados na task de robustez (`1b2ebd2` em diante). Estado atual de cada um:

1. **Ambiente herdado: resolvido.** O Hub é iniciado com uma lista de inclusão (`hubEnvironment()` em `singularity-hub/src/launch.ts`): no Windows, só variáveis de sistema e de perfil necessárias (`SystemRoot`, `LOCALAPPDATA`, `TEMP`, `USERPROFILE` etc.) e `SINGULARITY_HUB_HOME`. Sem `PATH` (o Hub não cria processos, e as ferramentas do Windows são chamadas por caminho absoluto). Nada do IDE (Electron, VS Code, Copilot, credenciais de nuvem, proxies) é herdado.

2. **Trava antiga: resolvido.** A remoção não é mais "ler, conferir e apagar", que tinha uma janela de corrida. O arquivo antigo é renomeado para um nome privado (renomeação atômica: só um processo consegue), depois é apagado se ainda estiver velho, ou devolvido com `link` (criação atômica, que falha se já existir outra trava). Teste: seis processos disputando uma trava velha; exatamente um Hub sobrevive e nenhum arquivo `.stale` sobra (repetido três vezes, passou nas três).
   - Janela residual, documentada: um dono vivo cuja trava foi removida e não pôde ser devolvida porque outro iniciador já criou a sua. O efeito é no máximo um Hub a mais tentando iniciar; a prova de identidade (`discover`) impede que um cliente confie em outro processo.

3. **`--test-force-exit`: resolvido.** O processo de teste ficava vivo por causa de um teste que iniciava um Hub numa pasta e nunca o fechava (o servidor HTTP mantinha o event loop). O teste foi reescrito: agora verifica que um `startHub` numa pasta com permissão aberta é **recusado** (fail-closed) e fecha o que abriu. A opção saiu do script `npm test`; a suíte completa (44 testes) termina sozinha em cerca de 30 s.

4. **Ciclo de vida fora do harness: em andamento.** `scripts/e2e/explorer-lifecycle.cjs` abre o pacote por um atalho `.lnk` iniciado pelo Explorer (o pai do processo é conferido como `explorer.exe`), abre o painel de agentes pelo teclado, fecha a janela, confirma que o Hub continua vivo, reabre e confirma que é a mesma instância, encerra o Hub pelo comando e confirma que não sobrou nada. Usa o diretório de estado do usuário (`%LOCALAPPDATA%\Singularity\Hub`), porque um processo iniciado pelo Explorer não herda o ambiente do script: o teste recusa começar se já houver um Hub do usuário rodando. **Não testado:** logoff e desligamento do Windows (não é seguro fazer isso num teste automático).

## Distribuição

- **Binários de terceiros: resolvido.** O passo `patchWin32DependenciesTask` (que reescrevia metadados de versão e removia assinaturas de `rg.exe`, `tgrep.exe`, módulos nativos e DLLs) não é mais executado. Esses binários saem do pacote exatamente como foram construídos, e `scripts/package-win32.cjs` confere que o `rg.exe` do pacote é idêntico, byte a byte, ao original em `node_modules`. Antes, o pacote dizia "Microsoft" (e depois "Singularity IDE contributors") numa autoria que não era de nenhum dos dois.
  - Limitação: `build/gulpfile.reh.ts` (servidor remoto/REH) ainda contém o mesmo passo com `rcedit`. Não é usado no pacote desktop e fica como pendência, com o mesmo tratamento.

- **Procedência do Node.js: resolvido.** `scripts/package-hub.cjs` prova que o `node.exe` a ser distribuído é o binário oficial da versão: baixa o zip oficial (ou usa `--node-zip`), confere seu SHA-256 com o `SHASUMS256.txt` oficial (ou `--node-shasums`) e compara o `node.exe` dentro do zip com o que será copiado. Testado: o binário oficial passa; uma cópia com um byte a mais é recusada. **Não automatizado:** a verificação da assinatura GPG do `SHASUMS256.txt` (há a chave pública da equipe de release do Node.js; a verificação é manual).
