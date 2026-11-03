# Sincronização com o upstream (Code - OSS)

## Base atual

| Item | Valor |
|---|---|
| Upstream | https://github.com/microsoft/vscode (remote `upstream`) |
| Tag fixada | `1.144.0` |
| Commit | `2c33b50b16c472efe58357d1d2a8a5414bc23fbf` |
| Node do upstream (`.nvmrc`) | `24.22.1` |
| Método | Merge de tags estáveis num fork real, com `git rerere` |

## Regras

1.  O histórico completo do Code - OSS é mantido, e o remote `upstream` fica configurado.
2.  Customizações ficam, de preferência, em diretórios e módulos próprios.
3.  Toda edição em arquivo original é registrada em [UPSTREAM-TOUCHPOINTS.md](../UPSTREAM-TOUCHPOINTS.md).
4.  `git rerere` fica ativo (`git config rerere.enabled true`). O resultado de cada resolução é sempre conferido.
5.  A versão do upstream é fixada por tag e commit identificados, registrados neste arquivo.
6.  Antes de incorporar uma tag nova à branch estável, o merge acontece numa branch de teste. O build e as funcionalidades essenciais (abrir, editar, terminal, Git, instalar extensão) são validados lá.
7.  Os commits próprios são claros e separados por mudança funcional.
8.  Nunca se usa `main` do upstream nem tag de Insiders como base. Não há atualização automática a cada release: cada tag nova é avaliada antes.

## Procedimento

```bash
git fetch upstream --tags
git checkout -b sync/<tag-nova> singularity
git merge <tag-nova>
# resolver conflitos, conferir o que o rerere reaplicou
npm install
npm run compile
# validar e só então atualizar a branch estável
```

## Registro de sincronizações

Cada linha registra a tag de origem e a de destino, o número de arquivos em conflito e o tempo gasto. Esses números decidem se o método continua adequado. Se os conflitos se repetirem nos mesmos arquivos e o custo ficar alto, reavalia-se a alternativa de recolocar uma pilha de commits sobre cada tag (Opção C da decisão de sync).

| Data | Origem | Destino | Arquivos em conflito | Tempo | Observações |
|---|---|---|---|---|---|
| 2026-11-02 | (clone inicial) | `1.144.0` | 0 | n/a | Base do fork. Compilou sem alterações. |
