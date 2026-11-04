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

O verificador Sigstore JS vem nas dependencias do aplicativo e consulta as
atestacoes publicas por digest, sem credenciais. A raiz de confianca vem do
TUF do Sigstore. A politica confere identidade do workflow, ID do
repositorio, ref, commit, runner hospedado pelo GitHub e o digest do sujeito
na declaracao assinada.

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

## Revisão da atualização na IDE

O comando de verificação e o indicador na barra de status abrem uma
revisão com a versão instalada, a versão nova e as notas da release.
O download pode ser adiado ou cancelado. O cliente só oferece ações sobre
o EXE depois das verificações de integridade e procedência.

A execucao pelo host nativo esta desabilitada em todos os builds. Um
hash fornecido pelo chamador nao autoriza a execucao. A reativacao exige
que o processo principal valide a procedencia independentemente e mantenha
o arquivo protegido contra substituicao durante a verificacao e o
lancamento. As verificacoes de disponibilidade e de download continuam
ativas.

O workflow pode ser despachado na branch `singularity` com
`provenance_smoke=true` para atestar texto sintetico e verificar o resultado
sem credenciais. O teste usa a identidade da branch, que nao satisfaz a
politica de distribuicao, e nao envia instaladores nem cria releases ou tags.
