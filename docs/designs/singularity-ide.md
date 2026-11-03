# Singularity IDE: Arquitetura Inicial

*   **Author:** Ald3b4r4n
*   **Status:** Proposed
*   **Date:** 2026-11-02

--------------------------------------------------------------------------------

## Overview

Singularity IDE é um fork do Code - OSS para Windows 11, com identidade visual própria e uma central multiagente. O código original do projeto usa licença MIT. As licenças, atribuições e avisos dos componentes de terceiros são preservados.

O núcleo do editor (Monaco, depuração, terminal, Git e a API de extensões) não é reescrito. A personalização fica em módulos próprios, para que atualizar o upstream custe pouco. A central multiagente é um processo separado (o hub) que lança as CLIs de agentes que o dono já usa e mostra seus logs e resultados dentro da IDE.

O projeto é público desde o primeiro commit, não tem orçamento (R$0) e é mantido por uma pessoa com ajuda de agentes de IA. O processo é Elephant-Goldfish Model com vibe coding, sem limites artificiais de features ou tasks.

Este documento cobre a arquitetura do fork, o isolamento do hub, a estratégia de sincronização com o upstream e o caminho até a primeira compilação funcional no Windows.

## The Problem

Hoje o dono usa vários agentes de código por assinatura (Claude Code, Codex, OpenCode e outros), cada um em seu terminal e com sua própria interface. Não existe um lugar único para iniciar, acompanhar e comparar essas sessões ao lado do editor.

As alternativas disponíveis não resolvem isso por completo:

*   **Uma extensão do VS Code** só pode mexer no que a API de extensões expõe. Não alcança o layout, os menus e a identidade do workbench.
*   **O VS Code da Microsoft** é um binário proprietário, com marca, telemetria e Marketplace próprios. Um fork não pode usar o Visual Studio Marketplace pelos termos de uso dele.
*   **Um editor novo** sobre Monaco perderia depuração, terminal, Git e compatibilidade com extensões, o que custa meses de trabalho.

A solução proposta é um fork do Code - OSS com patches mínimos no núcleo, um catálogo de extensões baseado no Open VSX e um hub multiagente que roda fora do processo da IDE. A IDE é cliente do hub.

Dois riscos moldam o design e não podem ser ignorados:

*   **Custo de sync.** Cada release do upstream pode conflitar com as mudanças do fork. Quanto mais arquivos do upstream o fork tocar, mais caro fica o sync.
*   **Termos dos provedores.** Orquestrar CLIs de assinatura só é aceitável se o hub usar a CLI oficial como o usuário usaria, sem tocar em credenciais.

## Goals

A primeira versão (v0) roda a partir do fonte, na máquina do dono, e precisa demonstrar:

1.  **Build:** o fork do Code - OSS compila e executa no Windows 11 sem alterações funcionais.
2.  **Identidade:** nome, ícones, tema e tela de boas-vindas do Singularity aparecem, e a pasta de dados e os identificadores do produto são diferentes dos do VS Code e do Code - OSS.
3.  **Editor, terminal e Git:** abrir um projeto, editar um arquivo, usar o terminal integrado e executar operações Git funcionam como no upstream.
4.  **Hub:** um daemon destacado, uma instância por usuário, em 127.0.0.1, controla sessões de agente e sobrevive ao fechamento da IDE. O primeiro adapter, o do OpenCode, lança a CLI já instalada e logada pelo usuário.
5.  **Visibilidade do agente:** um painel na IDE mostra o log da sessão em streaming, os arquivos alterados e o diff, e tem um botão que encerra o agente e seus processos filhos.
6.  **Extensões:** é possível instalar uma extensão pelo Open VSX e outra por VSIX local.
7.  **Isolamento medido:** toda edição em arquivo do upstream fica registrada em `UPSTREAM-TOUCHPOINTS.md`.

Critério de aceite do item 5: o dono dispara um prompt num projeto de teste, vê o log chegando, vê o diff ao final e consegue parar a sessão.

## Non-Goals

*   Reescrever Monaco, o depurador ou o extension host.
*   Implementar todos os provedores. Um adapter basta no v0.
*   Acesso remoto pelo celular, editor remoto e marketplace próprio.
*   Gerenciador central de MCPs, skills e plugins com escrita.
*   Integrar Antares e Capella. Não fazem parte dos 7 itens do v0. A forma de integração (extensões comuns, em pacotes separados) está nas Open Questions.
*   Comparação lado a lado, colaboração entre agentes e worktrees automáticos.
*   Instalador assinado, auto-update e CI obrigatório.
*   Suporte a Linux e macOS.
*   Resolver o sync com o upstream de forma 100% automática.

## Open Questions

*   **Interfaces e termos do OpenCode:** quais interfaces oficiais de integração e de gerenciamento de sessões existem (por exemplo, um modo servidor ou um protocolo estruturado, citados de memória e **não verificados**), como a autenticação nativa funciona, e o que os termos aplicáveis dizem sobre uso programático, inclusive nos planos Go e Zen. Verificar na documentação antes de escrever o adapter.
*   **Estado do upstream na tag escolhida:** campos reais do `product.json`, build empacotado e presença de código de chat/Copilot/MCP embutido. Nada disso foi verificado. Confirmar no código da tag antes de depender.
*   **Escopo das aprovações:** o que "aprovar/rejeitar" controla (repasse do prompt da CLI ou política do hub). No v0, "aprovações não suportadas" é um estado válido do contrato.
*   **Antares e Capella:** como entram (built-in, pré-instaladas ou só no Open VSX) e sob qual licença.
*   **Licenças de terceiros:** a lista completa de avisos exigidos num binário público (Electron, Chromium, ffmpeg, assets com atribuição) e a compatibilidade com a licença MIT do código original não foram verificadas. Conferir no código e nos avisos da tag escolhida antes de qualquer release.
*   **Nome:** o nome "Singularity" pode colidir com o Apptainer, antes chamado Singularity. Fazer a busca de colisão antes de qualquer release público. Não verificado.
*   **Ambiente:** disco livre e RAM da máquina e um caminho de clone sem espaços. O caminho atual da pasta do projeto tem espaço e pode quebrar ferramentas de build.

**Decidido pelo dono em 2026-11-02:**

*   O transporte inicial do daemon é WebSocket com JSON em 127.0.0.1, com autenticação obrigatória.
*   O primeiro adapter é o OpenCode, priorizando suas interfaces oficiais de integração e a autenticação nativa. Sem acesso, cópia, interceptação ou reuso de tokens e credenciais de outros serviços. O adapter deve demonstrar execução, streaming de eventos, acompanhamento de sessão, diff quando aplicável e encerramento seguro.
*   O `product.json` pode ser editado diretamente no v0, com cada alteração registrada em `UPSTREAM-TOUCHPOINTS.md`. Se a tag oferecer um mecanismo de override adequado, ele pode ser usado para reduzir touchpoints. Isso não bloqueia o desenvolvimento.
*   O hub é um daemon destacado, com uma instância por usuário, que sobrevive ao fechamento da IDE. Não é serviço do Windows e não inicia no login no v0. Verificação de versão e de protocolo na reconexão, encerramento explícito com tratamento das sessões e recuperação de processos abandonados fazem parte do v0. Esta decisão substitui a ideia anterior de processo filho da IDE.
*   A base do fork é o Code - OSS diretamente. O VSCodium serve como referência técnica (branding, telemetria, Open VSX, scripts de build). Mudar a base exige justificativa e aprovação.
*   O método de sync é a Opção A (merge de tags num fork real). Detalhes e condições na seção Technical Plan.

## Critical User Journeys (CUJs)

### CUJ 1: Compilar e abrir o Singularity

*   **Given**: Windows 11 com o toolchain instalado e o repositório clonado em caminho sem espaços.
*   **When**: O dono executa a instalação de dependências, compila e inicia o fork.
*   **Then**: A janela abre com a identidade Singularity. Abrir uma pasta, editar um arquivo, usar o terminal e rodar `git status` funcionam.

### CUJ 2: Rodar um agente e ver o resultado

*   **Given**: A IDE aberta num projeto Git de teste e uma CLI de agente instalada e logada fora da IDE.
*   **When**: O dono envia um prompt pelo painel do hub.
*   **Then**: O log chega em streaming, os arquivos alterados e o diff aparecem ao final, e o botão de parar encerra o agente e seus processos filhos.

### CUJ 3: Instalar uma extensão

*   **Given**: A IDE configurada com o Open VSX como gallery.
*   **When**: O dono instala uma extensão pela view de extensões e outra a partir de um arquivo VSIX.
*   **Then**: As duas extensões ativam e funcionam, e a gallery não faz chamadas ao Visual Studio Marketplace.

### CUJ 4: Sincronizar com uma nova tag do upstream

*   **Given**: O fork baseado numa tag estável e `UPSTREAM-TOUCHPOINTS.md` atualizado.
*   **When**: O dono incorpora a próxima tag estável do upstream.
*   **Then**: Os conflitos aparecem só nos arquivos listados em `UPSTREAM-TOUCHPOINTS.md`. Depois de resolvê-los, o fork compila e abre.

### CUJ 5: Fechar e reabrir a IDE com um agente rodando

*   **Given**: Uma sessão de agente em execução, iniciada pelo painel Agents.
*   **When**: O dono fecha a janela da IDE e a abre de novo.
*   **Then**: O agente continua rodando durante o intervalo. Ao reabrir, a IDE encontra o hub, autentica-se, confere a versão do protocolo e mostra a sessão com o log desde o último evento que tinha visto. Se as versões forem incompatíveis, a IDE recusa a conexão e avisa.

## Technical Plan (Architecture)

Nomes de arquivos e diretórios do upstream citados abaixo (`product.json`, `src/vs/workbench/contrib/`, `extensions/`, `.nvmrc`, `scripts/code.bat`) vêm do conhecimento geral sobre o repositório e **precisam ser verificados na tag escolhida** antes de qualquer dependência. Nomes de campos do `product.json` não são listados aqui por esse motivo. Os arquivos e diretórios marcados como "novo" são nossos.

### Visão geral

O sistema tem três partes: o fork do Code - OSS, o hub (um processo separado) e as CLIs de agentes que o usuário já tem instaladas.

```text
 ┌───────────────── Singularity IDE (fork do Code - OSS) ─────────────────┐
 │  Núcleo upstream: Monaco, terminal, Git, depurador, extension host     │
 │  Camada fina nossa: overlay de produto, tema, ícones, poucos hooks     │
 │  Built-in extension "singularity-hub" (painel Agents, webview)         │
 └───────────────────────────┬────────────────────────────────────────────┘
                             │ WebSocket, 127.0.0.1, token por instalação
                 ┌───────────▼────────────┐
                 │  Hub (daemon Node/TS)  │  sessões, log de eventos, diff,
                 │  sem imports do VS Code│  registry de adapters
                 └───────────┬────────────┘
                             │ lança como processo filho, nunca lê token
        ┌────────────────────┼────────────────────┐
   ┌────▼─────┐         ┌────▼─────┐         ┌────▼─────┐
   │ adapter  │         │ adapter  │         │ adapter  │
   │ (v0: 1)  │         │ (futuro) │         │ (futuro) │
   └────┬─────┘         └──────────┘         └──────────┘
        │ CLI oficial do agente, já instalada e logada pelo usuário
```

### Camadas de customização

Por ordem de custo de sync, da mais barata para a mais cara. Subir de camada só quando a anterior não alcança:

