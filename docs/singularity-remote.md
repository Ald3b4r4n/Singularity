# Singularity Remote

Acompanhar e controlar os agentes do Singularity Hub pelo Android, no Wi-Fi ou nos dados móveis, sem servidor pago.
O primeiro ciclo é um **cliente de gerenciamento de agentes**, não um espelho da IDE.

```
Android (PWA)  ──HTTPS privado──>  Tailscale Serve  ──>  Gateway 127.0.0.1  ──>  Singularity Hub 127.0.0.1  ──>  OpenCode · Claude Code · Codex CLI
                (rede privada, opcional)                  (processo separado)      (token interno do Hub)
```

## Arquitetura do gateway

- **Processo separado do Hub** (`singularity-hub/dist/remote/main.js`), reaproveitando o cliente do Hub (`HubConnection`). O token
  interno do Hub é lido só dentro dessa conexão e nunca aparece em resposta, log ou arquivo do gateway.
- **Duas portas, as duas em 127.0.0.1**: a *pública* (para o celular, via rede privada) e a *administrativa* (só a IDE). A porta
  administrativa exige um segredo em arquivo legível apenas pelo usuário, recusa qualquer `Origin` (um navegador não a alcança) e
  não existe na porta do celular.
- **Desligado por padrão e sem início automático**: o gateway só roda depois do comando "Ativar acesso remoto" na IDE e confirmação.
  Não há tarefa agendada, chave de inicialização do Windows, porta no roteador nem regra de firewall.
- **API por lista de permissão**: cada rota é escrita explicitamente e chama uma operação do Hub também explícita
  (`sessions.list`, `session.create`, `session.prompt`, `session.interrupt`, `session.history`, `catalog.get`, `comparisons.list`,
  `comparisons.inspect`, `teams.list`, `solutions.list`). Não há shell, acesso a arquivos, método arbitrário, `hub.shutdown`,
  `session.stop`, aplicação/rollback de soluções nem início de equipes. Aplicar e desfazer continuam só na IDE Windows.
- **Workspaces autorizados**: o celular só vê e usa as pastas que o usuário autorizou na IDE; elas aparecem como id opaco e nome,
  nunca como caminho. Sessões de outras pastas ficam invisíveis.
- **Projeção de dados**: respostas passam por campos permitidos; chaves como caminho, worktree, comando, token e segredo são
  removidas dos registros de comparação, equipe e diff.
- **Eventos**: `GET /api/events` (SSE) com reenvio a partir do último `seq`, só de sessões autorizadas. Reconectar apenas lê o
  estado; nenhum prompt é reenviado. Desconectar o celular não interrompe o agente.
- **Sem duplicar tarefas**: todo envio de prompt exige `X-Request-Id`; repetir a mesma requisição depois de uma queda é ignorado
  (`duplicate: true`) e o prompt não chega ao agente duas vezes.
- **Ações explícitas**: criar sessão, enviar e interromper exigem `confirm: true` no corpo (o botão do usuário).

## Pareamento

1. Na IDE: **Singularity: Ativar acesso remoto**, depois **Workspaces do acesso remoto** (autoriza a pasta) e, para usar fora de casa,
   **Rede privada do acesso remoto (Tailscale)**.
2. **Singularity: Parear dispositivo Android** mostra um código de 8 caracteres (alfabeto sem caracteres parecidos, 2 minutos, uso único).
3. No celular, abra o endereço, informe o código e um nome para o aparelho. O celular mostra um **código de verificação**.
4. A IDE mostra o nome do aparelho e o mesmo código de verificação; você confere e autoriza ou recusa.
5. Só então o celular recebe seu token, **uma única vez**. O gateway guarda apenas o hash SHA-256 do token.
6. **Dispositivos pareados** na IDE (ou "Encerrar conexão" no celular) revoga o acesso na hora.

Proteções: tentativas de código limitadas (5 por minuto, depois bloqueio de 60 s, até para o código certo), tokens de 256 bits,
dispositivos que ficam 30 dias sem uso expiram, no máximo 8 dispositivos, validação de `Host` (contra DNS rebinding) e de `Origin`,
sem cookies (o token vai em `Authorization`, então não há CSRF) e CSP estrita no cliente web.

## Rede privada (Tailscale, opcional)

O gateway só escuta em loopback. Para o celular alcançá-lo, a IDE pode executar `tailscale serve --bg --https=443
http://127.0.0.1:<porta>`, que publica **apenas para os seus dispositivos Tailscale**, por HTTPS. O comando só roda depois de
confirmação, e o Tailscale tem de estar instalado e conectado: se não estiver, a IDE explica e **não instala nada**. O Funnel
(internet pública) nunca é usado. O Tailscale depende da infraestrutura de coordenação dele (plano gratuito Personal); outras VPNs
privadas podem ser oferecidas depois. O computador precisa ficar ligado e conectado à rede privada.

## Testes

`cd singularity-hub && npm test` (inclui `remote.test.ts`): loopback, Host e Origin, CSP, pareamento (aprovação, recusa, expiração,
uso único, token entregue uma vez, bloqueio por tentativas), todas as rotas sem token, lista de permissão, workspaces autorizados,
projeção sem caminhos, idempotência do prompt, revogação, eventos com reenvio, superfície administrativa e Tailscale (sem Funnel,
com consentimento).
