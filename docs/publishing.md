# Publicação de commits no GitHub

## Modos

| Modo | O que acontece |
|---|---|
| **Manual** (padrão) | Nada é enviado pelo Singularity. O usuário publica pelo Git ou pelo comando **Publish Commits Now**. |
| **Assistido** | Quando há commits locais à frente do upstream, o Singularity pergunta **Publicar / Agora não**. "Agora não" não pergunta de novo pelo mesmo commit. |
| **Automático** | Depois de cada commit, o Singularity publica no upstream. Só vale para repositórios listados explicitamente. |

Configuração (escopo de máquina, ou seja, fora de `.vscode/settings.json` de qualquer projeto):

- `singularity.publish.defaultMode`: `manual` ou `assisted`. Nunca `automatic`.
- `singularity.publish.automaticRepositories`: lista de pastas de repositórios que podem publicar automaticamente. A comparação é pelo caminho real (nome curto do Windows, nome longo, separadores e maiúsculas dão no mesmo).

Um repositório que não está na lista nunca publica sozinho, mesmo com um commit feito por outra ferramenta.

## Regras, aplicadas no código

- O destino é o **upstream do branch atual**. Sem upstream, o Singularity informa e não faz nada. Nenhum remoto é criado, renomeado ou alterado; `origin` não é tratado como propriedade da conta.
- O upstream é **buscado antes de decidir** (`git fetch`, sem merge e sem tocar na árvore de trabalho). Se o remoto tem commits que o local não tem, é divergência: nada é enviado e o usuário é avisado.
- **Sem force-push.** Uma recusa de não-fast-forward é reportada como conflito.
- Um commit é publicado **uma vez por sessão**. Um segundo pedido para o mesmo commit não envia nada.
- Só commits são publicados: a árvore de trabalho nunca entra no push. Nenhum commit é criado automaticamente.
- Commits feitos **por fora** da IDE (terminal, CLI, agente) são vistos pelo observador de `.git/HEAD`, `.git/logs/HEAD` e `.git/refs/heads`.
- Falhas são classificadas: sem conexão (os commits continuam locais), autenticação recusada, remoto inacessível, divergência.
- A decisão de cada checagem fica no log da extensão (`Singularity Account`): modo, commits à frente e atrás, e a ação.

## Autenticação no push

- Para remotos `https://github.com/...`, quando há conta conectada, o token é entregue **somente ao processo do `git push` ou `git fetch` daquele comando**, por variável de ambiente e um helper de credencial que substitui os helpers do usuário naquele comando. O token não aparece na linha de comando, não é gravado em disco e não sai da extensão. A configuração do Git do usuário não muda.
- Para outros remotos, vale a autenticação que o Git já usa na máquina (por exemplo, o Git Credential Manager).

## Testes

- `node --test extensions/singularity-account/test/publish.test.cjs`: 10 testes com **Git real**, repositórios temporários e um remoto bare local: sem upstream, pergunta e publicação, publicação única, commit externo, divergência sem force, falha offline (remoto recusando conexão), e o token só no processo do push.
- `node --test extensions/singularity-account/test/modes.test.cjs`: correspondência de caminhos, incluindo nome curto do Windows.
- `node scripts/e2e/publish-check.cjs --dev <repo>`: na IDE real (teclado e clique no botão da página): pergunta no modo assistido, "Publicar" envia exatamente o commit, modo automático envia o commit seguinte sem perguntar (confirmado no log), divergência é avisada e o histórico do remoto é preservado.

## O que não foi testado

- **Push real para o GitHub.** Depende do client id do aplicativo OAuth (ver `docs/github-account.md`). Os testes usam um remoto local. O caminho do token para `github.com` está implementado e coberto só pela verificação do helper de credencial.
- **Repositórios privados** e permissões de organização.
- Ausência de rede de verdade durante o uso prolongado (o caso offline foi simulado com uma porta recusando conexão).
