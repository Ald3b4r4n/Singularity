'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { chromium } = require('playwright');
const WebSocket = require('../../singularity-hub/node_modules/ws');
const { HubConnection } = require('../../singularity-hub/dist/client.js');
const ui = require('./lib.cjs');

const exe = process.argv[2];
const root = process.argv[3] && path.resolve(process.argv[3]);
if (!exe || !root || fs.existsSync(root)) { throw new Error('Pass the packaged EXE and a new fixture directory.'); }
const home = path.join(root, 'hub');
const profile = path.join(root, 'profile');
const workspace = path.join(root, 'workspace');
const isolatedUser = path.join(root, 'user');
const local = path.join(root, 'local');
const roaming = path.join(root, 'roaming');
for (const directory of [workspace, isolatedUser, local, roaming]) { fs.mkdirSync(directory, { recursive: true }); }
const env = {
	SINGULARITY_HUB_HOME: home, LOCALAPPDATA: local, APPDATA: roaming, HOME: isolatedUser, USERPROFILE: isolatedUser,
	PATH: path.join(process.env.SystemRoot, 'System32'),
	XDG_CONFIG_HOME: path.join(isolatedUser, 'config'), XDG_DATA_HOME: path.join(isolatedUser, 'data'),
	XDG_CACHE_HOME: path.join(isolatedUser, 'cache'), CODEX_HOME: path.join(isolatedUser, '.codex'),
	CLAUDE_CONFIG_DIR: path.join(isolatedUser, '.claude')
};
for (const key of ['SINGULARITY_NODE_PATH', 'SINGULARITY_OPENCODE', 'SINGULARITY_CLAUDE_CODE', 'SINGULARITY_CODEX_CLI',
	'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENCODE_CONFIG']) {
	env[key] = '';
}

async function until(fn, description, ms = 30000) {
	const end = Date.now() + ms;
	do {
		const value = await Promise.resolve().then(fn).catch(() => undefined);
		if (value) { return value; }
		await ui.sleep(250);
	} while (Date.now() < end);
	throw new Error('Timed out: ' + description);
}

async function composer(port, expression) {
	for (const target of (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(item => item.type === 'iframe')) {
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		try {
			await once(socket, 'open');
			const reply = once(socket, 'message');
			socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
				expression: `(() => {
					const doc = document.querySelector('iframe#active-frame')?.contentDocument;
					return doc?.querySelector('#composer') ? (${expression})(doc) : undefined;
				})()`, returnByValue: true
			} }));
			const value = JSON.parse((await reply)[0]).result?.result?.value;
			if (value !== undefined) { return value; }
		} finally { socket.close(); }
	}
}

