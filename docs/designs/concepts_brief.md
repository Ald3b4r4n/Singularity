# Singularity IDE

* **Author:** Ald3b4r4n
* **Date:** 2026-11-02

## Overview

Singularity IDE é uma IDE open source (MIT para o código original, licenças de terceiros respeitadas), gratuita e sem orçamento (R$0), mantida por uma pessoa com ajuda de agentes de IA. É um fork do Code - OSS para Windows 11, com identidade visual própria.

O núcleo do editor fica como está: Monaco, depuração, terminal, Git e a API de extensões. Em volta dele entra uma central multiagente. Ela orquestra, por adaptadores, harnesses que já existem (Claude Code, Codex CLI, OpenCode, Gemini CLI e outros), em execução local. Mostra processos e logs e, mais tarde, compara resultados.

Extensões vêm do Open VSX e de VSIX instalado à mão. O Visual Studio Marketplace não é usado. O acesso remoto pelo Android passa por LAN ou VPN privada (Tailscale ou equivalente) e, na primeira versão, só gerencia sessões.

Filosofia de trabalho: Elephant-Goldfish Model + vibe coding, sem Spec Kit, sem limites artificiais de features ou tasks, com documentação proporcional à complexidade.

**Primeira versão (v0), executável no Windows, deve mostrar:**
1. O fork compilando e rodando.
2. Identidade Singularity perceptível.
3. Abrir e editar projetos.
4. Terminal e Git funcionando.
5. Pelo menos um agente integrado.
6. Execução e resultado desse agente visíveis.
7. Um caminho funcional para instalar extensões de fontes autorizadas.

Fora do v0: todos os provedores, o acesso remoto completo, marketplace próprio, instalador assinado e auto-update.

## Analysis

Seis revisores Goldfish (`egm-design`, `egm-codebase-details`, `egm-zoom-out`, `egm-comprehension`, `egm-implementation-readiness`, `egm-structural`) avaliaram a hipótese em contextos independentes, coordenados por `egm-synthesizer`. Eles leram só o texto do conceito. O diretório do projeto está vazio, então nada foi checado contra o código real do upstream nem contra os termos atuais dos provedores. Itens marcados *(não verificado)* vêm da memória dos revisores e precisam de conferência.

Os rótulos abaixo são recomendações dos revisores, filtradas pelo sintetizador. Não são requisitos automáticos. A decisão final é do dono.

### Bloqueios reais (REAL BLOCKER)

São decisões baratas, de uma linha ou um parágrafo, que custam caro se ficarem para depois.

| # | Achado | Por que bloqueia | Saída sugerida |
|---|---|---|---|
| B1 | "Interface totalmente custom" contradiz "baixo custo de sync". Layout, parts e menus são os arquivos do upstream que mais mudam. | Define quanto custa cada atualização do upstream. | Reenquadrar: personalizar primeiro por pontos de contribuição, tema, CSS e built-in extensions. Substituir partes do layout só quando necessário e só atrás de flag. Listar toda edição de core. |
| B2 | O hub de agentes dentro do workbench ou do extension host. | Sessões morrem ao fechar a janela, e o Android teria que reimplementar o hub. Quatro revisores chegaram a isso sozinhos. | Hub como processo separado (daemon), com API local versionada em 127.0.0.1. IDE e Android são clientes. No v0 o daemon é destacado da IDE, com uma instância por usuário, e sobrevive ao fechamento da janela (decisão do dono em 2026-11-02, que substitui a ideia anterior de processo filho). |
| B3 | Sem regra de camadas de customização. | Sem regra, um agente edita arquivos core e todo sync vira conflito. | Três camadas: código aditivo em `contrib/singularity`, built-in extensions e overlay de `product.json`, e por último patches. Cada arquivo upstream tocado vai em `UPSTREAM-TOUCHPOINTS.md`. |
| B4 | Contrato de harness e premissa "assinatura não é crédito de API". | Define se a ideia central é permitida pelos termos dos provedores. | O hub só lança a CLI oficial instalada pelo usuário. O login é feito na CLI. O hub nunca lê, guarda, copia nem repassa token. Modo API-key é separado e explícito. Cada adapter tem uma nota com os termos lidos e a data. |
| B5 | Termos dos provedores não foram lidos por ninguém. Um revisor lembra que a Anthropic restringe credenciais de assinatura a Claude Code e claude.ai, e que terceiros foram bloqueados em janeiro de 2026 *(não verificado)*. | Se for verdade, um adapter Claude via SDK com OAuth de assinatura é proibido. | Ler os termos atuais antes de escolher o primeiro adapter. |
| B6 | "Harness" mistura categorias: GLM Coding Plan é plano de provedor, OpenCode Go e Zen são planos do OpenCode, Antigravity é um fork de IDE sem contrato headless estável, e "Muse Code" é desconhecido dos revisores. | Um adapter por nome não representa a realidade e leva a retrabalho. | Modelar Harness × perfil Provider/Auth. |
| B7 | Itens 5 e 6 do v0 não têm critério de pronto. | São o núcleo do v0. | Escrever um teste de aceite observável por item (ver Decisões). |
| B8 | Branding da Microsoft no binário. | Distribuir com nome, ícone ou GUID da Microsoft viola marca ou colide com o VS Code real. | Trocar `nameShort`, `nameLong`, `applicationName`, `dataFolderName`, `urlProtocol` e os GUIDs `win32*`. Bloqueia só binário público, não o desenvolvimento local. |
| B9 | Frase de compatibilidade com extensões. | Decide a profundidade do fork e se o Open VSX funciona. | "Extensões que rodam no Code - OSS stock continuam funcionando." |

