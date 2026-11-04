# Atualizações do Singularity

A versão de distribuição vem de `singularityVersion` em `product.json`.
A tag correspondente é `vX.Y.Z` para Stable ou `vX.Y.Z-preview.N` para
Preview. Stable recebe somente releases estáveis. Preview pode receber uma
release estável mais nova. Instalações Preview usam esse canal por padrão,
com a escolha explícita em `singularity.update.channel` tendo precedência.

## Preparação de uma release

Use o workflow manual **Singularity Windows release build** com a tag da
versão no repositório oficial `Ald3b4r4n/Singularity`. O job confirma a
correspondência da tag com a versão do produto, executa os testes, empacota os
instaladores x64 e prepara:

- `SingularityIDE-<versão>-x64-user.exe` e `SingularityIDE-<versão>-x64-system.exe`
- `singularity-release.json` com versão, canal, commit, workflow, resultado
  do build, escopo, tamanho e SHA-256 de cada instalador
- `SHA256SUMS` e `release-notes.md` a partir da tag
- Atestações GitHub Actions do manifesto e dos dois EXEs

O workflow deixa o envio de artefatos desligado por padrão. Após aprovação
da distribuição, habilite-o no despacho, confira a evidência de procedência
e anexe os dois EXEs, o manifesto e o arquivo de hashes à release da mesma
tag. Use as notas da tag no corpo da release e marque Preview como
pré-release.

## Verificação no cliente

O cliente seleciona apenas assets com o nome e a URL exatos da release
oficial. Para o download, aceita redirecionamentos HTTPS ao CDN de assets
do GitHub. O manifesto deve ser atestado e coerente com a release, canal,
arquitetura e escopo da instalação. O instalador deve coincidir com o
tamanho e SHA-256 do manifesto atestado e com o arquivo de hashes. A
atestação do EXE deve corresponder ao mesmo repositório, workflow, tag e
commit. Falhas e cancelamentos descartam os arquivos da tentativa. Uma
nova tentativa baixa os assets em outro diretório.

A verificação usa o GitHub CLI instalado no diretório padrão do Windows
(`Program Files\GitHub CLI`). Configure a autenticação do CLI conforme
necessário para consultar atestações. As consultas de release e asset do
Singularity são anônimas e não usam a sessão OAuth da IDE.

A atestação vincula os bytes ao build do GitHub Actions. Authenticode
assina o executável para a verificação do Windows. O SmartScreen usa
reputação e outros sinais do sistema. Os instaladores locais desta etapa
ainda não têm assinatura Authenticode.

- [Verificar atestações com GitHub CLI](https://cli.github.com/manual/gh_attestation_verify)
- [Atestações de artefatos no GitHub Actions](https://docs.github.com/en/actions/concepts/security/artifact-attestations)

## Testes locais

`node extensions/singularity-update/test/run.cjs` testa a seleção e o
download com respostas controladas, inclusive rejeições de integridade e
procedência. O caminho positivo do teste usa um verificador simulado. O
primeiro build atestado do Singularity precisa ser conferido com os
artefatos gerados pelo workflow.