async function main() {
	let port = 33000 + Math.floor(Math.random() * 4000);
	let browser, page, client;
	const launch = async () => {
		ui.launch({ exe, profile, workspace, port, env, settings: {
			'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
			'window.dialogStyle': 'custom', 'workbench.colorTheme': 'Event Minimal Dark',
			'singularity.update.checkAutomatically': false
		} });
		await ui.waitPage(port);
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
		page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('workbench'));
		assert(page);
	};
	const shot = name => page.screenshot({ path: path.join(root, name) });
	const pick = label => page.locator('.quick-input-list-entry:visible').filter({ hasText: label }).first().click({ timeout: 70000 });
	const manage = () => composer(port, doc => {
		doc.querySelector('#manage-providers').click();
		return true;
	});
	try {
		await launch();
		client = await until(() => HubConnection.connect({ home, clientName: 'provider-onboarding-e2e' }), 'isolated Hub', 90000);
		const inspect = () => client.request('providers.inspect', { workspace, refresh: true }, 60000);
		assert((await inspect()).filter(item => item.status === 'not-installed').length === 3);
		await until(() => composer(port, doc => doc.querySelector('#manage-providers')?.textContent === 'Configurar primeiro provedor'), 'first-use CTA');
		await shot('01-primeiro-uso.png');
		await manage();
		await page.locator('.quick-input-list-entry:visible').filter({ hasText: 'Não instalado' }).first().waitFor({ timeout: 70000 });
		await shot('02-provedores-ausentes.png');
		const chooseInstall = async () => {
			await pick('OpenCode');
			await pick('Instalar');
			return page.getByRole('button', { name: /^Instalar/ }).last();
		};
		await (await chooseInstall()).waitFor();
		await page.keyboard.press('Escape');
		assert.equal((await inspect()).find(item => item.id === 'opencode').status, 'not-installed');
		await manage();
		await (await chooseInstall()).click();
		await page.getByRole('button', { name: /^Cancel(ar)?$/i }).last().click({ timeout: 15000 });
		await page.getByText('Instalação cancelada.', { exact: false }).first().waitFor({ timeout: 20000 });
		assert.equal((await inspect()).find(item => item.id === 'opencode').status, 'not-installed');
		await manage();
		await (await chooseInstall()).click();
		await page.getByText('Instalando OpenCode', { exact: false }).first().waitFor({ timeout: 15000 });
		await shot('03-instalando-opencode.png');
		await until(async () => (await inspect()).some(item => item.id === 'opencode' && item.status === 'ready'), 'managed OpenCode ready', 210000);
		await pick('OpenCode');
		await pick('Utilizar');
		await until(() => composer(port, doc => !doc.querySelector('#model').disabled), 'real models in composer');
		const freeModels = await composer(port, doc => [...doc.querySelector('#model').options]
			.filter(option => /free/i.test(option.textContent)).map(option => option.value)
			.sort((a, b) => Number(b.includes('glm-5.3-flash-free')) - Number(a.includes('glm-5.3-flash-free'))));
		assert(freeModels?.length, 'No free model available');
		let completed = false;
		for (const option of freeModels.slice(0, 4)) {
			await composer(port, `doc => {
				const model = doc.querySelector('#model');
				model.value = ${JSON.stringify(option)};
				model.dispatchEvent(new doc.defaultView.Event('change'));
				const prompt = doc.querySelector('#prompt');
				prompt.value = 'Reply exactly ONBOARDING_OK. Do not use tools or modify any files.';
				prompt.dispatchEvent(new doc.defaultView.Event('input'));
				doc.querySelector('#send').click();
				return true;
			}`);
			await ui.sleep(2000);
			const status = await until(async () => {
				const row = (await client.request('sessions.list')).find(item => !item.historical);
				return row && (row.status === 'done' || row.status === 'failed') && row;
			}, 'first task outcome', 90000);
			if (status.status === 'done' && status.result?.includes('ONBOARDING_OK')) { completed = true; break; }
			if (!/HTTP (403|429|50[0234])/.test(status.summary || '')) { throw new Error(status.summary || 'Unexpected task result'); }
			await client.request('session.stop', { id: status.id }, 30000);
			await composer(port, doc => { doc.querySelector('#new').click(); return true; });
		}
		assert(completed, 'Free OpenCode providers did not complete the first task');
		await until(() => composer(port, doc => doc.querySelector('.result')?.textContent.includes('ONBOARDING_OK')), 'real result in IDE');
		await shot('04-primeira-tarefa.png');
		const selectedModel = await composer(port, doc => doc.querySelector('#model').value);
		await browser.close();
		await ui.closeApp(profile);
		port++;
		await launch();
		await until(() => composer(port, doc => !doc.querySelector('#model')?.disabled), 'models after reopening');
		assert.equal(await composer(port, doc => doc.querySelector('#model').value), selectedModel);
		await shot('05-reaberto.png');
		const settingsPath = path.join(profile, 'data', 'User', 'settings.json');
		for (const [theme, className, name] of [
			['Event Minimal Light', 'vscode-light', '06-claro.png'],
			['Default High Contrast', 'vscode-high-contrast', '07-alto-contraste.png']
		]) {
			const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
			settings['workbench.colorTheme'] = theme;
			fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
			await until(() => composer(port, `doc => doc.body.classList.contains(${JSON.stringify(className)})`), theme);
			await shot(name);
		}
		console.log('First-use CTA, three absent providers, declined consent, cancellation, managed OpenCode, real task and reopen passed.');
	} finally {
		if (client) { await client.request('hub.shutdown').catch(() => undefined); client.close(); }
		await browser?.close().catch(() => undefined);
		await ui.closeApp(profile);
	}
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
