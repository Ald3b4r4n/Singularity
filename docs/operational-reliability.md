# Confiabilidade operacional

Este documento descreve o gerenciamento de processos do Hub e a idempotência persistente dos envios remotos. Ele não muda a
experiência aprovada do Singularity nem do Singularity Remote.

## 1. Processos do Hub

O Hub principal continua ativo depois de fechar a IDE, por projeto. Por isso é normal existirem outros processos do Hub: instâncias de
perfis isolados, instâncias de teste e agentes de sessões. O diagnóstico separa o que é legítimo do que sobrou, sem presumir que todo
processo antigo é órfão.

### Como a identidade é provada

Nenhuma decisão usa só o nome do executável ou o PID. Um Hub se identifica por três fatos independentes:

1. **Linha de comando**: `...\singularity-hub\dist\main.js` rodando no Node da instalação.
2. **Horário de criação** do processo no Windows (muda quando um PID é reutilizado).
3. **Registro de instância**: ao iniciar, cada Hub grava `%LOCALAPPDATA%\Singularity\instances\<pid>.json` (PID, horário de início,
   pasta de estado, identificador da instância) e o remove ao encerrar.

### Classificação

| Papel | Critério | Ação oferecida |
|---|---|---|
| Hub principal | Responde com a prova de identidade e o horário confere | Nenhuma (mantido) |
| Hub de outro perfil / de teste | Registrado, horário confere e a pasta de estado dele aponta para ele e responde | Pedir que ele mesmo encerre (gracioso) |
| Hub órfão | Registrado, horário confere, e a pasta dele não aponta mais para ele, ou aponta e não responde há mais de 2 minutos | Encerrar, com confirmação |
| Hub não verificável | Sem registro, ou o horário não confere com o registro (PID possivelmente reutilizado) | Nenhuma: preservado e explicado |
| Gateway remoto | Confere com `gateway.json` | Nenhuma (use "Desativar acesso remoto") |
| Agente em sessão | O Hub principal reivindica o processo | Nenhuma: encerre pela própria sessão |
| Agente de outro Hub vivo | O processo criador é um Hub vivo e mais antigo que ele | Nenhuma |
| Agente órfão | O criador não existe mais (ou o PID foi reutilizado) e nenhuma sessão o reivindica | Encerrar, com confirmação |
| Terceiros | Qualquer outro processo | Só contados, nunca listados nem tocados |

### Encerramento seguro

- Imediatamente antes de agir, a tabela de processos é lida de novo e o alvo precisa ter o mesmo PID **e** o mesmo horário de
  criação, e continuar classificado como encerrável. Se algo mudou, nada é encerrado.
- Só um PID é encerrado, nunca a árvore. Agentes têm Job Object, que encerra o que o processo iniciou.
- Se houver agentes ou sessões ligados, é preciso uma segunda confirmação explícita; um agente de sessão ativa nunca é oferecido.
- Para um Hub saudável de outra pasta, o caminho é o **encerramento gracioso**: o próprio Hub é chamado (`hub.shutdown`) com as
  credenciais dessa pasta, sem matar nada de fora; com sessões, pede confirmação extra.
- Se um processo não puder ser classificado com segurança, ele é preservado e a limitação é informada.

### Onde usar

- IDE: **Singularity: Processos do Hub** (lista, motivo, recomendação e a ação, só quando é verificável).
- Linha de comando: `node dist/cli.js processes` e `node dist/cli.js terminate <pid> <created> --confirm [--active]`.
- Os métodos `processes.inspect`, `processes.terminate` e `processes.shutdown` existem só no Hub; o gateway **não** os expõe ao celular.

### Hubs antigos observados nesta máquina

Cinco Hubs de 09/11 sem registro (criados antes de existir o registro de instâncias, durante testes E2E). Três deles têm pasta de
estado em `e2e-out` que ainda os reconhece e **respondem**: são Hubs de teste vivos e ociosos, não órfãos. Dois não puderam ser
ligados a nenhuma pasta. Por isso todos ficam como "não verificáveis" e preservados. Uma heurística de "não atende em nenhuma porta"
foi descartada: o Windows desta máquina mascara o dono dos sockets em escuta, e ela condenaria Hubs legítimos.

## 2. Idempotência persistente dos envios do celular

Cada envio tem a identidade **dispositivo + sessão + identificador da requisição** (`X-Request-Id`), e fica vinculado a um digest
HMAC do conteúdo e da sessão (chave aleatória própria da instalação). O texto da instrução não é guardado.

### O que muda em relação à memória

O registro fica em `remote/requests.json` (pasta restrita ao usuário Windows) e é gravado **antes** de o Hub ser chamado. Um
gateway reiniciado, ou morto no meio do envio, continua sabendo o que estava fazendo.

### Estados

`recebida` → `em processamento` → `confirmada` · `falhou antes do envio` · `resultado desconhecido` · `resolvida por reconciliação`.

- **Falhou antes do envio**: o Hub não estava conectado ou recusou a instrução. É seguro tentar de novo com o **mesmo** id.
- **Desconhecido**: a conexão caiu depois de a instrução poder ter chegado ao Hub, ou o gateway parou durante o envio. Nunca é
  reenviado sozinho.
- **Reconciliação**: o gateway procura a instrução no histórico do próprio Hub (mesmo digest, horário posterior ao início do envio).
  Se achar, o envio vira `resolvida por reconciliação` sem enviar nada. Se não achar, continua desconhecido e pede decisão.
- **Decisão da pessoa**: "Verificar de novo", "Reenviar mesmo assim" (libera o mesmo id) ou "Descartar".

### Garantias e limites

- Mesmo id com outro conteúdo ou outra sessão: recusado (409).
- Requisição simultânea com o mesmo id: a segunda recebe "em processamento" (202).
- Registro corrompido ou ilegível: **todos os envios são bloqueados** (503) e o arquivo é preservado; só a reinicialização
  confirmada pela IDE ("Registro de envios remotos") reabre o envio, guardando o arquivo antigo ao lado.
- Falha ao gravar o registro: nada é enviado ao agente.
- Retenção: 48 h para os resolvidos, no máximo 1000 registros; os de estado desconhecido nunca são descartados.
- Um segundo gateway não consegue usar o mesmo registro (trava por arquivo com PID vivo).
- **Isto não é uma garantia de execução "exatamente uma vez".** Se a conexão cai depois de o Hub receber a instrução e antes de
  responder, a única evidência é o histórico do Hub. Quando ele não decide a questão, o estado fica indeterminado e a pessoa decide.
  Um protocolo transacional fim a fim exigiria que o Hub aceitasse o identificador da requisição e o guardasse de forma durável; isso
  não foi implementado.

### No celular

O identificador é criado uma vez, quando a pessoa toca em enviar, e é reutilizado em toda tentativa daquela operação (queda de
conexão, recarga da página, segundo toque), inclusive guardado no navegador. Mensagens: "Tarefa recebida", "Tarefa já registrada",
"Aguardando confirmação", "Estado do envio desconhecido". O streaming continua independente do envio, e o histórico é a única fonte
dos balões, então não há balão duplicado.
