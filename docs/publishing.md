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
- Se o `fetch` falhar (sem conexão ou sem permissão), o estado do remoto é desconhecido: **nada é enviado nem oferecido** com base no que já se sabia dele. Os commits continuam locais, e o usuário é avisado uma vez por commit.
- **Sem force-push.** Uma recusa de não-fast-forward é reportada como conflito.
- Um commit é publicado **uma vez por sessão**. Um segundo pedido para o mesmo commit não envia nada.
- Só commits são publicados: a árvore de trabalho nunca entra no push. Nenhum commit é criado automaticamente.
- Commits feitos **por fora** da IDE (terminal, CLI, agente) são vistos pelo observador de `.git/HEAD`, `.git/logs/HEAD` e `.git/refs/heads`.
- Falhas são classificadas: sem conexão (os commits continuam locais), autenticação recusada, remoto inacessível, divergência.
- A decisão de cada checagem fica no log da extensão (`Singularity Account`): modo, commits à frente e atrás, e a ação.

## Autenticação no push

- Para remotos `https://github.com/...`, quando há conta conectada, o token é entregue **somente ao processo do `git push` ou `git fetch` daquele comando**, por variável de ambiente e um helper de credencial que substitui os helpers do usuário naquele comando. O token não aparece na linha de comando, não é gravado em disco e não sai da extensão. A configuração do Git do usuário não muda.
- **Sem a autorização de publicação**, um remoto do GitHub nem é consultado: o Singularity avisa antes de qualquer `fetch` ou `push`. Assim, o Git Credential Manager ou o login de uma CLI não substituem a autorização do Singularity. O `git` roda com `GIT_TERMINAL_PROMPT=0` e `GCM_INTERACTIVE=Never`.
- Para outros remotos, vale a autenticação que o Git já usa na máquina (por exemplo, o Git Credential Manager).

## Testes

- `node --test extensions/singularity-account/test/publish.test.cjs`: 10 testes com **Git real**, repositórios temporários e um remoto bare local: sem upstream, pergunta e publicação, publicação única, commit externo, divergência sem force, falha offline (remoto recusando conexão), e o token só no processo do push.
- `node --test extensions/singularity-account/test/modes.test.cjs`: correspondência de caminhos, incluindo nome curto do Windows.
- `node --test extensions/singularity-account/test/stale-remote.test.cjs`: falha de `fetch` nunca leva a enviar ou perguntar.
- `node --test extensions/singularity-account/test/no-ambient-credentials.test.cjs`: sem autorização nada toca a rede; com ela, o token só vai pelo ambiente de um processo.
- `node scripts/e2e/push-check.cjs --out <pasta> --clone <clone> --exe <exe>`: **push real para um repositório privado de teste**, pela IDE (teclado e mouse reais), com a autorização OAuth do próprio Singularity: manual, assistido ("Agora não" e "Publicar"), automático (commit pela interface Git e por CLI externa), divergência, falha de rede e ausência de autorização. Cada resultado é conferido pelo SHA no GitHub (API), não pela mensagem da interface.
- `node scripts/e2e/publish-check.cjs --dev <repo>`: na IDE real (teclado e clique no botão da página): pergunta no modo assistido, "Publicar" envia exatamente o commit, modo automático envia o commit seguinte sem perguntar (confirmado no log), divergência é avisada e o histórico do remoto é preservado.

## O que não foi testado

- **Repositórios de organizações** e as permissões deles. O push real foi validado num repositório privado de usuário.
- Ausência de rede prolongada. O caso offline foi simulado com um proxy local recusando conexão, só para o repositório de teste.
