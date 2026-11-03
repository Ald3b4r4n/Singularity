# Singularity Event Minimal Themes

Built-in color themes of the Singularity IDE: **Event Minimal Dark** (default) and **Event Minimal Light**.

- `themes/*.json` are generated. Edit the palette in `scripts/generate-themes.cjs` and run `node scripts/generate-themes.cjs`, which also prints the WCAG contrast of the key pairs.
- The default theme comes from `contributes.configurationDefaults`. It does not override a theme the user already chose.
- Amber is the only accent: focus, caret, active line number, active tab and activity-bar indicator, primary buttons, badges. Status bar, sidebars and panels stay neutral.
