# Singularity IDE

IDE de código aberto, baseada no [Code - OSS](https://github.com/microsoft/vscode), com interface própria e uma central para usar vários agentes de código no mesmo lugar. Windows 11 primeiro.

> **Status: pré-alfa.** Compila e abre no Windows com identidade própria. A central multiagente ainda não existe. Não há instalador, assinatura nem atualização automática.

Singularity IDE não é afiliado, patrocinado nem endossado pela Microsoft. "Visual Studio Code" é marca da Microsoft. "Singularity" é um nome de trabalho e tem sobreposição nominal com outros projetos (por exemplo, o Apptainer e o SingularityCE); a pesquisa de marca será feita antes de qualquer binário público.

## O que é

*   Um fork real do Code - OSS (base `1.144.0`), com o histórico do upstream preservado e sincronização por merge de tags estáveis.
*   O núcleo do editor (Monaco, depuração, terminal, Git e API de extensões) não é reescrito. A personalização fica em arquivos próprios, e cada edição em arquivo do upstream é listada em [UPSTREAM-TOUCHPOINTS.md](UPSTREAM-TOUCHPOINTS.md).
*   O **Singularity Hub** (em construção) será um processo separado da janela da IDE, que lança as CLIs de agentes que você já usa (o primeiro adapter será o OpenCode) e mostra logs e resultados dentro da IDE.
*   Extensões vêm do Open VSX e de arquivos VSIX. O Visual Studio Marketplace não é usado.

## O que existe hoje

*   Compilação limpa do Code - OSS 1.144.0 no Windows, com edição, terminal e Git funcionando.
*   Identidade Singularity IDE: nome, pastas de dados próprias e isoladas, protocolo de URL e identificadores do instalador.
*   Documentos de design em [docs/designs](docs/designs).

## O que ainda não existe

O hub e o painel de agentes, a integração com o OpenCode, o catálogo Open VSX configurado, ícones próprios, instalador e atualização automática.

## Como compilar

Veja [docs/BUILD-WINDOWS.md](docs/BUILD-WINDOWS.md).

## Documentação

*   [Design arquitetural](docs/designs/singularity-ide.md), com as decisões e as evidências.
*   [Sincronização com o upstream](docs/upstream-sync.md).

## Licença

O código original do Singularity usa a licença MIT. O código do Code - OSS mantém a licença MIT da Microsoft e seus avisos. Detalhes em [NOTICE.md](NOTICE.md), [LICENSE.txt](LICENSE.txt) e [ThirdPartyNotices.txt](ThirdPartyNotices.txt).
