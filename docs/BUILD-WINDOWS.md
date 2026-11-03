# Compilar o Singularity IDE no Windows 11

Valores medidos na primeira compilação (base `1.144.0`, sem personalização), numa máquina com 12 threads e 24 GB de RAM.

## Pré-requisitos

| Item | Versão ou nota |
|---|---|
| Windows | 11 (x64) |
| Node.js | `24.22.1`, o mesmo do `.nvmrc` da tag |
| Python | 3.x com `setuptools` (testado com 3.13) |
| Git | testado com 2.56. `core.longpaths=true` e long paths do Windows habilitados |
| Visual Studio Build Tools | 2026 (18.x): workload C++, Windows SDK 26100, bibliotecas Spectre, ATL e MFC |
| Espaço em disco | o clone com histórico completo ocupa cerca de 2 GB, mais as dependências e a compilação |
| Caminho do clone | **sem espaços** (por exemplo, `D:\dev\singularity`) |

Instalação do Build Tools por `winget`, num PowerShell **elevado** (os componentes são os que a documentação do upstream pede para Windows x64):

```bash
winget install --id Microsoft.VisualStudio.BuildTools --source winget --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.26100 --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre --add Microsoft.VisualStudio.Component.VC.ATL.Spectre --add Microsoft.VisualStudio.Component.VC.ATLMFC.Spectre"
```

Depois da instalação, feche e reabra o terminal.

## Configurar o repositório

```bash
git remote add upstream https://github.com/microsoft/vscode
git fetch upstream --tags
git config rerere.enabled true
```

## Compilar e executar

```bash
npm install
npm run compile
```

Tempos medidos: `npm install` cerca de 14 minutos (42 módulos nativos compilados) e `npm run compile` cerca de 4,5 minutos.

Para abrir o editor em modo de desenvolvimento com **dados totalmente isolados** de qualquer outra instalação:

```bash
scripts\code.bat --user-data-dir D:\dev\singularity-data\user --extensions-dir D:\dev\singularity-data\extensions --shared-data-dir D:\dev\singularity-data\shared
```

Sem essas três opções, o modo de desenvolvimento ainda grava em pastas do perfil do usuário (`~/.singularity-ide-dev` e `~/.singularity-ide-shared`).

O pré-lançamento baixa o Electron e extensões embutidas do GitHub na primeira execução.

## Observações

*   O build aberto traz uma tela de login do GitHub Copilot e um painel de Chat na primeira execução. O login pode ser recusado ("Continue without Signing In"). Remover ou desligar essa parte é uma decisão pendente.
*   O `npm audit` aponta vulnerabilidades em dependências do upstream. Elas não são tratadas aqui; acompanham o upstream.
*   Ícones e logotipos ainda são os do Code - OSS.
