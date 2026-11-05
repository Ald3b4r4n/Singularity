'use strict';

// Packaged Windows smoke test. Pass a fixture containing the three managed CLI installations and no logins.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const ui = require('./lib.cjs');

const [exe, installed, root] = process.argv.slice(2);
if (!exe || !installed || !root || fs.existsSync(root)) { throw new Error('Pass the EXE, signed-out installation fixture and a new output directory.'); }
const profile = path.resolve(root, 'profile');
const workspace = path.resolve(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const port = 35000 + Math.floor(Math.random() * 3000);

async function main() {
	let browser, hub;
	try {
		const env = {
			LOCALAPPDATA: path.resolve(installed, 'local'), APPDATA: path.resolve(installed, 'roaming'),
			USERPROFILE: path.resolve(installed, 'user'), HOME: path.resolve(installed, 'user'),
			CODEX_HOME: path.resolve(installed, 'user/.codex'), CLAUDE_CONFIG_DIR: path.resolve(installed, 'user/.claude'),
			PATH: process.env.SystemRoot + '/System32', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
			CODEX_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', SINGULARITY_HUB_HOME: path.resolve(root, 'hub'),
			SINGULARITY_OPENCODE: '', SINGULARITY_CLAUDE_CODE: '', SINGULARITY_CODEX_CLI: ''
		};
		Object.assign(process.env, env);
		const dist = path.join(path.dirname(exe), 'resources/app/singularity-hub/dist');
		hub = await require(path.join(dist, 'instance.js')).startHub({ home: env.SINGULARITY_HUB_HOME });
		assert.equal(hub.kind, 'started');
		ui.launch({ exe, profile, workspace, port, env, settings: { 'singularity.update.checkAutomatically': false } });
		await ui.waitPage(port);
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
		const page = browser.contexts().flatMap(context => context.pages()).find(tab => tab.url().includes('workbench'));
		assert(page);
		await page.locator('.statusbar-item').filter({ hasText: /Agentes/ }).first().waitFor({ timeout: 90000 });
		const row = label => page.locator('.quick-input-list-entry:visible').filter({ hasText: label }).first();
		await ui.sleep(5000);
		await page.keyboard.press('F1');
		await page.locator('.quick-input-widget input:visible').first().fill('>Singularity: Gerenciar provedores');
		await row('Gerenciar provedores').click();
		for (const name of ['Codex CLI', 'Claude Code']) {
			await page.locator('.quick-input-list-entry:visible').filter({ hasText: name })
				.filter({ hasText: 'Autenticação necessária' }).first().waitFor({ timeout: 90000 });
		}
		await page.screenshot({ path: path.join(root, 'autenticacao-necessaria.png') });
		await row('Codex CLI').click();
		await row('Conectar conta').click();
		await row('Entrar pelo navegador').waitFor();
		await row('Usar código de dispositivo').waitFor();
		await page.screenshot({ path: path.join(root, 'opcoes-de-login.png') });
		await page.keyboard.press('Escape');
		console.log('Packaged IDE reports signed-out Claude and Codex and offers browser/device authentication without a command.');
	} finally {
		await browser?.close().catch(() => undefined);
		await ui.closeApp(profile);
		if (hub?.kind === 'started') { await hub.release(); }
	}
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
