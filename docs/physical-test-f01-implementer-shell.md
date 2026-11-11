# Checklist de teste físico da F01: terminal do Implementador

Para o proprietário. Este pacote é um candidato (`0.1.0-preview.11`); a base aprovada continua sendo a `0.1.0-preview.10` (`7c16657`).
Use um repositório Git **limpo e de teste**. Anote a hora de cada falha e mande uma captura.

**Antes:** instale o pacote candidato em uma pasta de teste ou atualize a instalação com `update-personal-install.ps1` (ele faz backup e
imprime o comando de volta). Abra a IDE na pasta de teste. No celular, recarregue a página do acesso remoto.

## A. Modo restrito (o padrão)
1. Na IDE, a barra de estado mostra **Implementador: Restrito**. Um projeto que você nunca configurou começa assim.
2. No celular, **Equipe → Nova equipe**: aparece "Terminal do Implementador neste projeto — Restrito: edita arquivos, não usa o terminal".
3. Não há, no celular, nenhum controle que mude esse modo.
4. Inicie uma equipe pedindo "rode `node --version` e grave a saída em versao.txt". O Implementador **não** executa o comando.

## B. Ativar o modo desenvolvimento (só na IDE)
1. Paleta de comandos → **Singularity: Modo de execução do Implementador (terminal)**.
2. Escolha **Desenvolvimento** e depois **Não autorizar operações externas**. Aparece um aviso modal; confirme.
3. A barra de estado passa a mostrar **Implementador: Desenvolvimento**.
4. Com uma equipe trabalhando, tente mudar o modo: a IDE recusa e explica que é preciso esperar a equipe terminar.

## C. Execução real, falha e correção
Em um projeto com um teste que falha (por exemplo `soma.js` devolvendo `a - b` e um teste esperando `5`):
1. No celular, inicie uma equipe: "O teste falha. Rode `npm test`, corrija e rode de novo até passar."
2. Na conversa, a etapa do Implementador mostra **Executando** com o comando, o selo **saída 1** na falha e **saída 0** depois da correção.
3. Toque em **O que o comando mostrou**: aparece a saída real do teste, sem caminhos da sua máquina.
4. No computador, o projeto principal continua **sem alterações** enquanto a equipe trabalha.

## D. Revisão e validação independentes
1. Depois do Implementador, o **Revisor** e o **Testador** aparecem na conversa com seus pareceres; neles não há linha "Executando".
2. A equipe para em **aguardando validação**. O teste que o agente rodou **não** conta como validação independente.
3. Com um perfil de teste cadastrado na IDE, **Rodar a validação** (dois toques) conclui a equipe.

## E. Cancelamento
1. Inicie uma equipe: "Rode `ping 127.0.0.1 -n 300` e espere terminar."
2. Quando aparecer **Executando ping…**, toque em **Interromper a equipe** (dois toques).
3. No Gerenciador de Tarefas do Windows, não fica nenhum `PING.EXE` dessa equipe.

## F. Operações externas
1. Com "Não autorizar operações externas": peça "rode `git push --dry-run`". O comando é recusado e o agente diz o que falta autorizar.
2. Na IDE, mude para **Desenvolvimento + Autorizar operações externas** (novo aviso modal). Só então um deploy ou `git push` pode acontecer.
3. Lembre: esse bloqueio é uma lista de comandos conhecidos, não uma barreira de segurança.

## G. Modo autônomo (opcional, só em projeto seu)
1. Na IDE, escolha **Autônomo** e leia o aviso: o agente roda comandos com a sua conta do Windows, sem pedir aprovação.
2. A barra de estado mostra **Implementador: Autônomo**; o celular mostra "Autônomo: usa o terminal sem pedir aprovação".
3. Volte para **Restrito** ao terminar o teste.

## H. O que não pode mudar
- Sessões antigas, dispositivos pareados e workspaces autorizados continuam como estavam.
- O acesso remoto continua só pela tailnet.
- Conversa da equipe, campo de resposta no fim, botão de descer e menu ⋮ funcionam como na versão aprovada.
- O celular não tem campo de comando, nem botão de aplicar ou desfazer.

## Limitações conhecidas desta versão
- A execução real foi verificada com **OpenCode** (modelos do OpenCode Go). No **Claude Code** e no **Codex CLI** a política usa as
  opções oficiais de cada ferramenta, mas não foi exercitada com inferência real neste ciclo.
- No **Codex CLI**, o modo restrito não consegue proibir comandos dentro da cópia de trabalho (a ferramenta não tem essa opção): ali vale
  a instrução dada ao agente. O bloqueio de operações externas, no Codex, também é só instrução.
- O detalhe ao vivo de cada comando (saída e código) aparece para agentes OpenCode.
- A cópia de trabalho da equipe não é uma sandbox: um comando pode ler ou alterar arquivos fora dela.

## Resultado
Marque cada item como OK ou anote o que viu. A F01 só é aprovada com o seu aceite físico.
