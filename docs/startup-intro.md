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

`Esc`, `Enter`, `Espaço` ou um clique pulam a abertura. Se algo falhar ao desenhar, o overlay é removido e a IDE abre normalmente. Há um limite de 20 s.

## Desempenho

Todas as animações são finitas, de transform/opacidade em camadas HTML, e a cena fica parada depois de cerca de 4 s. Sem vídeo, sem imagens, sem rede, sem áudio.

Medido em modo desenvolvimento (carregamento sem empacotamento, cerca de 7,7 s até o editor restaurado), mediana de 3 execuções por modo, `code/didRestoreEditors` no renderer:

| Modo | Mediana | Diferença para "off" |
|---|---|---|
| off | 7739 ms | referência |
| quick | 7876 ms | +137 ms |
| full | 7982 ms | +243 ms |
| static | 7742 ms | +3 ms |

Uma primeira versão (efeitos de mistura e máscara, animações infinitas) custava cerca de +500 ms; as mudanças acima a reduziram. Os números de uma build empacotada ainda não foram medidos.

## Peças do upstream tocadas

Ver `UPSTREAM-TOUCHPOINTS.md`.
