# Build empacotado do Windows (local, não publicar)

```bash
node scripts/package-win32.cjs            # gera D:\dev\VSCode-win32-x64 (cerca de 7 minutos) e confere o resultado
node scripts/package-win32.cjs --skip-gulp   # só confere uma pasta já gerada
```

O script acha o `signtool.exe` do Windows SDK (`Windows Kits\10`), coloca no PATH e roda `npm run gulp vscode-win32-x64-min`. Precisa do Windows SDK instalado: o passo `patchWin32Dependencies` usa o `signtool` para remover assinaturas antes de reescrever a informação de versão dos binários nativos.

Verificado em 2026-11-03: o pipeline termina com código 0 e o aplicativo empacotado passa no E2E real (`scripts/e2e/run.cjs --exe`, 12 passos).

## O que estava falhando e por quê

O pipeline anterior parava em `prepareBuiltInCopilotRipgrepShim` ("Copilot SDK directory not found"). Causa exata:

1. O build local empacota a extensão `extensions/copilot` por `packageCopilotExtensionStream` (`build/lib/extensions.ts`).
2. Essa função passa as dependências de produção pelo `build/.moduleignore`, que tem a regra `@github/copilot/**` (o Agent Host usa o runtime que vem no `@github/copilot-sdk`). Resultado medido: 0 arquivos de `@github/copilot` no pacote.
3. O passo seguinte exige `extensions/copilot/node_modules/@github/copilot/sdk` dentro do pacote e lança o erro.

Como o erro nasce de duas regras do upstream que não combinam no build local, não há conserto "pequeno" que seja honesto: criar a pasta vazia ou arquivos falsos esconderia o problema.

## Decisão: o Singularity não distribui a extensão Copilot embutida

`@github/copilot` está sob a **GitHub Copilot CLI License**, que só permite redistribuir **cópias não modificadas**, com a licença incluída, dentro de um aplicativo com funcionalidade própria. O build do upstream poda e altera esse pacote (remove prebuilds de outras plataformas, adiciona o ripgrep). Para o Singularity (que não é o GitHub nem a Microsoft) isso seria uma redistribuição modificada. Além disso, o produto não depende do Copilot.

Por isso `build/gulpfile.vscode.ts` ganhou uma chave: **`singularityBuild.shipBuiltInCopilot`** em `product.json`, padrão desligado. Desligada, o build:

- não empacota `extensions/copilot`;
- não roda `prepareCopilotRipgrepShimTask`;
- não inclui o lançador `bin/copilot-shim` (atalho do Copilot CLI).

Ligada (`true`), volta ao comportamento original do upstream (e ao erro acima, até alguém resolver a licença e a regra do `.moduleignore`).

O que continua: o `@github/copilot-sdk` (licença MIT) e seu runtime de plataforma, usados pelo Agent Host do núcleo; a interface de Chat do núcleo (abre normalmente, ver `branding/event-minimal/packaged/06-chat-sem-copilot.png`); e o Copilot como recurso opcional que o usuário instala por conta própria, sob os termos dele.

## Outras mudanças no pipeline

- `patchWin32DependenciesTask` gravava `CompanyName: Microsoft Corporation` e copyright da Microsoft em todo binário que ele toca (`rg.exe`, `tgrep.exe`, `.node`, DLLs), inclusive de terceiros. Agora grava `Singularity IDE contributors` e "autores do componente incluído, ver ThirdPartyNotices.txt". Verificado no `rg.exe` do pacote.
- Os passos seguintes (`patchWin32Dependencies`) agora executam. O cache de compilação do Node (`generateNodeCompileCache`) só roda quando `product.quality` existe; o `product.json` do Singularity não tem `quality`, então ele é pulado de propósito (não afeta a execução, só a otimização de inicialização). Decidir isso junto com o canal de atualização.

## Limitações

- O Hub ainda não é copiado para o pacote (próxima task).
- Não há instalador (Inno Setup), assinatura de código nem atualização automática.
- Local apenas: nenhum binário foi publicado.
