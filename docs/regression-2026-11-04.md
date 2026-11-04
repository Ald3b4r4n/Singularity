# Regressão direcionada — recuperação e histórico

Data: 2026-11-04. Base: `57b0da088fdc48bbe53b1bc2d82a5d81c83c67f2`. Todos os dados e workspaces usados nos roteiros são sintéticos.

## Recuperação após falha do Hub

- `opencode-recovery.cjs`: aprovado com OpenCode `beam-free`; a sessão original foi recuperada após `SIGKILL`, o SSE foi retomado e o Job Object ficou vazio após o encerramento.
- `opencode-recovery-guardrails.cjs`: helper ausente, credencial Basic incorreta e registro DPAPI adulterado foram rejeitados como `unrecoverable`; nenhum prompt foi aceito e nenhuma execução duplicada ocorreu. O Job original foi encerrado na limpeza.
- Uma execução do catálogo OpenCode respondeu temporariamente HTTP 503; a repetição integral passou. Nenhuma correção de produto foi atribuída a essa instabilidade.

## Histórico e múltiplas sessões

- O teste automatizado cria 25 turnos com resultados de aproximadamente 12 KiB, confirma a retenção exata dos últimos 20 turnos, a recarga protegida por DPAPI, a leitura e a exclusão.
- `opencode-history.cjs`: três sessões reais, dois clientes, quatro prompts, isolamento de workspace, histórico após reinício e exclusão aprovados.
- O roteiro também aceita `SINGULARITY_E2E_DEV` para validar duas janelas reais contra o código do worktree, sem depender de um pacote antigo.

## Workbench e regressões

- Hub: 66 testes em 13 suítes.
- Agentes: 26 verificações automatizadas e E2E real com streaming, cancelamento, persistência, Dark, Light e alto contraste.
- Conta GitHub: 12 testes OAuth, 5 testes de estado e E2E sem iniciar uma autorização real. O roteiro anterior estava desatualizado: a build já contém o client ID OAuth público oficial.
- Núcleo, Browser e Agentes: edição em disco, Explorer, terminal Git, Source Control, comandos, extensões, Browser, Hub, encerramento e reabertura exercitados em perfis isolados.

As correções desta task são de cobertura e robustez dos roteiros: foco explícito do editor, restauração por presença da aba, encerramento do Hub isolado antes da remoção do perfil e canonicalização de diretórios temporários. Nenhuma funcionalidade aprovada de recuperação ou histórico foi reimplementada.

## Pendência fora do escopo

O roteiro estendido `agents-check.cjs` conclui streaming, segunda tarefa, cancelamento, reabertura, temas e arquivamento, mas falha depois ao manipular a aba Agentes entre grupos de editores. Essa falha preexistente não foi alterada nem contada como aprovação do roteiro completo. Os cenários de Browser, terminal e Git também foram validados separadamente pelos roteiros próprios e pelo E2E do núcleo.
