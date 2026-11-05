# Estabilização operacional de provedores — Windows

Baseline: `8052bd0b78bb04609beaa011031f5cfb6b059215`. Relatório verificável: [operational.json](operational.json).

## Causa do 503

OpenCode **2.2.5** reproduziu no perfil pessoal `HTTP 503 / ServiceUnavailableError / Location plugins did not finish activating`, também pela CLI oficial em servidor privado. A fase de ativação foi identificada; **o plugin ou a dependência exata permanece indeterminado**. A API oficial `plugin.list` não informou plugins de servidor registrados naquela localização com falha. Não atribuímos o erro a uma conta, cota ou plugin específico sem evidência. [Sondagem inicial](diagnosis.json).

O Hub distingue essa assinatura exata de 503 genérico, 401/403 da conexão HTTP local, 429, inicialização e catálogo indisponível. Só campos permitidos e mensagens fixas saem do Hub. Corpos arbitrários, caminhos, tokens, prompts e identificadores de credenciais não são enviados à interface. Consultas simultâneas compartilham a sondagem; falhas também têm cache limitado, e uma nova tentativa exige ação explícita. Não há loop automático de reparação.

## Recuperação pela interface

**Gerenciar provedores** mostra versão, autenticação, catálogo, condição e recomendação. Oferece Diagnosticar, Testar novamente, Instalação e conta, configuração isolada confirmada em modal e retorno ao perfil normal. Catálogo disponível, conexão configurada e acesso efetivo ao modelo são estados diferentes.

A escolha isolada usa somente a sobreposição oficial de processo `OPENCODE_CONFIG_CONTENT` com `plugins: ["-*", "opencode.*"]`. Não cria uma cópia do perfil, não copia credenciais, não altera os arquivos originais e não substitui privacidade/região. Plugins fora do namespace nativo são filtrados; recursos fornecidos por eles podem ficar indisponíveis. Os plugins nativos e a política administrada permanecem. [Verificação sem inferência](profile-overlay.json).

A escolha vale para novas sessões daquele workspace e seus worktrees de comparação/equipe. Sessões existentes não mudam de perfil. O registro DPAPI e o histórico preservam a identificação de sessões isoladas recuperadas. Um novo Hub usa o perfil normal para novas sessões; uma equipe pausada pode revalidar explicitamente a escolha antes de retomar. Nenhum prompt é reiniciado.

O isolamento é recusado quando já existe configuração inline, quando o catálogo/configuração não pode ser confirmado ou quando falta conexão oficial registrada. Neste ciclo, a validação de conexão para execução isolada reconhece as integrações OpenCode e OpenCode Go com credencial registrada. Os demais mecanismos e declarações de autenticação por variável de ambiente, isoladamente, permanecem não verificados; nenhuma chave é lida para contornar isso. A sondagem ainda informa catálogo/conexão e o perfil que permaneceu ativo. Credencial configurada não garante assinatura ou acesso ao modelo; recusas reais continuam sendo erros.

## E2E real deste gate

- Perfil pessoal: diagnóstico correto, cancelamento da confirmação sem troca de perfil, nova tentativa limitada e reutilização da sondagem em leituras repetidas.
- Escolha isolada pela interface, catálogo Go e os dois modelos autorizados confirmados. **Uma única tarefa real** usou `opencode-go/muse-spark-1.3-contributor`, esforço padrão, em repositório sintético. DeepSeek Go foi confirmado no catálogo, sem nova inferência.
- Somente `sum.cjs` mudou; asserção independente com saída 0; HEAD e índice preservados. O fixture voltou aos bytes iniciais e árvore limpa.
- Retorno explícito ao perfil normal preservou a sessão isolada existente. Após queda somente do Hub, a mesma sessão/helper concluído foi recuperada, com um único turno no histórico. Interrupção e encerramento do helper recuperado concluídos; zero processos OpenCode/helpers do fixture após o encerramento.
- Arquivos JSON/JSONC globais e arquivos diretos dos plugins globais foram comparados por SHA-256 e mtime antes/depois, sem alterações. Credenciais não foram copiadas nem exibidas. O produto não escreve no perfil pessoal para contornar a falha.
- Capturas reais: [diagnóstico normal](diagnostico-normal.png), [modo isolado](configuracao-isolada.png), [Light](diagnostico-light.png), [alto contraste](diagnostico-contraste.png), [sessão identificada e modelo preservado](agente-isolado.png), [retorno normal](retorno-normal.png).

## Regressões e reprodução

125 testes da suíte completa do Hub passaram. Após os ajustes finais, 14 testes direcionados de diagnóstico/política/RPC e a verificação da origem canônica dos três papéis passaram. Também passaram 37 verificações da extensão, quatro roteiros DOM, 13 verificações do pacote (Git, terminal, sessões e reabertura) e 26 do Browser local. As contagens direcionadas se sobrepõem à suíte completa.

Modo Equipe, correção com invalidação de snapshot, testes independentes, comparação e aplicação/rollback foram revalidados por fixtures locais reais de Git/processos e contratos de interface. Não repetimos a inferência de três papéis já comprovada no [gate anterior](../team-opencode-go/README.md). 429, 503 genérico, autenticação ausente/não verificável e recusas de escolha são cenários determinísticos; o 503 de plugins, catálogo isolado, tarefa Go e recuperação descritos acima são reais.

Roteiro: `node scripts/e2e/provider-stability.cjs <exe-Windows> <novo-fixture-sintético>`. Requer a instalação e a conexão Go existentes; não pede novas chaves. `SINGULARITY_STABILITY_CAPTURE_ONLY=1` refaz somente a inspeção/captura do fixture concluído, sem inferência. O roteiro legado que selecionava modelo gratuito foi interrompido durante a inicialização, antes de criar sessão ou enviar prompt. Claude Code e Codex foram desativados **somente no ambiente E2E** por sentinelas de executável; seus adapters permanecem disponíveis no produto e foram testados com contratos/fixtures locais. Nenhuma assinatura dessas CLIs foi consumida.

Fontes oficiais: [plugins e filtros](https://opencode.ai/v2/docs/plugins/), [API v2](https://opencode.ai/v2/docs/api), [sobreposições de configuração](https://docs.dev.opencode.ai/docs/config/). O pacote local utilizou o runtime Windows aprovado com Hub compilado e extensão atualizados. Não houve publicação de instalador ou release.
