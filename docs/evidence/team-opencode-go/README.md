# Modo Equipe — convergência Windows / OpenCode Go

Pacote Windows local, sem publicação de instalador. Os cenários utilizaram somente repositórios sintéticos e nove prompts reais do OpenCode Go:

| Papel | Modelo autenticado | Esforço |
| --- | --- | --- |
| Implementador | `opencode-go/muse-spark-1.3-contributor` | padrão |
| Revisor | `opencode-go/deepseek-v4.1-flash` | padrão |
| Testador | `opencode-go/muse-spark-1.3-contributor` | padrão |

O catálogo confirmou Muse: minimal/low/medium/high/xhigh; DeepSeek: low/high/max. Os papéis usam sessões independentes. Claude Code, Codex CLI, Gemini e outros provedores não receberam inferência neste gate.

## Resultados reais

- Equipe inicial: implementação, revisão e parecer do testador concluídos; teste independente autorizado (`node --test`) com saída 0.
- Defeito controlado: primeira implementação subtraía; DeepSeek solicitou correção com referência ao arquivo real. A segunda versão soma corretamente. O snapshot mudou, a evidência anterior tornou-se obsoleta, e a nova revisão, parecer e teste independente passaram. Um ciclo de dois permitidos.
- Aplicação pela interface: somente `sum.cjs` modificado, índice vazio e HEAD preservado. Rollback pela mesma interface restaurou os bytes originais e árvore limpa. O mecanismo existente de aplicação foi reutilizado.
- Queda: apenas o Hub foi encerrado durante SSE real do implementador. O novo Hub recuperou a mesma sessão; retomada explícita manteve uma única etapa/prompt. Cancelamentos individual e geral concluídos. Zero processos OpenCode/helpers associados ao fixture após encerramento.
- Modelo inexistente recusado antes da inferência; executável indisponível gera catálogo indisponível.
- Dark, Light e alto contraste capturados; layout estreito de 350px coberto pelo teste DOM.

[Dados verificáveis e snapshots](report.json). Capturas: [equipe](equipe-opencode.png), [correção](equipe-correcao.png), [aplicação](equipe-aplicacao.png), [rollback](equipe-rollback.png), [recuperação](equipe-recuperacao.png), [Light](equipe-light.png), [alto contraste](equipe-contraste.png).

Equipes novas registram horário de término persistente, preservado após escolha e reinício do Hub. Históricos anteriores sem esse campo mostram tempo indisponível, sem estimativa retroativa. A abertura dos servidores de cada papel também é feita somente quando sua etapa começa.

## Regressões

13 verificações E2E do pacote e 26 do Browser passaram, incluindo Git, terminal, isolamento e restauração. Cinco testes direcionados de equipe, 21 de comparação/aplicação e os três roteiros DOM (Equipe, Comparação, Solução) passaram. Foram preservados os resultados anteriores de 121 testes do Hub e 37 verificações da extensão; não representam inferência Claude/Codex.

## Reprodução e limites

Execute `node scripts/e2e/team-opencode.cjs <exe-Windows> <novo-diretório-sintético>` com a instalação OpenCode 2.x e autenticação Go existentes. O script recusa ausência dos dois modelos obrigatórios; não faz fallback gratuito nem executa outra CLI de inferência. `SINGULARITY_TEAM_CATALOG_ONLY=1` consulta apenas o catálogo.

O perfil pessoal apresentou HTTP 503 (`Location plugins did not finish activating`). Foi usada uma cópia isolada da configuração, desabilitando apenas a lista de plugins nessa cópia; os demais valores, inclusive privacidade/região, foram preservados. O OpenCode usou sua autenticação existente, sem exibir credenciais, criar novas chaves ou mudar o perfil original.

O roteiro foi retomado por checkpoints para ajustes das asserções, espera do cancelamento assíncrono e capturas. Nenhum desses ajustes repetiu prompts concluídos. Flags de retomada exigem o fixture e seu histórico reais. A recuperação foi comprovada durante implementação OpenCode; não equivale a sobreviver execuções Claude/Codex nem a retomar automaticamente qualquer fronteira interrompida.

As opiniões dos agentes permanecem distintas de testes independentes. O limite de dois ciclos e demais fronteiras de falha também têm cobertura determinística; isso não representa inferência real adicional. Não houve nova contratação, alteração de região/privacidade, merge automático ou commit no workspace sintético.
