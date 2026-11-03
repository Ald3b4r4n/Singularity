# Event Minimal: fontes da marca

Identidade visual aprovada do Singularity IDE (ícone Event Horizon refinado, linguagem Quantum Minimal, âmbar `#FFB45E` no escuro e `#A64E05` no claro).

- `icon-gen.js`: única fonte do desenho. Gera o SVG de cada variante (`tile`, `mark`, `mono`; escuro e claro) com formas ajustadas por tamanho (16, 24, 32, 48 e acima).
- `build-icons.cjs`: grava os SVGs em `svg/` (`node build-icons.cjs`).
- `svg/`: SVGs de referência.
- `screenshots/`: capturas do aplicativo real.

Os arquivos rasterizados em `resources/` (ICO, PNG e BMP) saem destes SVGs. O ICO do Windows leva os tamanhos 16, 20, 24, 32, 40, 48, 64, 128 e 256.