1.  **Código aditivo nosso**, em diretórios que o upstream não tem: um diretório próprio dentro de `src/vs/workbench/contrib/` (novo) e as built-in extensions `extensions/singularity-*` (novo). Não gera conflito de merge, só precisa de registro em poucos pontos.
2.  **Configuração e aparência:** overlay do `product.json`, tema, ícones, CSS e valores padrão de configurações.
3.  **Edição em arquivo do upstream.** É o último recurso, e cada arquivo tocado entra em `UPSTREAM-TOUCHPOINTS.md` com uma linha de motivo. Uma edição de uma linha que registra nosso módulo é preferível a uma cópia do arquivo.

A substituição de partes do layout (barras, painéis, navegação) fica de fora do v0. Quando for feita, cada parte substituída fica atrás de uma configuração, para que um sync problemático degrade para a UI original em vez de quebrar a compilação.

**Edições de core no v0:** a lista de edições em arquivos do upstream que o v0 exige é o próprio `UPSTREAM-TOUCHPOINTS.md`. Se ela ficar curta, o fork profundo do workbench espera.

**Compatibilidade com extensões:** extensões que rodam no Code - OSS sem modificações devem continuar funcionando. A UI pode mudar, mas os pontos de contribuição que as extensões usam continuam honrados.

### Sincronização com o upstream (decisão do dono: Opção A)

O repositório é um fork real do Code - OSS. Regras aprovadas:

1.  O histórico completo do Code - OSS é mantido e o remote `upstream` fica configurado.
2.  Customizações ficam preferencialmente em módulos e diretórios próprios.
3.  Toda alteração em arquivo original é registrada em `UPSTREAM-TOUCHPOINTS.md`.
4.  `git rerere` está ativo para reaproveitar resoluções de conflito. O resultado de cada resolução é sempre conferido.
5.  A versão do upstream é fixada por tag e commit identificados, registrados num arquivo do repositório (`docs/upstream-sync.md`, novo).
6.  Antes de incorporar uma tag nova à branch estável, o merge acontece numa branch de teste. O build e as funcionalidades essenciais (abrir, editar, terminal, Git, painel do hub, instalar extensão) são validados lá.
7.  Os commits próprios são claros e separados por mudança funcional, sem estrutura rígida de tasks.
8.  Não há atualização automática a cada release. Cada tag nova é avaliada antes.

Em cada sync, `docs/upstream-sync.md` registra a tag de origem, a tag de destino, o número de arquivos em conflito e o tempo gasto. Esses números são a base para reavaliar o método. Se os ensaios mostrarem conflitos recorrentes nos mesmos arquivos e custo alto de manutenção, o dono pode reavaliar a Opção C (pilha de commits recolocada por tag). A Opção A não é uma restrição permanente.

A cadência inicial é: sempre uma tag estável, nunca `main`, e cada release é avaliada antes de ser incorporada. Não há intervalo fixo. O brief sugeria algo entre 2 e 3 meses como ponto de partida, e o dono pode ajustar conforme os dados dos primeiros merges. Atualizações de segurança do Electron e do Chromium são avaliadas à parte, já que a tag fixada pode ficar para trás.

### Hub

O hub é um daemon Node/TypeScript separado da IDE. Ele não importa nada do VS Code, para que possa ser usado também por outros clientes (CLI e, no futuro, o Android). A IDE pode iniciá-lo quando necessário, mas ele é um processo destacado: não depende do ciclo de vida da janela nem do extension host.

**Ciclo de vida** (decisão do dono, definitiva para o v0):

*   **Início.** Se não houver um hub vivo, a extensão da IDE lança o daemon como processo destacado, sem herdar a saída da IDE. Fechar a IDE não encerra o daemon nem os agentes em execução.
*   **Uma instância por usuário.** O daemon segura um recurso exclusivo do usuário (um named pipe com nome fixo por usuário, a validar). Uma segunda instância não consegue assumi-lo e sai. O arquivo de informações (porta, token, PID com horário de criação, versão do hub e versão do protocolo) só é escrito depois de obter o recurso. Um arquivo antigo cujo processo não existe mais é tratado como obsoleto e substituído.
*   **Reconexão.** Ao abrir, a IDE detecta o hub vivo, autentica-se e pede as sessões existentes, com o log a partir do último evento que ela viu. Na conexão, cliente e hub trocam a versão do protocolo e a versão do hub. Se forem incompatíveis, a conexão é recusada e a IDE avisa o usuário e oferece encerrar o hub. Componentes incompatíveis nunca se conectam em silêncio.
*   **Encerramento explícito.** Existe um comando para encerrar o hub. O hub nunca encerra sozinho enquanto houver sessões em execução, e fechar a IDE nunca o aciona. Se houver sessões, o usuário escolhe entre aguardar o fim delas, parar todas e sair, ou cancelar. O padrão é cancelar.
*   **Processos abandonados.** Ao iniciar, o hub lê os registros de sessão em disco. Sessões marcadas como em execução cujo processo raiz não existe mais (PID e horário não batem) são marcadas como encerradas de forma inesperada, e os recursos temporários são limpos. Processos de agentes que continuam vivos depois de uma queda do hub não podem ser reanexados. Eles aparecem como órfãos, e o usuário decide encerrá-los, com a verificação por PID e horário.
*   **O que não existe no v0.** O daemon não é instalado como serviço do Windows e não inicia no login. A persistência exigida é durante o fechamento e a reabertura da IDE, não depois de reiniciar o Windows.

**Sessão.** Uma sessão é um processo de agente lançado pelo hub, com diretório de trabalho, adapter, perfil de autenticação e um log de eventos append-only em disco.

**Protocolo.** WebSocket em 127.0.0.1 com mensagens JSON versionadas. Comandos: iniciar sessão, enviar entrada, parar sessão, consultar sessão. Eventos: log, mensagem do agente, arquivo alterado, pedido de aprovação, fim e erro.

**Autenticação e proteção de conexão** (mesmo em loopback, pensando no remoto futuro):

*   O daemon só escuta em 127.0.0.1, nunca em 0.0.0.0.
*   No primeiro start, gera um token aleatório e o grava num arquivo do perfil do usuário, com permissão restrita a esse usuário (ACL do Windows). A porta efêmera vai no mesmo arquivo.
*   Toda conexão precisa apresentar o token, enviado em cabeçalho ou na primeira mensagem, nunca na URL.
*   O daemon valida os cabeçalhos `Host` e `Origin` e rejeita origens que não sejam clientes conhecidos. Isso impede que uma página web aberta no navegador fale com o daemon local ou o ataque por reassociação de DNS.
*   Conexões sem token válido são fechadas e registradas no log.
*   Para o acesso remoto futuro, o mesmo mecanismo se estende com token por dispositivo revogável e TLS, sem mudar o protocolo de sessão.

**Encerrar uma sessão.** O hub registra o PID do processo raiz da sessão e o horário de criação dele. Ao parar, confere que o PID ainda é o mesmo processo (o horário bate) e só então encerra essa raiz e seus descendentes (`taskkill /PID <raiz> /T`). Nenhum outro processo do usuário é tocado, e um PID reaproveitado pelo sistema não é morto por engano.

**Diff.** Antes de iniciar a sessão, o hub registra um snapshot da árvore de trabalho usando um índice Git temporário, sem alterar o índice do usuário. Ao final (ou ao parar), registra outro snapshot e compara. O diff só é mostrado quando há alterações de arquivos. Em pastas que não são repositório Git, o painel mostra apenas a lista de arquivos alterados quando houver como determiná-la.

### Adapters e contrato com os provedores

Um adapter traduz uma CLI de agente para a interface do hub. Interface mínima (pseudocódigo):

```text
Adapter {
  id, harness, authMode            // authMode: vendor-cli-login | api-key | none
  detect()        -> { instalado, versão }
  authStatus()    -> { logado, perfil }
  startSession(opts: { cwd, prompt, env }) -> Session
  send(session, text)
  stop(session)
  events(session) -> stream de eventos
  capabilities    // aprovações, streaming estruturado, etc. Estado "aprovações não suportadas" é válido no v0.
}
```

Regras do contrato:

*   O hub lança a CLI oficial instalada pelo usuário e o login é feito na própria CLI. O hub nunca lê, copia, guarda nem repassa token ou credencial.
*   Modo com chave de API é separado e explícito. A chave fica no Gerenciador de Credenciais do Windows, nunca em arquivo de configuração do projeto.
*   A UI mostra qual modo de autenticação cada sessão usa, porque assinatura e créditos de API não são a mesma coisa.
*   Cada adapter tem uma nota `docs/adapters/<nome>.md` (novo) com os termos do provedor lidos e a data da leitura.
*   Harness e provedor são modelados separadamente. GLM Coding Plan, OpenCode Go/Zen e Antigravity não são harnesses do mesmo tipo e não ganham adapter só pelo nome.
*   O contrato comum é extraído depois do segundo adapter. O primeiro adapter é escrito sem tentar generalizar.
*   O primeiro adapter é o do OpenCode. Ele prioriza as interfaces oficiais de integração e de gerenciamento de sessões do OpenCode e a autenticação nativa dele. Quais interfaces existem e o que os termos permitem é verificado na documentação antes da implementação (ver Open Questions).
*   Preferência por modos estruturados e sancionados de cada CLI. Quando só existir terminal interativo (PTY), o adapter funciona, mas não oferece aprovações.

### Cliente na IDE

A built-in extension `extensions/singularity-hub` (novo) contribui um view container "Agents" com um painel em webview. O painel lista sessões, mostra o log em streaming, os arquivos alterados, o diff (quando houver) e o botão de parar. A extensão fala com o hub pelo protocolo acima e não implementa lógica de agente.

### Identidade e distribuição

