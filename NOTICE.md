# Aviso de licenças e atribuição

Singularity IDE é um fork do [Code - OSS](https://github.com/microsoft/vscode), repositório de código aberto da Microsoft. Não é afiliado, patrocinado nem endossado pela Microsoft. "Visual Studio Code" é marca da Microsoft e não é usada como nome deste produto.

## Código original do Singularity

O código novo escrito para o Singularity IDE usa a **licença MIT**. Ele fica em diretórios próprios e nos arquivos listados em [UPSTREAM-TOUCHPOINTS.md](UPSTREAM-TOUCHPOINTS.md):

*   `singularity/` (hub, adapters e ferramentas)
*   `extensions/singularity-*` (extensões embutidas próprias)
*   `docs/`

```text
MIT License

Copyright (c) 2026 Ald3b4r4n e contribuidores do Singularity IDE

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Código do upstream (Code - OSS)

Todo o restante do repositório vem do Code - OSS, sob a licença MIT, com copyright da Microsoft. Os arquivos de licença do upstream **não foram alterados**:

*   [LICENSE.txt](LICENSE.txt): licença MIT do Code - OSS (Copyright (c) 2015 - present Microsoft Corporation).
*   [ThirdPartyNotices.txt](ThirdPartyNotices.txt): avisos de componentes de terceiros do upstream.

O histórico completo do upstream foi preservado neste repositório.

## O que ainda precisa ser conferido antes de distribuir um binário

Estas verificações ainda **não** foram feitas e bloqueiam apenas a distribuição pública de binários, não o desenvolvimento:

*   Avisos adicionais exigidos pelo binário (Electron, Chromium, ffmpeg) e atribuição de ativos sob outras licenças (por exemplo, os codicons).
*   Licença e redistribuição das extensões embutidas baixadas no pré-lançamento (como `ms-vscode.js-debug`) e dos pacotes `@github/copilot-sdk` e `@anthropic-ai/claude-agent-sdk`, cujo campo de licença é "SEE LICENSE IN README.md" (Termos Comerciais da Anthropic).
*   Pesquisa de marca e de conflito de software para o nome "Singularity". Há sobreposição nominal com o antigo projeto Singularity, atualmente Apptainer, e com SingularityCE.
*   Ícones e logotipos: ainda são os do Code - OSS.
