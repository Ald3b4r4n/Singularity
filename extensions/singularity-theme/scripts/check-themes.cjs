// Regression check for the generated themes. Run: node scripts/check-themes.cjs
const fs = require('fs'), path = require('path'), assert = require('assert');
const { P, build } = require('./generate-themes.cjs');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const HEX = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;
let checked = 0;

for (const [key, palette] of Object.entries(P)) {
	const file = path.join(root, 'themes', `event-minimal-${key}.json`);
	const text = fs.readFileSync(file, 'utf8');
	const theme = JSON.parse(text);

	// the theme kind must be dark/light and agree with the contributed uiTheme
	assert.ok(['dark', 'light'].includes(theme.type), `${key}: type must be dark or light, got ${theme.type}`);
	assert.strictEqual(theme.type, key, `${key}: type does not match the file name`);
	const contributed = pkg.contributes.themes.find(t => t.path === `./themes/event-minimal-${key}.json`);
	assert.ok(contributed, `${key}: theme is not contributed by package.json`);
	assert.strictEqual(contributed.uiTheme, key === 'dark' ? 'vs-dark' : 'vs', `${key}: uiTheme mismatch`);

	// the syntax type color and the semantic token colors survive the palette rename
	assert.ok(HEX.test(palette.typeColor), `${key}: palette.typeColor missing`);
	assert.strictEqual(theme.semanticTokenColors.class, palette.typeColor, `${key}: semantic class color`);
	assert.strictEqual(theme.semanticTokenColors.type, palette.typeColor, `${key}: semantic type color`);
	assert.strictEqual(theme.colors['editorBracketHighlight.foreground3'], palette.typeColor, `${key}: bracket color`);
	assert.strictEqual(theme.tokenColors.find(t => t.scope.includes('entity.name.type')).settings.foreground, palette.typeColor, `${key}: tokenColors type`);

	// every color is a valid hex value
	for (const [name, value] of Object.entries(theme.colors)) { assert.ok(HEX.test(value), `${key}: bad color ${name}=${value}`); }

	// the committed file is exactly what the generator produces (reproducible)
	assert.strictEqual(text, JSON.stringify(build(palette), null, '\t') + '\n', `${key}: themes/*.json are out of date, run generate-themes.cjs`);
	checked++;
}
console.log(`ok: ${checked} themes checked`);
