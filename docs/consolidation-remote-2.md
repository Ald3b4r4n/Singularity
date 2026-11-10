# Consolidação do Remote 2.0

Três pendências do Remote 2.0, resolvidas sem acrescentar funcionalidade: fins de linha em projetos Windows, a publicação do
Tailscale Serve e a atualização segura da instalação pessoal.

## 1. Fins de linha (Git com `core.autocrlf=true`)

O Git para Windows costuma ser instalado com `core.autocrlf=true`: os arquivos de trabalho ficam em CRLF e os blobs em LF. O Hub
executa o Git sem a configuração global e de sistema da pessoa (hooks, filtros, aliases e credenciais dela não alteram o que o Hub faz).
Isso também escondia a configuração de fim de linha, com três efeitos: um projeto limpo podia parecer modificado, os worktrees não tinham
os mesmos bytes do projeto, e uma solução podia "alterar" arquivos que só tinham sido copiados.

### Regra

- Toda operação Git do Hub recebe a configuração **efetiva** de fim de linha do projeto (`core.autocrlf` e `core.eol`, como o Git da
  pessoa os vê: sistema, global e repositório) e mais nada dessa configuração. Nada é gravado em configuração nenhuma.
- `.gitattributes` é respeitado pelo próprio Git (`text`, `eol=lf`, `eol=crlf`, `-text`).
- Worktrees de comparação e de equipe ficam com **os mesmos bytes** do projeto de origem.

### Preparação da solução

Para cada arquivo cujos bytes diferem entre o projeto e a solução, o Hub pergunta ao Git o que seria armazenado para o conteúdo novo
(um `git add` na área de preparação, com as regras do projeto, incluindo a de nunca converter um arquivo que já tem CRLF no repositório):

| Situação | O que acontece |
|---|---|
| O blob é o mesmo do commit-base | Diferença só de fim de linha: **fica fora da solução**, é listado em `eolOnly` e o projeto mantém seus bytes |
| O conteúdo mudou e o estilo é o mesmo | Alteração normal; o diff da revisão mostra só as linhas alteradas |
| O conteúdo mudou e o estilo também (CRLF → LF, por exemplo) | Aplicado **exatamente como foi escrito**, sem conversão, e sinalizado na revisão (`eolChanged`) |
| Arquivo misto no repositório | Tratado pelos bytes; só as linhas alteradas aparecem no diff |
| Binário ou `-text` | Sempre pelos bytes; nunca convertido |

A árvore e o patch de revisão guardam o que o Git armazenaria; os bytes que serão aplicados continuam sendo os brutos da solução.
Aplicação e rollback não mudaram: são byte a byte, com os originais guardados, sem tocar no índice nem no HEAD.

### O que continua recusado

Projeto realmente modificado (inclusive arquivo não rastreado), HEAD divergente, destino alterado depois da revisão (mesmo que só nos
fins de linha, porque é uma edição concorrente da pessoa), solução alterada depois da revisão, links, colisões de nome.

### Testes (`lineEndings.test.ts`)

Checkout CRLF real com `autocrlf=true` global: adição, remoção, renomeação, arquivo misto, binário com CR LF, `eol=lf`, `-text`,
conversão só de fim de linha, mudança real com troca de estilo, projeto modificado, falha no meio da aplicação e Hub que morre durante a
aplicação (recuperação pelo diário). Em todos, o rollback é comparado byte a byte. Um caso LF confirma que nada mudou para quem não usa
`autocrlf`.

## 2. Tailscale Serve

O Serve é **uma configuração para o computador inteiro**. O comando "Desativar acesso remoto" executava `tailscale serve off` sem
verificar de quem era a publicação; rodado por um gateway de outra pasta de estado (um perfil isolado, um teste), derrubava a publicação
do gateway principal. Foi assim que a publicação do proprietário desapareceu durante um E2E.

- **Desligar**: só quando a publicação aponta para a porta deste gateway. Caso contrário nada é executado.
- **Publicar**: sempre a porta em que o gateway escuta agora, nunca uma lembrada. Uma publicação que não é dele (atual ou anterior) não
  é substituída sem pedido explícito. Depois de publicar, a configuração é relida para confirmar o destino e que não há Funnel.
- **Diagnóstico** (`GET /admin/tailscale`): conectado, nome MagicDNS, porta do gateway, publicação configurada, aponta para cá, porta
  antiga, conflito com outra publicação, Funnel.
- **Na IDE**: "Rede privada do acesso remoto (Tailscale)" mostra o estado real. Ao abrir a IDE com o acesso remoto ligado, se a
  publicação sumiu ou ficou em porta antiga, ela avisa e oferece reativar, com confirmação. Nada é feito em silêncio.
- Comandos usados: `status --json`, `serve status --json`, `serve --bg --https=443 http://127.0.0.1:<porta>` e `serve --https=443 off`.
  Nunca `funnel`, `serve reset`, `up` ou `down`.

## 3. Atualização da instalação pessoal

`scripts/update-personal-install.ps1` troca a pasta de instalação por um pacote novo, com backup e caminho de volta.

- Sem `-Confirm` é só verificação: mostra versão e commit de cada lado e o que está rodando, e não altera nada.
- Recusa se houver janela da IDE aberta ou agente trabalhando. Não fecha janelas nem encerra sessões.
- Faz o backup completo da instalação antes (pasta `backup` ao lado, com versão, commit e data) e confere o commit do backup.
- Para o Hub e o gateway pelos encerramentos deles e os inicia de novo depois.
- Confere o commit da instalação depois da cópia e mostra o comando de volta (`-Rollback <backup> -Confirm`).

O que **não** é tocado, porque não fica na pasta de instalação: configurações e perfil da IDE, sessões e histórico, dispositivos
pareados, workspaces autorizados, registro de envios, logins dos provedores (`%LOCALAPPDATA%\Singularity`, perfil da IDE e pastas de cada
provedor) e a configuração do Tailscale.

Depois da troca o gateway inicia em outra porta; a IDE avisa que a publicação privada ficou em porta antiga e oferece reativá-la.
