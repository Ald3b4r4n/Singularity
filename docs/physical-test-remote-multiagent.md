# Checklist de teste físico: Comparação e Equipe no POCO X8 Pro

Para o proprietário. Os fluxos abaixo foram validados em navegador emulado e no pacote com agentes reais; falta ver no aparelho. Use um
repositório Git **limpo e de teste** (não o seu projeto real): o Hub exige a árvore limpa e cria cópias isoladas.

**Antes:** a IDE do computador aberta, Tailscale ligado no celular, página `https://antonio-rafael.tail61af49.ts.net` aberta no Chrome
(se for a primeira vez nesta versão, recarregue). Anote a hora de cada falha.

## A. Formulários e catálogo
1. Aba **Comparação** → **Nova comparação**. Os campos de **Provedor** e **Modelo** aparecem preenchidos (OpenCode Go com Muse Spark 1.3 Contributor e DeepSeek V4.1 Flash).
2. Troque o provedor do Agente 1 para **OpenCode Zen**, depois volte para **Go**. Os modelos mudam e não ficam vazios.
3. Toque em **3 agentes**: aparece o terceiro cartão; volte para 2.
4. Com o teclado aberto, escreva a tarefa: o botão **Confirmar e iniciar** continua visível ao rolar e fica ativo só com texto.
5. Aba **Equipe** → **Nova equipe**: Implementador, Revisor e Testador aparecem com modelos diferentes; **Ciclos de correção** tem 0, 1 e 2.
6. Sem rolagem horizontal em nenhuma dessas telas (só o diff rola para o lado).

## B. Comparação de ponta a ponta
1. Tarefa pequena, por exemplo: "Crie o arquivo soma.js com a função soma(a, b)". **Confirmar e iniciar** (toque uma vez).
2. Abre o acompanhamento com 2 agentes "em execução" e a duração correndo. Confira no computador: dois worktrees novos e **uma** comparação.
3. **Ver ao vivo** em um agente: aparece o texto "Agente · ao vivo" crescendo; ao terminar vira o texto final, com uso (tokens).
4. **Ver alterações**: o diff abre; role para o lado só dentro do diff.
5. **Selecionar para revisão** pede um segundo toque. Depois disso, no computador, o projeto principal continua **sem alterações**: aplicar fica só na IDE.
6. Nova comparação com tarefa longa: **Cancelar este agente** (dois toques) cancela só ele; **Cancelar a comparação** deixa nenhum rodando.

## C. Equipe de ponta a ponta
1. Tarefa pequena (ex.: "Crie ehPar.js e um teste simples"). **Confirmar e iniciar**.
2. As etapas Implementador → Revisor → Testador aparecem sozinhas, em forma de conversa: a sua tarefa, e em cada etapa o raciocínio do agente, as ferramentas que ele usa e os arquivos, ao vivo, com uma linha de estado no topo. Problemas do revisor aparecem em lista.
3. Sem perfil de teste cadastrado, a tela diz que a validação independente depende de cadastro **na IDE Windows** e não oferece campo de comando.
4. Na IDE: **Singularity: Perfis de teste do acesso remoto** → cadastrar (por exemplo `node.exe` com `-e process.exit(0)`).
5. De volta ao celular: **Rodar a validação** (dois toques) → a equipe termina como **concluída**.
6. **Ver as alterações da solução** e **Selecionar solução para revisão** funcionam; nada é aplicado ao projeto.

## D. Falhas e recuperação (as que você consegue provocar)
1. **Modo avião por 5 s** com a tela de uma comparação aberta e depois religar: a tela volta sozinha, sem cartões duplicados.
2. **Toque duplo** em **Confirmar e iniciar**: só uma comparação (ou equipe) é criada.
3. Inicie algo e **troque Wi-Fi ↔ dados móveis**: aparece "Aguardando confirmação" ou continua normal; **Tentar de novo** não duplica.
4. Com a equipe rodando, na IDE: **Singularity: Registro de envios remotos**. O resumo não mostra envios "desconhecidos".
5. **Fechar o Chrome e reabrir** o endereço: continua autorizado (não pede pareamento) e mostra o mesmo estado.

## E. O que NÃO deve existir
- Nenhum botão de **aplicar**, **desfazer** ou **shell** no celular.
- Nenhum campo para digitar executável ou comando.
- Nenhum endereço público: o acesso só abre com o Tailscale ligado no celular.

## Resultado
Marque cada item como OK ou anote o que viu (hora e uma captura). Itens D.4 e C.4 dependem da IDE no computador. Se tudo estiver OK,
autorize a atualização da instalação pessoal com o pacote desta versão (commit indicado no manifesto do pré-release).
