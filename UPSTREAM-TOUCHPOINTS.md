# Edições em arquivos do upstream

Cada arquivo do Code - OSS editado pelo Singularity entra aqui, com o motivo. Quanto menor esta lista, mais barato é sincronizar com o upstream. A lista exata também pode ser obtida do Git:

```bash
git diff --name-only 1.144.0...HEAD
```

Base atual: tag `1.144.0`, commit `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`.

| Arquivo | Motivo | Tag em que foi feita |
|---|---|---|
| `product.json` | Identidade Singularity IDE: nome, pastas de dados (inclusive a compartilhada), protocolo de URL, identificadores do instalador do Windows (GUIDs novos e fixos), URL de relato de problemas. Campos de macOS e Linux acompanham o novo namespace. | 1.144.0 |
| `src/vs/workbench/contrib/mcp/common/mcpConfiguration.ts` | Uma linha: a descoberta automática de servidores MCP da configuração do GitHub Copilot CLI deixa de vir ativada por padrão. Isola a nova IDE de configurações de outras ferramentas. Esta tag não oferece `configurationDefaults` no `product.json` para isso. | 1.144.0 |
| `README.md` | Substituído pelo README do Singularity. | 1.144.0 |
| `resources/win32/*` (`code.ico`, `sessions.ico`, `code_150x150.png`, `code_70x70.png`, 14 `inno-*.bmp`, `VisualElementsManifest.xml`) | Marca Event Minimal: ícone do executável e da barra de tarefas, mosaicos e imagens do instalador. O manifesto passa a usar o fundo `#07080C` e o nome curto `Singularity`. Arquivos binários que o upstream muda raramente. | 1.144.0 |
| `resources/linux/code.png`, `resources/server/code-192.png`, `code-512.png`, `favicon.ico` | Mesmo ícone, para Linux e servidor web (sem rpm `.xpm` nem macOS por enquanto). | 1.144.0 |

## Ainda não tocado, mas previsto

*   Ícones dos tipos de arquivo em `resources/win32/*.ico` (cerca de 25), `resources/linux/rpm/code.xpm` e ícones do macOS.
*   Inclusão das extensões embutidas próprias no build, se o upstream exigir uma lista explícita.