*   Um overlay do `product.json` define nome, identificadores do produto, protocolo de URL, pasta de dados e identificadores do instalador. Todos devem ser diferentes dos do VS Code e do Code - OSS, para não colidir com instalações existentes. Os campos exatos são conferidos na tag escolhida, usando o VSCodium como referência.
*   A gallery de extensões aponta para o Open VSX. Os endpoints de telemetria e de atualização da Microsoft são removidos ou deixados vazios. Após o primeiro build, uma busca por endpoints externos confirma que nada ficou para trás.
*   Extensões da Microsoft que dependem do Marketplace deles (Pylance, C# Dev Kit, Remote-*, Live Share) não funcionam. Isso é documentado, com alternativas.
*   Instalação por VSIX local é mantida. VSIX baixado só vale se for publicado pelo próprio autor.

### Licenciamento

*   O código original do Singularity usa MIT.
*   Mantém-se o `LICENSE` do upstream, o copyright da Microsoft e o `ThirdPartyNotices` do upstream. O build público também carrega os avisos de Electron, Chromium e ffmpeg, e a atribuição dos assets CC-BY, como os codicons.
*   Antes de publicar um binário, verificar marca, nome, ícones e as licenças de Antares e Capella.

### Pontos a validar durante a implementação

Observações do dono. São verificações dentro do trabalho normal, sem etapas ou documentos próprios, e não mudam as decisões acima:

*   **Job Objects do Windows:** avaliar seu uso para agrupar e encerrar os processos de cada sessão. O PID raiz com horário de criação continua como verificação complementar.
*   **Snapshots e diff:** o mecanismo deve preservar alterações que o usuário já tinha e não atribuir ao agente mudanças feitas ao mesmo tempo por outra pessoa ou processo na mesma pasta. Para sessões em paralelo, considerar Git worktrees isoladas.
*   **Acesso remoto futuro:** o daemon continua em 127.0.0.1 com WebSocket e autenticação obrigatória. Para o Android, avaliar um gateway privado, como o Tailscale Serve, sem expor o daemon diretamente.
*   **Daemon destacado no Windows:** confirmar que o processo lançado pela extensão realmente sobrevive ao fechamento da janela e do extension host (por exemplo, se o processo da IDE o agrupa num objeto de job que o encerra), e que o recurso exclusivo de instância funciona como previsto.

### Caminho até o primeiro build no Windows

A ordem abaixo é sugerida, não obrigatória, e pode ser adaptada. O primeiro passo não depende de nenhuma decisão aberta:

1.  **Ambiente:** clonar em caminho sem espaços. Instalar o Node da versão indicada em `.nvmrc` da tag, o Python 3, o Git e o Visual Studio 2022 Build Tools com C++, as bibliotecas Spectre, ATL e o Windows SDK. Ativar long paths. Reservar espaço em disco e RAM suficientes, medindo o consumo real no primeiro build.
2.  **Build sem alterações:** `npm install`, compilar e rodar com o script de desenvolvimento do repositório (`scripts/code.bat`, a confirmar). Cronometrar. Este passo é o maior desconhecido técnico.
3.  **Identidade e Open VSX:** overlay do `product.json`, tema, ícones, tela de boas-vindas, gallery.
4.  **Hub e adapter:** daemon, autenticação, um adapter, rodando por script antes de existir UI.
5.  **Painel Agents:** a built-in extension com log, diff e botão de parar.
6.  **Build empacotado ou portátil**, sem assinatura, testado em perfil limpo para confirmar que o produto não depende da árvore de desenvolvimento, e um ensaio de sync com a tag seguinte do upstream. O uso do v0 continua sendo a partir do fonte, na máquina do dono.

## Alternatives Considered

### Alternativa A: apenas uma extensão sobre VS Code ou VSCodium

*   **Pros**: Custo mínimo, sem fork e sem sync. Um v0 mínimo sai rápido.
*   **Cons**: A API de extensões não alcança layout, menus e identidade do workbench. O produto continuaria sendo "o VS Code com uma extensão".
*   **Reason for Rejection**: Não entrega a IDE independente que o dono quer. O hub é construído como built-in extension de qualquer forma, e o fork entra onde a extensão não alcança.

### Alternativa B: aplicativo Electron próprio embutindo Monaco

*   **Pros**: Controle total da interface, sem sync com o upstream.
*   **Cons**: Perde depuração, terminal integrado, Git, extension host e compatibilidade com extensões. Recriar isso custa meses.
*   **Reason for Rejection**: É o maior estouro de escopo possível e quebra o objetivo de compatibilidade máxima com o ecossistema.

### Alternativa C: Theia

*   **Pros**: Arquitetura pensada para IDEs customizadas, com licença aberta.
*   **Cons**: A compatibilidade com extensões do VS Code é parcial (não verificado), o ecossistema é menor e é outra base de código para aprender e manter.
*   **Reason for Rejection**: O dono quer a base e a experiência do Code - OSS. Sem ganho comprovado que compense a troca.

### Alternativa D: fork baseado no VSCodium

*   **Pros**: Já remove marca e telemetria da Microsoft, usa o Open VSX e traz scripts de build prontos.
*   **Cons**: Adiciona uma camada intermediária que também precisa ser acompanhada. Mudanças dele chegam antes de chegarem ao nosso fork.
*   **Reason for Rejection**: Decisão do dono: a base é o Code - OSS diretamente. O VSCodium fica como referência técnica. Mudar a base exige justificativa e aprovação.

### Alternativa E: patch queue sobre tag fixada (Opção B do sync)

*   **Pros**: Repositório pequeno, footprint visível e licença do que é nosso separada da do upstream.
*   **Cons**: Edição diária do core fica mais frágil, pois exige regenerar patches. Patches que não aplicam na tag nova bloqueiam o build. Ferramentas que esperam o fonte completo precisam de ajuste.
*   **Reason for Rejection**: O dono escolheu o merge de tags num fork real, que facilita a contribuição open source e a edição direta.

### Alternativa F: fork com pilha de commits recolocada por tag (Opção C do sync)

*   **Pros**: Pilha de mudanças legível e branches de release preservadas, sem reescrever histórico publicado.
*   **Cons**: Exige disciplina para manter os commits pequenos, e quem contribui precisa entender o modelo de branches por release. Cada tag vira um rebase.
*   **Reason for Rejection**: Não selecionada agora. Fica como opção de reavaliação se os primeiros ensaios mostrarem conflitos recorrentes e custo alto com a Opção A.

### Alternativa G: bot de sync automático e atualização a cada release

*   **Pros**: Menos trabalho manual de acompanhar o upstream.
*   **Cons**: Conflitos de layout são semânticos e um bot não os resolve. O custo vem do número de arquivos tocados, não do método. Atualizar sem avaliar pode quebrar o produto.
*   **Reason for Rejection**: O dono decidiu avaliar cada release. Automação, se vier, será só para detectar e testar o merge numa branch de teste, depois de dois syncs manuais.

### Alternativa H: hub dentro do extension host ou da janela da IDE

*   **Pros**: Um processo a menos e integração direta com a API de extensões.
*   **Cons**: As sessões morrem quando a janela fecha ou recarrega. O Android e outros clientes teriam que reimplementar o hub.
*   **Reason for Rejection**: Sessões precisam sobreviver à IDE. O hub é um daemon separado, e a IDE é cliente dele.

### Alternativa I: controlar agentes só por scraping de terminal (PTY)

*   **Pros**: Funciona com qualquer CLI, sem depender de protocolo.
*   **Cons**: Frágil a mudanças de formato, sem eventos estruturados e sem aprovar ou rejeitar de forma confiável.
*   **Reason for Rejection**: Fica como fallback. A preferência é usar os modos estruturados que cada CLI oferecer.

### Alternativa J: reutilizar credenciais das CLIs ou agrupar contas

*   **Pros**: Permitiria chamar APIs de dentro da IDE sem abrir a CLI.
*   **Cons**: É o padrão típico de violação de termos de serviço e expõe credenciais do usuário.
*   **Reason for Rejection**: O hub só lança a CLI oficial, e o login fica nela. Modo com chave de API é separado e explícito.

### Alternativa K: usar o Visual Studio Marketplace

*   **Pros**: Catálogo maior que o do Open VSX.
*   **Cons**: Os termos de uso da Microsoft proíbem o uso por forks.
*   **Reason for Rejection**: Contornar os termos está fora de questão. O Open VSX é o catálogo principal, com VSIX manual como complemento.

### Alternativa L: infraestrutura própria agora (marketplace, relay remoto, assinatura paga)

*   **Pros**: Mais controle e uma experiência mais completa para o usuário final.
*   **Cons**: Custos e novas superfícies de ataque, em contradição com o orçamento de R$0.
*   **Reason for Rejection**: Não cabe no orçamento. O marketplace é uma configuração do `product.json` e pode ser trocado depois. O acesso remoto usa rede privada. O v0 não é assinado.

### Alternativa M: hub como processo filho da IDE

*   **Pros**: Mais simples, sem gestão de ciclo de vida do daemon.
*   **Cons**: As sessões terminam quando a IDE fecha. O acesso pelo Android só funcionaria com a IDE aberta.
*   **Reason for Rejection**: Decisão do dono: fechar a IDE não pode encerrar os agentes em execução. Esta alternativa estava permitida no brief e foi substituída.

### Alternativa N: hub como serviço do Windows ou iniciado no login

*   **Pros**: Sempre disponível, inclusive depois de reiniciar o Windows e para o acesso remoto futuro.
*   **Cons**: Exige instalação que altera configuração do sistema e o daemon passa a rodar sem o usuário notar. Aumenta a superfície de segurança.
*   **Reason for Rejection**: Fora do v0 por decisão do dono. A persistência exigida é durante o fechamento e a reabertura da IDE, não depois de reiniciar o Windows.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Segurança e privacidade:** o daemon exige token, valida `Host` e `Origin` e escuta só em 127.0.0.1. O hub nunca lê credenciais das CLIs. Não há telemetria de saída por padrão, e isso é registrado no README. Sem sandbox de sistema operacional no v0: antes de cada sessão o hub registra o estado do Git, e o painel informa essa limitação.
*   **Desempenho:** o build completo é pesado (tempo, disco e RAM). Os valores reais são medidos no primeiro build e registrados em `docs/BUILD-WINDOWS.md`. Não há meta de desempenho para o hub no v0 além de não travar a IDE.
*   **Rollout e rollback:** o v0 roda a partir do fonte, na máquina do dono. Antes de cada sync há uma tag Git no estado atual. A branch estável só recebe um merge depois da validação numa branch de teste. Voltar atrás é desfazer o merge ou voltar à tag anterior.

--------------------------------------------------------------------------------

### Additional Resources

*   `concepts_brief.md` (na raiz do projeto): brief do brainstorm e achados dos seis Goldfish. Citado sem link de propósito, para que os revisores independentes não o leiam automaticamente.
*   VSCodium: referência técnica para branding, telemetria, Open VSX e scripts de build.
*   Repositório e documentação de build do Code - OSS na tag escolhida: ainda não lidos. Todos os nomes de arquivos do upstream abaixo dependem dessa leitura.

### Future Improvements

*   **Reavaliar a Opção C de sync** se os dados dos primeiros merges mostrarem conflitos recorrentes e custo alto.
*   **Segundo adapter** e extração do contrato comum a partir dele.
*   **Acesso remoto** pelo Android, com gateway privado e token por dispositivo.
*   **Substituição de partes do layout**, cada uma atrás de configuração.
*   **Gerenciador de MCPs e skills**, instalador assinado e auto-update, quando houver demanda.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Escopo: só o necessário para a primeira versão executável. A ordem é a sugerida no Technical Plan e pode ser adaptada. Caminhos marcados "(a verificar)" dependem de ler o código da tag escolhida e só viram definitivos depois do build sem alterações. Qualquer arquivo do upstream que acabe sendo editado entra em `UPSTREAM-TOUCHPOINTS.md`.

### Target Files to Create/Modify

#### 1. `UPSTREAM-TOUCHPOINTS.md` (Create)

*   **Type / Scope**: Documento na raiz do repositório.
*   **Proposed Changes**: Tabela com uma linha por arquivo do upstream editado: caminho, motivo da edição e tag em que foi feita. Começa vazia. Medida direta do custo de sync.

#### 2. `docs/upstream-sync.md` (Create)

*   **Type / Scope**: Documento de procedimento e registro.
*   **Proposed Changes**: Tag e commit do upstream fixados. Procedimento de sync: criar a branch de teste, fazer o merge da tag, resolver conflitos com `git rerere` conferindo o resultado, validar o build e as funcionalidades essenciais, só então atualizar a branch estável. Tabela de registro por sync: tag de origem, tag de destino, número de arquivos em conflito, tempo gasto. Critério de reavaliação da Opção C: conflitos recorrentes nos mesmos arquivos e custo alto, segundo o dono.

#### 3. `docs/BUILD-WINDOWS.md` (Create)

*   **Type / Scope**: Documento de ambiente e build.
*   **Proposed Changes**: Pré-requisitos (Node da versão do `.nvmrc` da tag, Python 3, Git, Visual Studio 2022 Build Tools com C++, bibliotecas Spectre, ATL, Windows SDK), long paths habilitados, caminho de clone sem espaços, comandos de instalação, compilação e execução em desenvolvimento, e os tempos, o uso de disco e de RAM medidos. Os comandos exatos vêm do README e da documentação de contribuição do upstream na tag (a verificar).

#### 4. `singularity/tools/setup-repo.ps1` (Create)

*   **Type / Scope**: Script PowerShell de configuração do repositório.
*   **Proposed Changes**: Adiciona o remote `upstream`, busca as tags e ativa `rerere.enabled`. Idempotente. Não altera arquivos do upstream.

#### 5. `NOTICE.md` (Create)

*   **Type / Scope**: Aviso de licença e atribuição.
*   **Proposed Changes**: Declara que o código original do Singularity usa MIT e quais diretórios ele cobre (`singularity/`, `extensions/singularity-*`, os módulos próprios). Aponta para o `LICENSE` e o `ThirdPartyNotices` do upstream, que permanecem sem alteração, e lista os avisos adicionais exigidos pelo build público (conferidos no passo de verificação de licenças).

#### 6. `README.md` (Modify)

*   **Type / Scope**: Documento do projeto, arquivo do upstream.
*   **Proposed Changes**: Substituir pelo texto do Singularity: o que é, status, como compilar (link para `docs/BUILD-WINDOWS.md`), licença, e a lista curta do que não existe no v0 (sem assinatura, sem auto-update, sem sandbox, sem Pylance e outras extensões da Microsoft). Registrar em `UPSTREAM-TOUCHPOINTS.md`.

#### 7. `product.json` (Modify)

*   **Type / Scope**: Configuração do produto, arquivo do upstream.
*   **Proposed Changes**: Trocar nome, identificadores do produto, protocolo de URL, pasta de dados e identificadores do instalador por valores próprios, todos diferentes dos do VS Code e do Code - OSS. Apontar a gallery para o Open VSX. Remover ou deixar vazios os endpoints de telemetria e de atualização da Microsoft. Os nomes exatos dos campos são conferidos na tag, usando o VSCodium como referência. Se o upstream tiver um mecanismo de override de produto (a verificar), preferir ele à edição direta. Registrar em `UPSTREAM-TOUCHPOINTS.md` em qualquer caso.

#### 8. Ícones e logotipos (Modify, a verificar)

*   **Type / Scope**: Arquivos de imagem do produto, sob `resources/` (a verificar quais).
*   **Proposed Changes**: Substituir os ícones e logotipos da Microsoft pelos do Singularity. A lista exata sai de uma busca na tag após o primeiro build. Registrar cada arquivo em `UPSTREAM-TOUCHPOINTS.md`.

#### 9. `extensions/singularity-theme/` (Create)

*   **Type / Scope**: Built-in extension de tema (`package.json` e arquivos de tema JSON).
*   **Proposed Changes**: Tema de cores padrão do Singularity, aplicado como tema inicial pelo valor padrão da configuração. Código aditivo, sem edição do upstream.

#### 10. `singularity/hub/` (Create)

*   **Type / Scope**: Projeto Node/TypeScript independente (`package.json`, `tsconfig.json`), sem importar nada do VS Code. Fora do build do upstream.
*   **Proposed Changes**: Daemon do hub. Arquivos abaixo.

#### 10.1 `singularity/hub/src/main.ts` (Create)

*   **Type / Scope**: Ponto de entrada.
*   **Proposed Changes**: Obtém o recurso exclusivo de instância (via `lifecycle.ts`). Se não conseguir, sai sem subir outro daemon. Se conseguir, sobe o servidor em 127.0.0.1 em porta efêmera, grava o arquivo de informações e executa a recuperação de processos abandonados. Não encerra por conta própria enquanto houver sessões em execução.

#### 10.2 `singularity/hub/src/auth.ts` (Create)

*   **Type / Scope**: Módulo de autenticação.
*   **Proposed Changes**: Gera o token aleatório no primeiro start, grava o arquivo no perfil do usuário com permissão restrita a ele (ACL do Windows), compara o token recebido em tempo constante e valida `Host` e `Origin`.

#### 10.3 `singularity/hub/src/server.ts` (Create)

*   **Type / Scope**: Servidor WebSocket.
*   **Proposed Changes**: Aceita conexões só depois de validar token, `Host` e `Origin`. Fecha e registra as inválidas. Despacha comandos e envia eventos às conexões inscritas.

#### 10.4 `singularity/hub/src/protocol.ts` (Create)

*   **Type / Scope**: Tipos e versão do protocolo.
*   **Proposed Changes**: Mensagens JSON versionadas. Comandos: iniciar sessão, enviar entrada, parar, consultar. Eventos: log, mensagem do agente, arquivo alterado, pedido de aprovação, fim e erro.

#### 10.5 `singularity/hub/src/adapter.ts` (Create)

*   **Type / Scope**: Interface do adapter e registry.
*   **Proposed Changes**: Interface do Technical Plan (`detect`, `authStatus`, `startSession`, `send`, `stop`, `events`, `capabilities`, `authMode`). Registry de adapters. O contrato comum é extraído depois do segundo adapter.

#### 10.6 `singularity/hub/src/sessions.ts` (Create)

*   **Type / Scope**: Gerenciador de sessões.
*   **Proposed Changes**: Cria e acompanha sessões, grava o log de eventos append-only em disco (um arquivo por sessão), chama o snapshot antes e depois e emite o diff quando há alterações.

#### 10.7 `singularity/hub/src/process-tree.ts` (Create)

*   **Type / Scope**: Controle de processos da sessão.
*   **Proposed Changes**: Avalia Windows Job Objects para agrupar e encerrar a sessão. Mantém a verificação complementar: PID raiz e horário de criação conferidos antes de qualquer encerramento, com `taskkill /PID <raiz> /T` como fallback. Só toca nos processos da própria sessão.

#### 10.8 `singularity/hub/src/snapshot.ts` (Create)

*   **Type / Scope**: Snapshot e diff via Git.
*   **Proposed Changes**: Cria o snapshot da árvore usando um índice temporário, sem alterar o índice do usuário, antes e depois da sessão, e calcula o diff. Preserva alterações que o usuário já tinha antes de iniciar e não atribui ao agente mudanças feitas por outros processos durante a sessão. Em pastas sem Git, entrega só a lista de arquivos alterados quando houver como determiná-la. Sessões paralelas na mesma pasta são avisadas. Worktrees isoladas são consideradas para o caso paralelo.

#### 10.9 `singularity/hub/src/lifecycle.ts` (Create)

*   **Type / Scope**: Ciclo de vida do daemon.
*   **Proposed Changes**: Recurso exclusivo de instância por usuário e arquivo de informações (porta, token, PID com horário de criação, versão do hub e do protocolo). Handshake de versão: recusa clientes com protocolo incompatível. Comando de encerramento com a escolha do usuário (aguardar, parar tudo e sair, ou cancelar, com cancelar como padrão). Na inicialização, lê os registros de sessão, marca as de processo inexistente como encerradas de forma inesperada, limpa recursos temporários e lista processos órfãos para decisão do usuário.

#### 11. `singularity/adapters/opencode/` (Create)

*   **Type / Scope**: Pacote do primeiro adapter, o do OpenCode. A interface de integração exata depende de verificar a documentação (Open Question).
*   **Proposed Changes**: `src/index.ts` implementa a interface do adapter, usa as interfaces oficiais do OpenCode que a verificação confirmar, preserva a autenticação nativa dele e converte o que ele emite em eventos do hub. `test/` guarda saída gravada para testar o parser. Não lê, copia, intercepta nem reutiliza credenciais.

#### 12. `docs/adapters/opencode.md` (Create)

*   **Type / Scope**: Nota do adapter.
*   **Proposed Changes**: Termos do provedor lidos, data da leitura, modo de autenticação usado, forma de integração (modo estruturado ou PTY) e limites conhecidos.

#### 13. `extensions/singularity-hub/` (Create)

*   **Type / Scope**: Built-in extension TypeScript (`package.json`, `tsconfig.json`).
*   **Proposed Changes**: Cliente do hub dentro da IDE. Arquivos abaixo.

#### 13.1 `extensions/singularity-hub/package.json` (Create)

*   **Type / Scope**: Manifesto.
*   **Proposed Changes**: Declara o view container "Agents", a webview view, os comandos (iniciar, parar, abrir painel, encerrar o hub) e a ativação.

#### 13.2 `extensions/singularity-hub/src/extension.ts` (Create)

*   **Type / Scope**: Ativação.
*   **Proposed Changes**: Se não houver um hub vivo, lança o daemon como processo destacado que sobrevive ao fechamento da IDE. Lê o arquivo de informações, autentica-se, confere a versão do protocolo e, ao conectar, recupera as sessões existentes. Se as versões forem incompatíveis, recusa a conexão e avisa o usuário.

#### 13.3 `extensions/singularity-hub/src/client.ts` (Create)

*   **Type / Scope**: Cliente WebSocket.
*   **Proposed Changes**: Conecta com o token, reconecta, reaplica o log depois de uma desconexão e expõe os eventos ao painel.

#### 13.4 `extensions/singularity-hub/src/panel.ts` e `media/` (Create)

*   **Type / Scope**: Provedor da webview e HTML, JS e CSS do painel.
*   **Proposed Changes**: Lista sessões, mostra o log em streaming, os arquivos alterados, o diff quando houver e o botão de parar. Webview sem conteúdo remoto.

#### 14. Inclusão das built-in extensions no build (Modify, a verificar)

*   **Type / Scope**: Arquivo de build do upstream que lista ou compila as extensões embutidas (a verificar).
*   **Proposed Changes**: Só se for necessário para que `singularity-theme` e `singularity-hub` entrem no build. Edição mínima, registrada em `UPSTREAM-TOUCHPOINTS.md`. Se o upstream já incluir tudo em `extensions/` por convenção, nenhuma edição.

#### 15. `singularity/tools/build-hub.ps1` (Create)

*   **Type / Scope**: Script de build do hub.
*   **Proposed Changes**: Compila o hub e coloca a saída onde a extensão a encontra, tanto em desenvolvimento quanto no build empacotado. O local no empacotado é definido no passo de build empacotado.

#### 16. `singularity/tools/smoke.ps1` (Create)

*   **Type / Scope**: Script de verificação rápida.
*   **Proposed Changes**: Confere que o produto abre com o nome do Singularity, que o `product.json` não contém endpoints da Microsoft de telemetria e atualização (busca por endpoints externos), que o hub sobe e recusa conexão sem token, que uma sessão com o adapter falso termina e que uma segunda instância do hub é recusada.

#### 17. `singularity/hub/test/` (Create)

*   **Type / Scope**: Testes unitários com o executor de testes embutido do Node.
*   **Proposed Changes**: `auth.test.ts` (token, `Host`, `Origin`), `protocol.test.ts` (versão e mensagens), `process-tree.test.ts` (só encerra a árvore da sessão e não encerra processo estranho), `snapshot.test.ts` (preserva alterações prévias, diff só com alterações), `lifecycle.test.ts` (segunda instância é recusada, protocolo incompatível é recusado, encerramento com sessões em execução pede escolha e cancela por padrão, sessão de processo inexistente é marcada como encerrada), mais um adapter falso para testar o ciclo de sessão.

### Verification Plan

*   **Compilation/Build**: build do fork conforme o `docs/BUILD-WINDOWS.md` (passo 2: sem alterações; depois com o `product.json` e as extensões nossas). `singularity/tools/build-hub.ps1` para o hub.
*   **Unit Tests**: `node --test` nos testes do hub, mais o parser do primeiro adapter com saída gravada.
*   **Static Analysis & Linting**: `tsc --noEmit` no hub e nas extensões. Usar a configuração de lint do upstream para a extensão `singularity-hub`, se couber.
*   **Test Coverage Requirement**: sem meta numérica. Os caminhos obrigatórios são autenticação, encerramento de processos, snapshot e diff, e o protocolo.
*   **E2E/Integration**: `singularity/tools/smoke.ps1` e verificação manual dos CUJs 1 a 5, incluindo um ensaio de sync com a tag seguinte do upstream, registrado em `docs/upstream-sync.md`.

--------------------------------------------------------------------------------

## Adendo de Decisões da Revisão

Decisões tomadas pelo dono depois da revisão consolidada do EGM (itens K1 a K8). Onde este adendo contradiz um trecho anterior do documento, o adendo prevalece. Cada decisão é registrada à medida que é tomada.

### K1. Runtime do hub: Node.js empacotado junto do produto (decidido em 2026-11-02)

**Decisão.** O hub usa um runtime Node.js próprio do projeto, empacotado junto do Singularity (Opção C). Esta é a arquitetura definitiva do produto distribuído.

*   O runtime tem versão compatível, fixada e controlada pelo projeto.
*   É independente do Electron do Code - OSS.
*   O usuário final não precisa instalar Node.js.
*   A instalação continua gratuita e sem dependências externas obrigatórias, exceto as ferramentas dos agentes que o usuário escolher usar.
*   O processo do hub continua independente da janela da IDE e preserva as sessões depois que ela fecha.

**Uso temporário (autorizado).** Durante o desenvolvimento e os primeiros testes, o hub pode usar o Node do sistema (Opção A) para não bloquear a implementação enquanto o empacotamento não existe. Isso não altera a decisão: a distribuição pública executável usa a Opção C.

**Como a extensão encontra o Node (simples, a confirmar na implementação).** Ordem fixa: primeiro o `node` empacotado, em caminho relativo ao hub; se não existir e o produto estiver em modo de desenvolvimento, o `node` do PATH. Sem busca em outros lugares nem configuração obrigatória.

**Registro exigido (a preencher quando o empacotamento for feito).**

*   **Versão do Node:** a definir. Deve ser uma versão com suporte de segurança ativo e compatível com as dependências do hub. Registrada em `docs/BUILD-WINDOWS.md` e no script de empacotamento.
*   **Segurança:** obter o binário só da distribuição oficial do Node. Acompanhar os avisos de segurança do Node e atualizar o runtime quando houver correção relevante.
*   **Integridade:** verificar o checksum do binário contra o arquivo de checksums publicado pela distribuição oficial e guardar o valor esperado no repositório. A verificação é feita pelo script de empacotamento.
*   **Licenciamento de redistribuição:** conferir a licença do Node e as licenças de dependências incluídas na versão escolhida, e incluir os avisos exigidos em `NOTICE.md` e no pacote. A lista exata é uma verificação externa pendente.

**Efeito no plano.** Os itens 13.2 e 15 passam a considerar o runtime do hub: o 13.2 lança o hub com o Node resolvido pela ordem acima, e o item 15 inclui, na fase de empacotamento, obter o Node oficial, verificar o checksum e colocá-lo ao lado do hub. O destino exato dentro do build empacotado depende de ler a estrutura do build do upstream. Isso não é feito agora.

### K2. Encerramento de sessões: Job Object com helper nativo próprio (decidido em 2026-11-02)

**Decisão.** Cada sessão de agente roda dentro de um Job Object criado por um helper nativo Windows pequeno (Opção B). Isso substitui `taskkill /T` e a verificação por PID e horário de criação como mecanismo primário (trechos das seções Hub e `process-tree.ts`).

**Diretrizes aprovadas.**

1.  **Helper.** Pequeno, independente do Node.js, preferencialmente um executável próprio. A linguagem e o toolchain do helper ainda não foram escolhidos (pendência abaixo).
2.  **Um Job Object por sessão**, para isolar as sessões entre si.
3.  **Sem corrida entre criação e associação.** O helper cria o processo do agente suspenso, associa-o ao Job Object e só depois o libera para executar.
4.  **Encerramento.** Primeiro uma tentativa graciosa, quando o harness a suportar (capacidade declarada pelo adapter). Depois, `TerminateJobObject` para o encerramento forçado.
5.  **Sem `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` por padrão.** A queda do hub não encerra os agentes automaticamente. Isso mantém a regra de que fechar a IDE ou perder o hub não mata as sessões.
6.  **Job Objects nomeados (investigação).** Avaliar se um hub reiniciado consegue identificar e recuperar sessões ainda ativas por nome, sem depender só de PIDs. A reanexação da saída do agente continua sem garantia: o que se busca é identificar e poder encerrar sessões vivas.
7.  **Limites conhecidos.** Processos que usam mecanismos de breakaway podem escapar do Job Object. Não presumir isolamento absoluto sem teste.
8.  **Falha na associação.** Se a associação ao Job Object falhar, o agente não é iniciado sem gerenciamento de processos, e o erro é informado.
9.  **Estados da sessão** são registrados em disco, e a reconexão depois do fechamento da IDE continua prevista.
10. **Spike antes do código definitivo.** Um spike pequeno valida o comportamento real no Windows 11 antes de implementar o gerenciamento definitivo.
11. **Build e empacotamento.** O helper é compilado e empacotado pelo build do Singularity, sem exigir que o usuário instale dependências.
12. **Escopo.** Manter objetiva a implementação, sem criar infraestrutura nativa maior do que o necessário.

**Efeito no plano.** O item 10.7 (`process-tree.ts`) passa a ser a ponte entre o hub e o helper, em vez de executar `taskkill`. Entra um componente novo, o helper, e o item 15 passa a compilar e empacotá-lo. PID e horário de criação ficam, no máximo, como verificação complementar na recuperação de sessões quando o Job Object nomeado não bastar. Estes ajustes de arquivos serão consolidados no fim da revisão dos itens K1 a K8.

**Pendências.**

*   Linguagem e toolchain do helper (o toolchain C++ do Windows já é pré-requisito do build do upstream, mas isso não foi decidido para o helper).
*   Interface entre o hub e o helper (argumentos, saída, códigos de retorno).
*   Resultado do spike: comportamento do suspend e resume, do breakaway, do Job Object nomeado, e se processos destacados de agentes escapam.
*   Possível sinalização de antivírus para o executável do helper em máquinas de teste (hipótese, não verificada).

### K3. Protocolo: JSON-RPC 2.0 sobre WebSocket (decidido em 2026-11-02, definitivo)

**Decisão.** As mensagens entre o hub e seus clientes seguem a especificação oficial do JSON-RPC 2.0 (https://www.jsonrpc.org/specification), transportadas por WebSocket em 127.0.0.1. Não há outro envelope RPC por cima. Isso substitui a lista de mensagens do item 10.4 e o texto da seção Hub sobre comandos e eventos.

**Regras do protocolo.**

1.  Requisições usam `id`, `method` e `params`; respostas usam `result` ou `error`, como na especificação.
2.  **Versão própria do protocolo Singularity**, negociada no handshake e separada do campo `jsonrpc: "2.0"`. Regra inicial de compatibilidade: igualdade exata da versão do protocolo. Qualquer afrouxamento é decisão futura.
3.  **Eventos são notificações JSON-RPC** (sem `id`, sem resposta) enviadas do hub aos clientes: logs, mudanças de estado e resultados do agente.
4.  **Todo evento de sessão** traz o identificador da sessão e um número de sequência `seq`, crescente por sessão, sem repetição. O cliente detecta lacunas e recupera eventos depois de reconectar.
5.  **Inscrição e replay** são métodos da aplicação, sem modificar a especificação. O cliente informa o último `seq` recebido. O hub entrega o replay a partir dele e passa aos eventos ao vivo sem duplicar nem perder eventos na transição (o cliente descarta por `seq` o que já recebeu).
6.  **Histórico indisponível.** Se os eventos pedidos não existem mais, o hub informa a lacuna (intervalo de `seq` ausente) e devolve o estado atual da sessão. Nunca finge que o histórico está completo.
7.  **Limites e backpressure.** Há limite de tamanho de mensagem, de memória por cliente e de fila de envio, com mecanismo simples: se o cliente não acompanhar, o hub registra a lacuna e o cliente ressincroniza pelo estado atual, em vez de acumular memória sem limite. Os valores iniciais são fixados na implementação e medidos.
8.  **Vários clientes** conectam ao mesmo tempo (a IDE e, no futuro, o Android) sem alterar o contrato principal.
9.  **Segredos.** Tokens e credenciais nunca aparecem em logs nem em notificações.
10. **Autenticação, `Host` e `Origin`** continuam obrigatórios como aprovado. O local do token e a forma de autenticar na conexão são decididos em K4.

**Métodos da aplicação (nomes iniciais, ajustáveis na implementação).**

| Método | Função |
|---|---|
| `hub.hello` | Handshake: versão do protocolo e do hub; recusa incompatibilidade. |
| `sessions.list` | Lista as sessões e seus estados. |
| `session.start` | Inicia um agente (adapter, `cwd`, prompt). |
| `session.send` | Envia entrada a uma sessão. |
| `session.stop` | Pede encerramento (gracioso quando o adapter suporta, depois forçado, conforme K2). |
| `session.subscribe` | Inscreve-se em eventos de uma sessão a partir de um `seq`; devolve lacuna e estado quando aplicável. |
| `orphans.list`, `orphans.stop` | Lista e encerra processos de sessões abandonadas. |
| `hub.shutdown` | Solicita o encerramento do hub, com a escolha do usuário se houver sessões ativas. |

Eventos (notificações): log da sessão, mudança de estado, arquivo alterado, resultado e erro. O evento de pedido de aprovação continua previsto só como capacidade opcional do adapter (ver Open Questions).

**Códigos de erro.** Erros padronizados do JSON-RPC quando aplicáveis. Códigos próprios do Singularity (valores iniciais, fora da faixa reservada pela especificação): autenticação inválida, protocolo incompatível, sessão inexistente, histórico indisponível, falha ao associar o processo ao Job Object (K2), limite excedido.

**Testes.** Testes de contrato proporcionais à implementação: handshake e incompatibilidade de versão, números de sequência sem lacuna na transição entre replay e ao vivo, histórico indisponível, mensagem grande demais, cliente lento e dois clientes simultâneos. O protocolo é documentado no repositório. Sem infraestrutura de mensageria distribuída.

### K4. Autenticação: token no cabeçalho `Authorization` do upgrade (decidido em 2026-11-02)

**Decisão.** A extensão da IDE autentica o WebSocket com `Authorization: Bearer <token>` no handshake HTTP (Opção A). O hub valida a credencial antes de aceitar o upgrade e recusa conexões não autorizadas. Isso substitui a frase "em cabeçalho ou na primeira mensagem" da seção Hub.

**Regras.**

1.  **Sem segundo mecanismo.** A Opção B (token na primeira mensagem) não é um mecanismo alternativo silencioso. Qualquer segundo mecanismo de autenticação exige uma nova decisão arquitetural.
2.  **`hub.hello` não carrega o token.** Só negocia a versão do protocolo e identifica o cliente.
3.  **Token.** Gerado com fonte criptográfica, guardado com permissão restrita ao usuário do Windows e nunca registrado em logs nem enviado em URL, query string ou subprotocolo WebSocket.
4.  **`Host` e `Origin`.** Continuam sendo validados no upgrade, com política explícita: o `Host` aceito é só o endereço de loopback do hub com a porta dele; requisições com `Origin` presente são recusadas, salvo uma lista permitida (vazia no v0); clientes nativos sem `Origin` são aceitos só com token válido. `Origin` nunca conta como autenticação. A webview do painel não abre conexão própria: quem conecta é o extension host, e a webview fala com ele por mensagens internas da IDE.
5.  **Rotação e tentativas.** O token vale durante a vida do hub e é renovado a cada início do hub. A rotação manual fica prevista (os clientes reconectam com o novo token), sem método novo no protocolo agora. Há limite de tentativas de autenticação por origem de conexão, com espera crescente, e as falhas são registradas sem o token. Valores fixados na implementação.
6.  **Rejeição antes do upgrade** responde com status HTTP, sem abrir WebSocket. O erro JSON-RPC de autenticação inválida (K3) só se aplica a casos posteriores, por exemplo um token invalidado por rotação com a conexão aberta.
7.  **Escopo do v0.** Só clientes locais autenticados. O hub não é exposto à internet nem à rede local.
8.  **Android (futuro).** Será atendido por um gateway privado, com autenticação própria e comunicação protegida, que se autentica perante o hub sem expor o token permanente ao navegador. O gateway não é implementado agora. Só se preserva a possibilidade arquitetural.

**Armazenamento (detalhes mecânicos, a confirmar na implementação).** O token e o arquivo de informações do hub ficam em uma pasta do perfil do usuário do Windows (sob `%LOCALAPPDATA%`, subpasta própria do Singularity). A permissão restrita é aplicada à pasta antes de escrever o token, e o arquivo é escrito de forma atômica (arquivo temporário e renomeação). A comparação do token é feita sobre valores de tamanho fixo. O nome do recurso exclusivo de instância (seção Hub, ciclo de vida) inclui o identificador do usuário. O mecanismo exato de aplicar permissões restritas no Windows a partir do hub é uma verificação externa pendente.

**Testes de conexões rejeitadas.** Sem token, token errado, `Host` inválido, `Origin` fora da lista, tentativas acima do limite, token ausente dos logs e das notificações.

### K5. Toolchain do hub: TypeScript compilado com `tsc` para JavaScript (decidido em 2026-11-02, definitivo)

**Decisão.** O hub é escrito em TypeScript com tipagem estrita e compilado com o `tsc` oficial para JavaScript, em um diretório de saída separado (`dist/`). O Node empacotado (K1) executa só o JavaScript compilado na distribuição pública. Nada depende de executar arquivos TypeScript diretamente. Isso substitui a dúvida sobre `node --test` com `.ts` nos itens 10 e 17.

**Regras.**

1.  **Versões e reprodutibilidade.** Versão controlada do TypeScript e das dependências, com lockfile reproduzível.
2.  **Testes.** `node:test` como executor inicial, rodando sobre o JavaScript compilado. Os scripts de build e de teste garantem a compilação antes da execução, para não testar arquivos desatualizados.
3.  **Erros de compilação.** Nenhum artefato é publicado ou empacotado com erro de compilação ou de tipagem. Avaliar `noEmitOnError` no `tsconfig.json`.
4.  **WebSocket.** Biblioteca `ws`. Confirmar versão, licença e compatibilidade com o Node fixado. Dependências nativas opcionais da biblioteca ficam fora do caminho crítico do hub, sempre que possível.
5.  **Empacotamento.** Inclui o JavaScript compilado, as dependências de produção necessárias e o runtime Node de K1.
6.  **Separação.** O código do hub, a extensão built-in da IDE e o helper nativo Windows (K2) são componentes distintos, cada um com seu build.
7.  **ESM ou CommonJS.** Escolha pelos requisitos reais das dependências e do empacotamento, na implementação, sem complexidade desnecessária.
8.  **Sem ferramentas adicionais.** Sem bundlers, frameworks de testes ou ferramentas de build complexas sem necessidade demonstrada.
9.  **Ritmo.** Builds reproduzíveis, testes proporcionais às alterações e desenvolvimento iterativo, conforme EGM + Vibe Coding.

**Efeito no plano.** O item 10 (hub) ganha `tsconfig.json` estrito, saída em `dist/`, lockfile e scripts de build e teste. O item 17 passa a rodar sobre `dist/`. O item 15 passa a empacotar `dist/` e as dependências de produção.

**Pendências.** Versão do Node (K1) e do TypeScript; ESM ou CommonJS; confirmação de versão, licença e compatibilidade do `ws`.

### K6. Diff do v0: alterações observadas durante a sessão (decidido em 2026-11-02, definitivo)

**Decisão.** O diff do v0 mostra tudo que mudou na pasta durante a sessão, com aviso explícito (Opção A). Isso substitui a promessa de "não atribuir ao agente mudanças feitas por outros processos" nos itens 10.8 e 13.4, na seção NFR e nos pontos a validar, e retira a menção a worktrees do item 10.8 como entrega do v0.

**Regras.**

1.  **Mecanismo.** Snapshots da árvore de trabalho antes e depois da sessão, com índice Git temporário, sem modificar o índice real do usuário.
2.  **Como é apresentado.** Com o título "Alterações observadas durante a sessão", nunca como autoria comprovada do agente. A interface informa que alterações feitas pelo usuário ou por outros programas no mesmo intervalo também podem aparecer.
3.  **Alterações preexistentes.** Arquivos já modificados, em staging ou não rastreados antes da sessão não são atribuídos à sessão, pois os dois snapshots são montados da mesma forma e o diff é entre eles. Isso vale dentro das limitações documentadas do mecanismo.
4.  **Nunca destrutivo.** O hub não executa `git reset`, `git clean`, checkout destrutivo nem qualquer operação que descarte modificações do usuário.
5.  **Tipos de mudança.** Inclusões, modificações, exclusões e renomeações, conforme as capacidades verificadas do Git na implementação.
6.  **Quando não há diff confiável.** O painel informa a indisponibilidade e não mostra resultado incompleto como se fosse completo.
7.  **Agentes trabalham direto no projeto aberto.** Sem worktrees automáticas no v0. A arquitetura fica preparada para adicionar worktrees isoladas por sessão no futuro, principalmente para execução paralela.
8.  **Fora do v0.** Cruzamento com eventos de arquivo dos adapters e qualquer mecanismo complexo de autoria. O cruzamento poderá ser avaliado quando os contratos do OpenCode estiverem verificados.

**Roteiro Git (a confirmar na implementação).** Resolver a raiz do repositório a partir do `cwd`. Montar o índice temporário a partir da cópia do índice real, para reaproveitar informações de arquivos já conhecidos, e adicionar o conteúdo da árvore de trabalho. Gravar a árvore resultante. Repetir ao final e comparar as duas árvores, com detecção de renomeação. Remover o índice temporário. Como ambos os snapshots são árvores, um repositório sem commits não precisa de HEAD.

**Limitações a documentar.**

*   Arquivos ignorados pelo Git não aparecem.
*   Submódulos aparecem, no máximo, como mudança do ponteiro, sem o conteúdo interno.
*   Arquivos binários aparecem como alterados, sem conteúdo.
*   Diretórios que não são repositórios Git e ausência do `git` no PATH resultam em "diff indisponível".
*   Criar os snapshots grava objetos soltos no banco de objetos do repositório, que permanecem até uma limpeza do Git. O tempo do snapshot pode ser alto em repositórios grandes.
*   Conversão de finais de linha configurada no Git pode gerar ruído no diff.

**Pendências.** Confirmar o roteiro e os casos de borda em testes reais (repositório sem commits, subpasta, submódulos, conversão de finais de linha, repositório grande). Como o diff é exibido (editor de diff nativo da IDE ou painel próprio) continua em aberto.

### K7. Adapter do OpenCode: `opencode serve` com HTTP e SSE (decidido em 2026-11-02, definitivo para o v0)

**Decisão.** O primeiro adapter usa a interface HTTP oficial do OpenCode (`opencode serve`) com eventos SSE (Opção A). Não há scraping de terminal. Substitui o adapter "a verificar" dos itens 11 e 12 e a frase sobre PTY como fallback do OpenCode.

**Regras.**

1.  **Uma instância por sessão.** Cada sessão gerenciada tem seu próprio `opencode serve`, com isolamento de processo e de diretório de trabalho. Compartilhar um servidor entre sessões fica fora do v0.
2.  **Só loopback.** Cada instância escuta em `127.0.0.1`, em porta livre escolhida pelo hub. Nunca rede local ou internet.
3.  **Autenticação do servidor.** HTTP Basic Auth com senha aleatória gerada pelo hub, passada pela variável `OPENCODE_SERVER_PASSWORD`. Nunca em argumento de linha de comando nem em log.
4.  **Endpoints oficiais.** `POST /session` para criar, `POST /session/:id/prompt_async` para enviar prompt, `GET /event` (SSE) para receber, `POST /session/:id/abort` para cancelar.
5.  **Mapeamento de sessões.** O identificador da sessão do OpenCode é guardado junto com o identificador da sessão Singularity e com o estado dela, no registro da sessão.
6.  **Eventos.** Cada evento SSE vira uma notificação JSON-RPC do Singularity com o `seq` da sessão (K3), para replay depois de reconexão da IDE.
7.  **Encerramento.** Primeiro `abort`. Se a atividade não parar no prazo, `TerminateJobObject` no Job Object da própria sessão (K2). Nenhuma outra sessão é afetada.
8.  **Disponibilidade.** Antes de qualquer operação, o hub verifica se o servidor responde. A página do servidor que li não nomeia um endpoint de saúde. O endpoint será confirmado na implementação e não deve ser suposto.
9.  **Autenticação nativa preservada.** O Singularity não lê, copia nem reutiliza credenciais dos provedores de modelo.
10. **Termos do plano Go.** O plano pede que o cliente se identifique com user agent próprio nas requisições ao serviço, e que o tráfego siga os identificadores exigidos pelo provedor. O User-Agent da comunicação local com o servidor não substitui essa exigência. Os termos gerais do OpenCode também precisam ser lidos antes da distribuição.
11. **ACP como alternativa futura.** `opencode acp` está documentado oficialmente ([página ACP](https://opencode.ai/docs/acp)): ACP sobre JSON-RPC via stdio, com sistema de permissões. A página não trata de diff nem de sessões. Fica registrado para interoperabilidade com outros agentes, fora do v0.

**Pendências (não verificadas).**

*   **Windows nativo.** Testar o OpenCode nativo no Windows 11, sem WSL. O spike entra antes do item 11. Se o servidor não funcionar, a decisão volta ao dono.
*   **Endpoint de saúde.** Identificar na documentação ou no teste real.
*   **Termos gerais de uso** do OpenCode.
*   **SDK `@opencode-ai/sdk`.** Avaliar se simplifica a implementação, sem dependência desnecessária (decisão na implementação).
*   **Compatibilidade da versão fixada** com os endpoints listados.
*   **Recuperação após queda do hub.** Testar a descoberta de instâncias sobreviventes antes de declarar garantia.
*   **Comportamento do SSE:** reconexão e eventos perdidos.

**Efeito no plano.** Os itens 11 e 12 passam a descrever este mecanismo. O item 10.5 (interface do adapter) cobre as capacidades de K7. O spike do Windows nativo vira pré-requisito do item 11.

### K8. Identidade do produto: Singularity IDE com identificadores próprios (decidido em 2026-11-02, definitivo para a v0)

**Decisão.** "Singularity IDE" é o nome visível desde a primeira compilação. Os identificadores técnicos usam um namespace próprio, associado ao projeto `Ald3b4r4n/Singularity`. Não há segundo codinome. Isso substitui o item 7 e a seção Identidade e distribuição quanto aos valores.

**Regras.**

1.  **Nome visível.** Singularity IDE desde a primeira compilação.
2.  **Namespace.** Nada de identificador genérico como `singularity` sozinho. Proposta inicial a confirmar na tag do upstream: namespace reverso `io.github.ald3b4r4n.singularity`, usado no protocolo de URL e nos identificadores técnicos.
3.  **Nomes por finalidade** (propostos, a confirmar no upstream):
    *   pasta de dados do usuário: `.singularity-ide`;
    *   protocolo de URL: `singularity-ide`;
    *   executável: `singularity-ide.exe`;
    *   GUIDs do instalador: abaixo.
4.  **GUIDs gerados uma única vez** e fixados no repositório, sem regenerar a cada build:
    *   `win32AppId`: `{81F2F38E-A23B-4E67-81B7-A3CE415C243E}`
    *   `win32x64AppId`: `{DC15003A-A672-4DA7-885B-E72CFFE91275}`
    *   `win32UserAppId`: `{32444A51-E808-4C25-8471-888D55D5776D}`
    *   `win32x64UserAppId`: `{0EAE4F44-0B3E-4951-BA97-19DE170F0D01}`
    *   Os nomes dos campos são os que o upstream usar na tag escolhida. Confirmar antes de modificar (diretriz 7).
5.  **Separação.** Dados e configurações do Singularity ficam separados das instalações do VS Code e de outros forks, por pasta de dados e identificadores próprios.
6.  **Troca futura de marca.** Os identificadores técnicos ficam organizados para permitir mudar o nome visível sem perder dados do usuário.
7.  **Registro de alterações.** Cada campo editado em arquivo do upstream entra em `UPSTREAM-TOUCHPOINTS.md`.
8.  **Sobreposição de nome.** Registrada: o nome "Singularity" coincide com o antigo projeto Singularity, atualmente Apptainer, e com SingularityCE. Isso não é proibição automática, mas exige avaliação.
9.  **Pesquisa de marca e conflito de software.** Feita antes da primeira distribuição pública de binários. Não bloqueia builds locais de desenvolvimento.
10. **Repositório público.** Continua público desde o primeiro commit. A verificação de marca não exige desenvolvimento privado.
11. **Ajuste futuro.** A identidade pública pode ser ajustada se houver impedimento jurídico real, sem migração desnecessária antes disso.

**Pendências.**
*   Confirmar os nomes de campos e os identificadores existentes na tag escolhida do Code - OSS.
*   Pesquisa de marca e conflito de software antes de qualquer binário público.
*   Avaliação da sobreposição com Apptainer e SingularityCE (item 8 acima).

### Baseline upstream (decidido pelo dono em 2026-11-02)

**Decisão.** A base do fork é a tag estável `1.144.0` do `microsoft/vscode`, no commit `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`. Não se usa `main`, Insiders nem tag de desenvolvimento como base da primeira compilação.

**Verificado em 2026-11-02.**

*   A tag `1.144.0` existe no repositório oficial e aponta para o commit acima (`git ls-remote`).
*   O `.nvmrc` da tag indica Node `24.22.1`.

**Informado pelo dono, não verificado por mim.** Data da release: 28/10/2026.

**Consequências.**

*   O Node `24.22.1` é candidato natural para o runtime empacotado de K1, por ser o usado pelo próprio build do upstream. Versão final ainda a confirmar.
*   Este valor é registrado também em `docs/upstream-sync.md`, quando o arquivo for criado.

**Investigação aberta sobre o Agent Host Protocol (AHP) 1.0.** A release 1.144 traz o AHP 1.0, um protocolo para conversar com agentes locais e remotos, e um Agent Host capaz de manter sessões fora da janela. Fontes de imprensa e uma cobertura de versão anterior dizem que é MIT, mas não confirmei isso. Antes de qualquer decisão:

*   confirmar no repositório a licença do AHP e do código do Agent Host, separando o que é open source do que depende do Copilot;
*   ler a especificação oficial do protocolo, publicada em microsoft.github.io/agent-host-protocol;
*   avaliar se o hub deve reutilizar o AHP ou manter o JSON-RPC decidido em K3. Qualquer mudança em K1 a K8 só ocorre com decisão do dono, com as evidências apresentadas.

### Primeira compilação limpa do Code - OSS 1.144.0 (2026-11-02)

Clone em `D:\dev\singularity` (remote `upstream`, branch `singularity` no commit `2c33b50b…`), sem nenhuma personalização.

| Etapa | Resultado |
|---|---|
| Ambiente | Node 24.22.1 (igual ao `.nvmrc`), Python 3.13.15 com setuptools, Git 2.56, 348 GB livres em D:, 23,9 GB de RAM, long paths ativos |
| Build Tools | Visual Studio Build Tools 2026 (18.11) instalado por `winget` com UAC: MSVC 14.51.36231, Windows SDK 10.0.26100, Spectre, ATL e MFC. Cerca de 6 minutos. |
| `npm install` | Código de saída 0, cerca de 14 minutos, 42 módulos nativos (`.node`) compilados, sem erro de `node-gyp`. `npm audit` reporta 68 vulnerabilidades em dependências do upstream, sem ação tomada. |
| `npm run compile` | Código de saída 0, cerca de 4,5 minutos, 0 erros de TypeScript. A tag também compila `extensions/copilot`. |
| Execução | `scripts\code.bat` abriu a janela "Code - OSS Dev" com a pasta `D:\dev\singularity` aberta, extension host em execução, 8 processos. O pré-lançamento baixou o Electron e extensões embutidas (`js-debug` e outras) do GitHub. O único erro nos logs é o túnel remoto, esperado em build aberto. |
| Não validado | Edição, terminal e Git de forma interativa: não há automação de interface disponível nesta sessão. O `terminal.log` está vazio porque nenhum terminal foi aberto. |

**Efeitos fora do repositório.** Pastas de dados isoladas em `D:\dev\singularity-data`. O editor criou `%USERPROFILE%\.vscode-oss-shared\sharedStorage\state.vscdb`, fora da pasta isolada. O log da janela mostra um servidor MCP do usuário (`<servidor MCP pessoal>`) carregado pelo editor; a origem dessa configuração não foi investigada.

### Achados sobre o Agent Host Protocol na tag 1.144.0

Verificado no código da tag:

*   O repositório é MIT (`LICENSE.txt`, copyright Microsoft).
*   O Agent Host está no código aberto: `src/vs/platform/agentHost/` com cliente, servidor Node, ponte Electron e transportes remotos (SSH, WSL, túnel, TCP). Há centenas de arquivos. A camada `src/vs/sessions` implementa a "Agents Window", com especificações de sessões, automações e comparações entre harnesses.
*   O AHP trafega por WebSocket com JSON-RPC (README dos testes). A suíte E2E foi desenhada para validar "um programa diferente que fale AHP".
*   Há provedores em `src/vs/platform/agentHost/node/` para `claude/`, `codex/` e `copilot/`. Não há nenhuma menção a OpenCode.
*   Dependências: `@github/copilot-sdk` (1.0.27-unstable) e seu runtime `@github/copilot-sdk-win32-x64`, ambos com o campo de licença "MIT" no `package.json`; `@github/copilot` em `extensions/copilot`. O conteúdo binário desses pacotes não foi inspecionado.

Não verificado: o texto da especificação do AHP; como o servidor do Agent Host é iniciado e se sobrevive ao fechamento da janela; se o provedor Copilot exige autenticação GitHub no build aberto; se o campo "MIT" de um pacote cobre a redistribuição dos binários; a licença de `@github/copilot`.

**Sobreposição com K1 a K8.** Há sobreposição significativa de conceito: processo hospedeiro de sessões, JSON-RPC por WebSocket, replay de estado, diff e checkpoints, transportes remotos e harnesses de terceiros. O que muda a conversa é que o código oficial não cobre o OpenCode e tem escala muito maior do que o hub do v0. Nenhuma decisão K1 a K8 foi alterada.

### Validação do editor, isolamento de dados e comparação AHP versus K1 a K8 (2026-11-02)

**Validação funcional (editor compilado, workspace temporário `D:\dev\singularity-test\ws`).** Comprovado com capturas de tela e arquivos em disco: edição e salvamento de arquivo, terminal integrado (PowerShell 7) executando comando, Source Control reconhecendo o repositório Git (branch `main`, commit no Graph, `hello.txt` M e `terminal-proof.txt` U). Observação: o build aberto mostra, na primeira execução, um modal "Sign in to use GitHub Copilot" e um painel de Chat com botão "Sign In". O login foi recusado.

**Isolamento de dados.**

| Observação | Causa (verificada no código) | Mecanismo de isolamento |
|---|---|---|
| `~/.vscode-oss-shared/sharedStorage` | `appSharedDataHome`, padrão `~/<sharedDataFolderName>` (`environmentService.ts:151-162`). `--user-data-dir` não o cobre. | Flag `--shared-data-dir`, modo portátil (`VSCODE_PORTABLE`) ou `sharedDataFolderName` próprio no `product.json` |
| `~/.vscode-oss-dev/{extensions, argv.json}` | `dataFolderName` (`.vscode-oss`, com sufixo de desenvolvimento). `--extensions-dir` só troca o caminho das extensões. | `dataFolderName` próprio (K8) ou modo portátil |
| MCP `<servidor MCP pessoal>` | Descoberta de MCP de outras ferramentas. A fonte "GitHub Copilot CLI" vem ativada por padrão (`mcpConfiguration.ts`); Claude Desktop, Windsurf e Cursor vêm desativadas. `~/.copilot/mcp-config.json` existe e cita o servidor, e `COPILOT_HOME` não está definido. | Desativar a fonte no padrão de `chat.mcp.discovery.enabled` do produto. Chave exata a confirmar. |

O editor registrou o servidor MCP, mas nenhum servidor foi iniciado: não há `node`, `python`, `uv` nem `npx` entre os descendentes do editor. Nenhuma ferramenta de MCP foi executada e nenhum arquivo de configuração pessoal foi aberto ou alterado (só se conferiu a existência e a presença do nome). O editor também mantém `copilot-runtime.exe` em execução sem login (dois por instância).

**Agent Host: o que existe e o que foi observado ao executá-lo** (servidor independente `agentHostServerMain.js`, só em loopback, agente simulado, sem credenciais, sem conexão de saída observada).

| Tema | AHP / Agent Host na tag 1.144.0 | Relação com K1 a K8 |
|---|---|---|
| Protocolo | JSON-RPC 2.0 sobre WebSocket. `initialize` negocia versão SemVer (aceita 1.1.0, 1.0.0, 0.10.0, 0.9.0; versão inválida devolve o erro `-32005` com a lista suportada). `serverSeq`, `reconnect` com `lastSeenServerSeq` devolvendo `replay` e `missing`. Estado por snapshots e ações. | Cobre quase todo o K3 (versão, sequência, replay, lacunas). |
| Autenticação | Token só pela query `?tkn=`; sem token ou com token errado: 403. `Authorization: Bearer`: 403. `Origin` hostil e `Host` hostil: **aceitos** com o token correto. O servidor imprime o token na URL do log. | Contradiz o K4 em quatro pontos: local do token, validação de `Host` e `Origin`, token no log. |
| Cliente do editor | `webSocketClientTransport.ts:84` monta a URL com `?tkn=` (o `WebSocket` do navegador não aceita cabeçalhos). | Um hub que converse com o editor por este caminho teria de aceitar token na URL, o que o K4 proíbe. |
| Ciclo de vida | Servidor independente encerra quando a entrada padrão fecha. Embutido, roda como processo utilitário do Electron (encerra com o app). A CLI em Rust (`agent host`, `ps`, `stop`, `kill`, `logs`) usa supervisor destacado, arquivo de trava por usuário e ACL de Windows por API nativa (`SDDL`, sem `icacls`). Destacamento com `CREATE_NEW_PROCESS_GROUP \| CREATE_NO_WINDOW`. | Sobrepõe K1 (instância única, destacado). Nenhum Job Object (0 ocorrências): o K2 não é coberto. |
| Provedores | Registro fixo em `agentHostServerMain.ts`: Copilot sempre, Claude e Codex sob condição, simulado por flag. No host em execução: `copilotcli` e `mock`. Nenhuma menção a OpenCode. | O K7 não é coberto. Um provedor OpenCode exigiria implementar `IAgent` e editar o registro em arquivo de núcleo. |
| Diff | Serviços de changeset, checkpoint e Git no host. | Cobre e supera o K6, mas só através dos provedores existentes. |
| Dependências | `@github/copilot-sdk` e runtime Windows: campo MIT. `@openai/codex`: Apache-2.0. `@anthropic-ai/claude-agent-sdk`: "SEE LICENSE IN README.md", que remete aos Termos Comerciais da Anthropic. | O SDK do Claude não é open source e a redistribuição não foi verificada. |
| Licença do repositório | MIT. O protocolo é copiado de um repositório separado (`agent-host-protocol`). | Reuso legalmente possível para o que é MIT. |

**Alternativas.**

*   **A. Hub inteiramente próprio (K1 a K8 como estão).** Mantém independência e o OpenCode. Duplica o que o AHP já especifica (negociação, replay, lacunas, ciclo de vida) e abre mão de interoperar com o editor.
*   **B. Reutilizar o Agent Host como está.** Reaproveita muito código e fica no upstream. Mas não traz OpenCode, mantém o Copilot sempre registrado e o runtime em execução, não cumpre o K4, depende do SDK do Claude (termos comerciais) e acompanha uma superfície que ainda muda (protocolo 1.1.0, SDK "unstable"). Acrescentar o OpenCode exige editar arquivos de núcleo, contra a meta de minimizar alterações no upstream.
*   **C. Híbrido.** O hub próprio continua responsável por execução, Job Objects, OpenCode e identidade (K1, K2, K5 a K8), e passa a falar AHP 1.x como protocolo (no lugar do K3). Permitiria usar a Agents Window e o conjunto de testes de conformidade E2E (desenhado para validar "outro programa que fale AHP"). Custo e viabilidade dependem de verificações abertas abaixo.

**Não verificado (decide a escolha entre A e C).**

*   Se a Agents Window do editor conecta a um host de terceiros sem login GitHub e sem Copilot.
*   Quanto do AHP um hub precisa implementar para essa conexão funcionar (canais, reducers).
*   O texto da especificação do AHP (repositório externo).
*   Se os provedores Claude e Codex funcionam sem Copilot e com qual autenticação.
*   Se a CLI em Rust (`agent host`) pode ser compilada e usada no build aberto (exige toolchain Rust).
*   A redistribuição do SDK do Claude e do binário `copilot-runtime`.

**Reaproveitável em qualquer cenário (sem conflito com K1 a K8).** O método de ACL por SDDL e API nativa de Windows (MIT) como referência para a pendência do K4; as flags de destacamento da CLI como referência para o spike do K1; o desenho do arquivo de trava por usuário; a suíte de conformidade E2E como teste do nosso hub.

### Spike de compatibilidade AHP: Agents Window com host de terceiros (2026-11-03)

Experimento isolado e reversível, sem alterar nenhum arquivo rastreado do upstream (`git status` limpo no commit `2c33b50b…`), sem login no Copilot, só em loopback, com credenciais sintéticas e efêmeras. Dois processos de teste fora do repositório: um **hub de teste** (130 linhas, subconjunto mínimo do AHP, com a autenticação do K4: só `Authorization: Bearer`, `Host` e `Origin` validados, token em URL recusado) e uma **ponte** (45 linhas) que aceita o `?tkn=` efêmero do cliente do editor e fala com o hub por Bearer. A Agents Window foi aberta com `--agents` e configurada só por `chat.remoteAgentHostsEnabled` e `chat.remoteAgentHosts`.

**O que funcionou (comprovado por capturas de tela e logs).**

| Capacidade | Resultado |
|---|---|
| Conectar a um host de terceiros sem Copilot | Funcionou. O comando `Add Remote Agent Host...` e o setting são caminhos oficiais, e um host que não declara `protectedResources` não exige login. |
| Identificar o host e listar a sessão | Funcionou: "Projeto de teste [Singularity (teste)]" com "Sessão de teste". |
| Atualizar estado e exibir eventos | Funcionou: título da sessão, "Working...", barra de progresso e indicador de concluído, em tempo real. |
| Reconexão após queda da conexão | Funcionou: volta em cerca de 1 s, `reconnect` com replay das 2 ações perdidas. |
| Reconexão após reinício do hub | Funcionou: o cliente tentou de novo sozinho, enviou `reconnect` e reassinou os canais. |
| Contrato de segurança do hub e da ponte | 17 de 17 verificações. Token do hub nunca em URL. A ponte recusa `Origin` e `Host` hostis e aceita o `Origin` real do editor (`vscode-file://vscode-app`). |

**O que falhou ou ficou incompleto.**

| Item | Resultado |
|---|---|
| Enviar mensagem pela Agents Window | **Não funcionou.** O seletor de modelos mostra só a aba "Copilot" com "Sign in to see available models". O modelo do hub de teste não aparece, e sem modelo a mensagem não é enviada. Não foi feito login. |
| Transcrição do chat | O corpo do chat ficou vazio, embora o estado da sessão atualizasse. Causa não diagnosticada. |
| Métodos de recurso | O cliente chamou `resourceRead`, `resourceResolve` e `createResourceWatch` dezenas de vezes (lê arquivos da pasta da sessão pelo host). O hub de teste não os implementou. |
| `ping`, `setClientManagedSettingsPermissions` | O cliente os envia. O hub de teste respondeu "não suportado" e a janela continuou funcionando. |
| Erro `agentHostManagement` | Vem do host local do editor, não do hub de teste. Aparece na vitrine de personalização. |

**Acoplamento ao Copilot observado na Agents Window.** Provedor padrão de novas sessões é "Copilot". O seletor de modelos é do Copilot. A extensão `GitHub.copilot-chat` e o host local carregam. A descoberta de túneis exige autenticação. A janela também contou MCPs e skills da configuração pessoal do usuário (2 MCP, 51 skills).

**Isolamento.** `--shared-data-dir` impediu a escrita em `~/.vscode-oss-shared` (arquivo intacto desde a execução anterior).

**Ponte de compatibilidade (token do hub fora da URL).**

*   **Viabilidade:** comprovada, com cerca de 45 linhas, sem alterar o protocolo (encaminha quadros).
*   **Risco residual:** o `connectionToken` da ponte precisa estar no `settings.json` do usuário em texto claro (`chat.remoteAgentHosts`). Mitigado por ser efêmero, separado do token do hub, restrito por `Origin`, e válido só em loopback. Persistir um token longo ali enfraqueceria o K4.
*   **Responsabilidade extra:** a ponte vira mais um componente com autenticação própria, a manter e testar.

**Comparação A versus C, com a regra do dono (grandes modificações no núcleo, autenticação proprietária ou enfraquecimento da segurança tiram o C).**

| Critério | A: hub independente | C: hub próprio com AHP via ponte |
|---|---|---|
| Arquivos do upstream modificados | 0 | 0 para listar, monitorar e reconectar. Enviar mensagens exigiria resolver o seletor de modelos do Copilot (provável patch no núcleo, não avaliado). |
| Código adicional | Hub e painel próprios (itens 10 e 13 do plano) | Hub próprio mais ponte mais implementação de AHP: resumo das 7 chamadas já feitas pelo cliente, mais recursos (`resourceRead`, `resourceResolve`, `createResourceWatch`), estado do chat e outros ainda não medidos |
| Preserva K1 a K8 | Sim | K1, K2, K5 a K8 sim. K3 vira AHP. K4 depende da ponte. |
| Autenticação proprietária | Nenhuma | Observada no seletor de modelos da Agents Window (só a aba Copilot, com pedido de login). **Não foi comprovado** que seja obrigatória para enviar mensagens. |
| Segurança | K4 completo | K4 preservado no hub, token efêmero da ponte em texto claro no `settings.json` |
| Acesso remoto futuro | Gateway próprio (K4) | O cliente de sessões também existe para web e mobile (`sessions.web.main.ts`, `MOBILE.md`), não avaliado |
| Vantagem real do AHP | Nenhuma | Visualização das sessões, status e reconexão prontos, de graça |

**Conclusão do spike.** O experimento confirmou recursos úteis da Agents Window (descoberta de host externo, listagem e acompanhamento de sessões, estado em tempo real, reconexão com replay), mas **não demonstrou uma interface completa e independente de controle de agentes de terceiros**. Na compilação e configuração testadas, o seletor de modelos mostrou só a aba Copilot e a mensagem não foi enviada. A causa, e se há configuração que habilite outros modelos, não foi investigada, e não se afirma que o Copilot seja dependência obrigatória para mensagens.

**Pontos que continuam sem verificação.** Se existe configuração suportada que faça o seletor de modelos listar modelos do host de terceiros (a configuração experimental `allowSignedOutWhenUsable` do host não foi testada); a causa do corpo do chat vazio; o esforço de implementar os métodos de recurso; o texto da especificação do AHP; a viabilidade do cliente web e mobile de sessões.

### Decisão pós-spike: Opção A, hub independente (decidida em 2026-11-03, definitiva para a v0)

**Decisão.** O Singularity Hub próprio segue como arquitetura definitiva da v0, com K1 a K8 inalterados: hub independente do ciclo de vida da IDE, Node.js próprio na distribuição, Job Objects para processos, JSON-RPC 2.0 sobre WebSocket, autenticação Bearer antes do upgrade, TypeScript compilado com `tsc`, diff de alterações observadas durante a sessão, OpenCode por HTTP e SSE como primeiro adapter, identidade Singularity IDE. O protocolo interno não é substituído pelo AHP nesta etapa, e a ponte AHP não entra na v0.

**Futuro do AHP.** A arquitetura híbrida fica registrada como possibilidade futura de interoperabilidade, a retomar quando houver necessidade concreta. As evidências do spike acima são preservadas: descoberta de hosts externos, listagem e acompanhamento de sessões, streaming de estado, reconexão e replay, limitação do seletor de modelos, transcrição vazia e diferenças de autenticação. A investigação do seletor de modelos não continua agora. Nenhum novo ciclo de revisão EGM será aberto para esta escolha.

**Próxima implementação (ordem).**

1.  Preparar o repositório público `Ald3b4r4n/Singularity`, preservando o histórico e as licenças do upstream.
2.  Aplicar a identidade inicial Singularity IDE, reutilizando os GUIDs aprovados no K8.
3.  Isolar os dados e as configurações da nova IDE das instalações existentes.
4.  Entregar a primeira compilação com identidade própria.
5.  Depois, a menor integração funcional do Singularity Hub com a IDE. Sem implementar todos os adapters nem toda a central multiagente de uma vez.
--------------------------------------------------------------------------------

*Drafted with EGM*
