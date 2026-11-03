# Abertura do Singularity

Sequência de abertura (Event Minimal) desenhada na inicialização real da janela, antes do workbench ser importado. Não é uma página aberta depois.

## Como funciona

1. `src/vs/code/electron-browser/workbench/workbench.ts` chama `showSingularityIntro()` logo depois do splash das partes. O módulo `singularityIntro.ts` cria um overlay (`#singularity-intro`) por cima da janela.
2. A contribuição `src/vs/workbench/contrib/singularityIntro/electron-browser` faz duas coisas:
   - registra a configuração `singularity.startup.intro` e a copia (junto com `workbench.reduceMotion`) para o `localStorage`, que o bootstrap consegue ler antes de existir qualquer configuração;
   - avisa o overlay quando o workbench é restaurado (`singularity:workbench-restored`).
3. Quando o workbench está pronto, o overlay passa a deixar cliques passarem, cumpre o tempo mínimo da sua variante e some com um fade. **O workbench nunca espera pelo overlay.**
4. A decisão de qual variante tocar é uma função pura (`src/vs/base/common/singularityIntroLogic.ts`), testada em `scripts/singularity-intro.test.mjs`.

## Variantes

| Variante | Quando | Tempo mínimo visível |
|---|---|---|
| `full` | primeira abertura, ou `always` | 3,6 s |
| `quick` | demais aberturas (`firstRun`) ou `quick` | 0,65 s |
| `static` | movimento reduzido (OS ou `workbench.reduceMotion: on`) | 0,35 s |
| `none` | `off`, alto contraste, testes automatizados | nenhuma |

Configuração `singularity.startup.intro`: `firstRun` (padrão), `always`, `quick`, `off`. O valor vale a partir da próxima abertura. Comando: **Replay the Opening** (F1) toca a versão completa numa janela já aberta.

`Esc`, `Enter`, `Espaço` ou um clique pulam a abertura. A dica "Pressione Esc para pular" aparece em português quando o idioma do usuário ou do Windows é português (lido de `VSCODE_NLS_CONFIG`, porque o bootstrap roda antes do carregamento do NLS); caso contrário, em inglês. Se algo falhar ao desenhar, o overlay é removido e a IDE abre normalmente. Há um limite de 20 s.

## Desempenho

Todas as animações são finitas, de transform/opacidade em camadas HTML, e a cena fica parada depois de cerca de 4 s. Sem vídeo, sem imagens, sem rede, sem áudio.

Medido em modo desenvolvimento (carregamento sem empacotamento, cerca de 7,7 s até o editor restaurado), mediana de 3 execuções por modo, `code/didRestoreEditors` no renderer:

| Modo | Mediana | Diferença para "off" |
|---|---|---|
| off | 7739 ms | referência |
| quick | 7876 ms | +137 ms |
| full | 7982 ms | +243 ms |
| static | 7742 ms | +3 ms |


### Build empacotado local (minificado, `vscode-win32-x64-min`)

Mediana de 4 execuções por modo; `code/didRestoreEditors` (editor restaurado, IDE utilizável) e o instante em que o overlay termina, ambos em ms desde o início do renderer:

| Modo | Editor restaurado | Diferença para "off" | Overlay termina |
|---|---|---|---|
| off | 953 | referência | sem overlay |
| quick | 993 | +40 | 1403 |
| full | 1017 | +64 | 4648 |
| static | 949 | -4 (ruído) | 1325 |

Carregamento (`didLoadWorkbenchMain`) ficou entre 709 e 748 ms nos quatro modos. Portanto:

- **Tempo de carregamento:** a abertura soma de 0 a cerca de 65 ms até o editor ficar utilizável.
- **Tempo de exibição do overlay:** em `full` o overlay fica 2,4 s além do ponto em que a IDE já está utilizável (3,6 s de mínimo menos cerca de 1,0 s de carregamento, mais o fade). Nesse intervalo os cliques passam pelo overlay e `Esc` o encerra. Em `quick` ele sai cerca de 0,4 s depois.
- Na primeira execução do build empacotado, a sequência completa foi registrada a 51 quadros por segundo (250 quadros em 4,9 s).

Medições feitas com a janela real, via DevTools (marks de performance), sem instalador. O build foi gerado só para teste local e não foi publicado.
Uma primeira versão (efeitos de mistura e máscara, animações infinitas) custava cerca de +500 ms; as mudanças acima a reduziram. Os números de uma build empacotada ainda não foram medidos.

## Peças do upstream tocadas

Ver `UPSTREAM-TOUCHPOINTS.md`.

## Continuidade depois da abertura

A tela de editor vazio mostrava a marca d'água do VS Code logo depois da abertura. Os quatro arquivos letterpress-*.svg agora desenham a marca Event Minimal (gerada por randing/event-minimal/icon-gen.js, variante mono). Os atalhos da tela continuam. Capturas em randing/event-minimal/startup/ (`marca-dagua-*.png` e `transicao-abertura-para-editor.png`).

Limite conhecido: na primeira abertura de um perfil novo, o workbench pinta por alguns instantes com o tema padrão do Code - OSS antes de a extensão Event Minimal registrar o tema; isso acontece sob o fade da abertura (um tom um pouco mais cinza por cerca de 0,3 s). Nas aberturas seguintes as cores guardadas do splash evitam isso.