**Bloqueios condicionais:**
- Segurança do acesso remoto: só bloqueia quando o trabalho de remote começar. Aprovar e rejeitar operações precisa de modelo definido antes disso (ver Riscos).
- Assinatura de código: só bloqueia distribuição pública ampla.

### Riscos aceitáveis (ACCEPTABLE RISK)

- Sync semi-automático, não 100% automático. Fixar uma tag estável do upstream, nunca `main`, e sincronizar a cada 2 a 3 meses. Seguir os bumps de Electron por segurança.
- Atraso de segurança por usar tag fixada (Chromium e Electron mais antigos).
- Método de sync (merge de tags ou patch queue): os revisores divergiram. O que importa é o tamanho do footprint.
- Extensões proprietárias da Microsoft ficam indisponíveis (Pylance, C# Dev Kit, Remote-*, Live Share). Documentar alternativas.
- Open VSX tem lacunas: extensões ausentes ou defasadas, APIs propostas e sem verificação de assinatura.
- VSIX baixado do GitHub só vale se for publicado pelo próprio autor, ou vier do Open VSX.
- Toolchain Windows pesado (Node do `.nvmrc`, VS 2022 Build Tools com C++, Spectre, ATL, Windows SDK, Python 3, 30 GB ou mais de disco, 16 GB de RAM). Clonar em caminho sem espaços, porque `<pasta de trabalho do design>` e o perfil do usuário têm espaço e podem quebrar node-gyp e gulp.
- Build completo leva 30 a 60 minutos. Build local no v0, CI depois.
- Sem assinatura, o instalador dispara SmartScreen e o Smart App Control do Windows 11 pode bloquear. No v0 o uso é a partir do fonte ou zip portátil.
- Telemetria: verificar com grep de endpoints externos após o primeiro build.
- Chat, agent mode e MCP embutidos no upstream podem duplicar o hub (conferir no tag escolhido).
- Paralelismo consome cota e pode bater em rate limit. Duas escritas na mesma árvore colidem. No v0 vale aviso visível, sem teto.
- Sem sandbox de SO no v0. Checkpoint Git antes de cada execução.
- Aprovar e rejeitar: cada CLI tem modelo de permissão próprio. Um botão único pode mentir sobre o que aprova. No v0, "approvals unsupported" é estado legal do contrato.
- Colisão do nome "Singularity" com o Apptainer *(não verificado)*.
- Antares e Capella entram como extensões comuns, em pacotes separados.
- Detalhes do Windows: Claude Code nativo precisa de Git Bash ou WSL, o sandbox do Codex no Windows é experimental, e é preciso matar a árvore de processos (`taskkill /T`).

### Melhorias futuras (FUTURE IMPROVEMENT)

- Automação do sync (Action agendada que tenta o merge, builda e abre PR). Só depois de dois syncs manuais.
- Auto-update. Correção factual de um revisor: o VS Code no Windows usa Inno Setup e `inno-updater`, e o servidor de update precisa responder `/api/update/<platform>/<quality>/<commit>`. Um Releases estático não basta.
- Assinatura via SignPath Foundation (precisa de aprovação). Azure Trusted Signing é pago e pode não atender o Brasil *(não verificado)*.
- Gerenciador central de MCP, skills e plugins: registry canônico com exportação unidirecional por adapter, ou começar só leitura.
- Comparação lado a lado, colaboração entre agentes e worktrees.
- Acesso remoto: PWA servida pelo daemon, pareamento por dispositivo, token revogável, audit log, TLS, whitelist de operações de sessão.
- Marketplace próprio.
- Smoke test da IDE, contract tests com CLI fake, parser de eventos testado com fixtures gravadas.
- Log de eventos por sessão e botão "copy diagnostics".
- Definições curtas de harness, Antares e Capella; link do EGM.

## Goals vs. Non-Goals

* **In-Scope Goals (v0):**
  * Fork do Code - OSS compilando e rodando no Windows 11.
  * Identidade visual Singularity perceptível (nome, ícones, tema, welcome).
  * Editor, terminal e Git herdados do upstream, funcionando.
  * Daemon do hub com contrato de adapter mínimo e um primeiro adapter.
  * Painel do hub dentro da IDE com log em streaming, resultado e arquivos alterados, e botão de parar o agente.
  * Open VSX como gallery e instalação de VSIX.
* **Out-of-Scope Non-Goals (v0):**
  * Reescrever Monaco, depuração ou o extension host.
  * Todos os provedores. Acesso remoto completo. Editor remoto.
  * Marketplace próprio. Auto-update. Assinatura de código. CI obrigatório.
  * Gerenciador MCP/skills com escrita.
  * Worktrees automáticos, colaboração entre agentes, comparação lado a lado.
  * Linux e macOS.

## Alternatives Weighed

| Alternativa | Resultado | Motivo |
|---|---|---|
| Só extensão sobre VS Code ou VSCodium stock | Rejeitada como destino. Mantida como forma do hub e como gate. | Não entrega workbench nem identidade profundos, mas é o caminho mais barato para o hub. O hub nasce como extensão de qualquer forma. |
| App Electron próprio embutindo Monaco | Rejeitada | Perde depuração, terminal, Git, extension host e compatibilidade. São meses de retrabalho. |
| Theia | Rejeitada | Compatibilidade parcial com extensões VS Code *(não verificado)*, ecossistema menor, e o dono quer a base Code - OSS. |
| Fork baseado no VSCodium | Aberta | Reaproveita remoção de branding e telemetria, Open VSX e scripts de build. Falta decidir entre fork do VSCodium e fork direto do Code - OSS reusando os patches dele. |
| Merge de tags num fork real do GitHub | Em aberto | Defendida por dois revisores: o repo é público desde o primeiro commit, reescrever histórico é caro. |
| Patch queue sobre tag fixada | Em aberto | Defendida por dois revisores: mais robusta para um desenvolvedor solo, mas quebra quando um hunk falha. |
| Bot de sync customizado agora | Rejeitada | O conflito vem do footprint, não do método. |
| Hub no extension host | Rejeitada | Morre com a janela e impede o remote. |
| Scraping de PTY como único transporte | Rejeitada como única via | Frágil e sem approve/reject confiável. Fica como fallback. |
| Reusar tokens OAuth das CLIs ou agrupar contas | Rejeitada | Padrão típico de violação de termos. |
| Transporte remoto próprio | Rejeitada no v0 | Nova superfície de ataque. Usar rede privada. |
| Marketplace próprio agora | Rejeitada | Novo serviço, conflita com R$0. A gallery é uma configuração do `product.json`. |
| Apontar a gallery para o Marketplace da Microsoft | Rejeitada | Contorna os termos. |
| Certificado de assinatura pago | Rejeitada | R$0. |

## Key Decisions & Staging for Next Steps

### Decisões propostas (aguardam confirmação do dono)

1. Reenquadrar "interface totalmente custom" em "personalizar por contribution points, tema e CSS; substituir parts do layout só quando necessário, atrás de flag". Cada edição de core entra em `UPSTREAM-TOUCHPOINTS.md`.
2. Contrato de extensões: o que roda no Code - OSS stock continua rodando.
3. Hub como daemon separado, API local versionada, bind em 127.0.0.1. No v0 o daemon é destacado da IDE, com uma instância por usuário, e sobrevive ao fechamento da janela (decisão do dono em 2026-11-02, que substitui a ideia anterior de processo filho).
4. Contrato de adapter: CLI oficial do usuário, login na CLI, o hub nunca toca em token. Campo `auth` por adapter (`vendor-cli-login`, `api-key` ou `none`) visível na UI. Nota de termos com data em `docs/adapters/<nome>.md`.
5. Interface mínima do adapter: iniciar, parar, enviar, stream de eventos, status de auth, capabilities, approve/reject opcionais. O contrato comum só é extraído depois do segundo adapter.
6. Tag base estável do upstream, nunca `main`. Sync manual a cada 2 a 3 meses no início, mais bumps de Electron.
7. Identidade de distribuição própria (nome, pasta de dados, GUIDs, protocolo). Gallery só Open VSX. Sem endpoints de telemetria ou update da Microsoft.
8. v0 roda a partir do fonte na máquina do dono. Instalador, assinatura e auto-update depois.
9. Critério de aceite por item do v0, por exemplo para os itens 5 e 6: "disparo o agente X num projeto, vejo o log em streaming e o diff dos arquivos alterados no painel, e consigo parar o agente".
10. Gate fork vs extensão: listar quais itens do v0 exigem editar o core. Se a lista for curta, o fork profundo espera.

### Marcos sugeridos (ordem, não limite)

- **M0:** ambiente, clone da tag em caminho sem espaços, remotes, README, LICENSE, `UPSTREAM-TOUCHPOINTS.md`.
- **M1:** `npm install`, compilar e rodar sem alteração (item 1). Cronometrar.
- **M2:** `product.json`, ícones, tema, welcome e Open VSX (itens 2 e 7).
- **M3:** abrir e editar projeto, terminal, Git (itens 3 e 4).
- **M4:** daemon e primeiro adapter, rodando um prompt por script.
- **M5:** painel do hub com log, resultado e botão de parar (itens 5 e 6).
- **M6:** build empacotado ou portátil, testado em perfil limpo.
- **M7:** tag v0.1.0 e ensaio de sync com a próxima tag do upstream.

### Perguntas em aberto para o dono

1. Aceita sync semi-automático e o reenquadramento da frase "interface totalmente custom"?
2. Merge de tags num fork real ou patch queue?
3. Base: fork direto do Code - OSS ou fork do VSCodium?
4. Qual é o primeiro agente? Quem lê os termos atuais de Anthropic, OpenAI, Google, Z.ai e do Muse Code antes do adapter?
5. Algum adapter em modo API-key já no v0?
6. O que aprovar e rejeitar controla: repasse do prompt da CLI ou política do hub?
7. Reusar ou desligar o chat, agent mode e MCP embutidos no tag escolhido?
8. Mantém o nome "Singularity" apesar da colisão possível com o Apptainer?
9. Antares e Capella: built-in, pré-instalados ou só no Open VSX? Que licença cada um tem?
10. Quanto disco livre e RAM a máquina tem? Aceita clonar fora de `<pasta de trabalho do design>`?
11. O remote precisa funcionar sem Tailscale (WireGuard, Headscale, LAN)?
12. Qual a ordem depois do v0?

### Pendências de verificação antes de decidir

- Termos atuais dos provedores.
- Campos reais do `product.json` e o conteúdo de chat/Copilot/MCP no tag escolhido.
- Colisão de nome.
- Licenças de Antares e Capella.
