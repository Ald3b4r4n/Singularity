# Atualizações do Singularity (GitHub Releases)

## Estado

Implementado e verificado:

- descoberta das releases da **origem oficial fixa** (`Ald3b4r4n/Singularity`), anônima, sem token;
- escolha por canal (`stable` ou `preview`), com versão semântica; pré-releases nunca entram no canal estável;
- release **incompleta** (sem o instalador da plataforma ou sem `SHA256SUMS`) é ignorada, com o motivo registrado;
- assets só de `github.com`;
- download com progresso real, aceito somente se o **SHA-256 bate com o `SHA256SUMS` oficial** e o tamanho bate com os metadados; arquivo adulterado, truncado ou com checksum errado é apagado;
- comandos **Verificar atualizações** e **Baixar atualização** na IDE; o download termina com "Mostrar arquivo" (a pasta do instalador verificado).

**Não implementado, e por isso a IDE não oferece instalar:**

- **Instalação.** Falta o instalador Inno Setup da versão e os testes de migração entre duas versões instaláveis (preservação de perfis, extensões, configurações e do Hub em execução). Até lá, o instalador baixado é aberto manualmente pelo usuário.
- **Assinatura de procedência.** O SHA-256 vem da mesma origem que o arquivo (GitHub Releases). Isso protege contra download corrompido e contra troca do arquivo sem troca da lista, mas não contra um release malicioso publicado com a conta do projeto. A verificação de assinatura (chave própria, ou atestações do GitHub) depende de uma decisão de chaves do proprietário e ainda não existe.
- **Fluxo de publicação de releases.** Ainda não há workflow que gere o instalador e o `SHA256SUMS`. Até lá, não há nenhuma release pública: a verificação real da API retorna zero releases.
- **Reinício para atualizar.** Não existe, pelo motivo acima.

## Como uma release deve ser publicada (quando existir)

Para cada versão `X.Y.Z` (ou `X.Y.Z-preview.N`), um asset `Singularity-X.Y.Z-win32-x64-setup.exe` e um asset `SHA256SUMS` com uma linha por arquivo, no formato `sha256  nome`. A linha do `SHA256SUMS` é a referência: o instalador é recusado se não bater.

```powershell
Get-FileHash .\Singularity-X.Y.Z-win32-x64-setup.exe -Algorithm SHA256
```

A versão instalada vem de `extensions/singularity-update/package.json`. Ela deve ser atualizada junto com a release.

## Limites da verificação

- Verificado: a lógica (13 testes com um servidor local que imita a API do GitHub), o download com as três falhas (adulterado, checksum errado, truncado), a consulta real à API oficial e o comando na IDE real.
- Não verificado: uma release real com instalador (não existe ainda), e o comportamento da rede do usuário final (proxies, firewalls, sem conexão por muito tempo).
