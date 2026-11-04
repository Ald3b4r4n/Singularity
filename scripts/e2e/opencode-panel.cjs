'use strict';

// Packaged Windows workbench, real input, isolated profile/workspace and installed OpenCode.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const lib = require('./lib.cjs');
const { HubConnection } = require('../../singularity-hub/dist/client.js');

const [exe, outDir] = process.argv.slice(2);
assert(exe && outDir, 'Pass the packaged EXE and evidence directory.');
const profile = lib.tempProfile('opencode-panel');
const home = path.join(profile, 'hub');
const workspace = path.join(path.resolve(outDir), 'workspace');
const port = 9480 + Math.floor(Math.random() * 200);
const report = { checks: [] };
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(workspace);
const testModel = process.env.SINGULARITY_E2E_OPENCODE_MODEL;
if (testModel) {
	fs.writeFileSync(path.join(workspace, 'opencode.json'), JSON.stringify({ model: testModel }));
}
fs.writeFileSync(path.join(workspace, 'sample.txt'), 'synthetic workspace\n');
execFileSync('git', ['init', '-q', workspace]);

let browser;
let page;
let cdp;
let panel;
let hub;

async function waitFor(fn, name, timeout = 30000) {
	const end = Date.now() + timeout;
	do {
		const value = await fn();
		if (value) {
			return value;
		}
		await lib.sleep(250);
	} while (Date.now() < end);
	throw new Error('Timed out: ' + name);
}

function pass(label) {
	report.checks.push(label);
	console.log('PASS ' + label);
}

async function front() {
	try {
		lib.guard(profile);
	} catch {
		await lib.bringToFront(profile);
	}
}

async function input(action) {
	for (let attempt = 0; ; attempt++) {
		try {
			await front();
			action();
			return;
		} catch (error) {
			if (attempt >= 3 || !/guard:/.test(error.message)) {
				throw error;
			}
		}
	}
}

const keys = value => input(() => lib.keys(profile, value));
const paste = value => input(() => lib.paste(profile, value));

async function command(title, settle) {
	await keys('{F1}');
	await lib.sleep(650);
	await paste(title);
	await lib.sleep(650);
	await keys('{ENTER}');
	await lib.sleep(settle);
}

async function open() {
	lib.launch({ exe, profile, workspace, port, env: { SINGULARITY_HUB_HOME: home }, settings: {
		'workbench.colorTheme': 'Event Minimal Dark',
		'singularity.update.checkAutomatically': false
	} });
	cdp = await lib.cdp(port);
	await waitFor(() => cdp.evaluate("window.__singularityWorkbenchRestored && !document.getElementById('singularity-intro')"), 'workbench', 90000);
	browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	page = browser.contexts().flatMap(context => context.pages()).find(tab => /workbench/.test(tab.url()));
	assert(page, 'workbench DevTools target missing');
	await front();
	await command('Singularity: Abrir painel de agentes', 2000);
	panel = await waitFor(async () => {
		for (const frame of page.frames()) {
			if (await frame.locator('h1').filter({ hasText: 'SINGULARITY AGENTS' }).count().catch(() => 0)) {
				return frame;
			}
		}
	}, 'Agents webview');
	await panel.locator('[data-action="create"]').waitFor();
}

async function position(locator) {
	const box = await locator.boundingBox();
	assert(box, 'control is outside the visible webview');
	const g = await cdp.evaluate('({ dpr: devicePixelRatio, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight })');
	const border = (g.ow - g.iw) / 2;
	return [Math.round((box.x + box.width / 2 + border) * g.dpr),
		Math.round((box.y + box.height / 2 + g.oh - g.ih - border) * g.dpr)];
}

async function click(locator) {
	await front();
	await locator.scrollIntoViewIfNeeded();
	const point = await position(locator);
	await input(() => lib.click(profile, ...point));
}

async function enterPrompt(text) {
	await click(panel.locator('textarea'));
	await keys('^a');
	await paste(text);
	assert.equal(await panel.locator('textarea').inputValue(), text);
}

async function shutdownIde() {
	cdp?.close();
	cdp = undefined;
	await browser?.close();
	browser = undefined;
	const result = await lib.closeApp(profile, 25000);
	assert.equal(result.forced, 0);
}

async function smoke() {
	await open();
	hub = await HubConnection.connect({ home, clientName: 'opencode-panel-e2e' });
	const instance = hub.hello.hub.instanceId;
	assert.equal(await panel.locator('.launch strong').innerText(), 'OpenCode');
	await click(panel.locator('[data-action="create"]'));
	await page.locator('.quick-input-widget').getByText('Workspace da sessão OpenCode').waitFor();
	await keys('{ENTER}');
	await panel.locator('textarea').waitFor({ timeout: 50000 });
	const [session] = await hub.request('sessions.list');
	assert.equal(session.harness, 'opencode');
	assert.match(session.workspace, /workspace$/i);
	pass('OpenCode selected and a real session created in the chosen workspace');

	await enterPrompt('Reply with exactly SINGULARITY_OK. Do not use tools or read or modify files.');
	await click(panel.locator('[data-action="prompt"]'));
	await panel.locator('.events li').first().waitFor();
	await panel.locator('.session[data-status="done"], .session[data-status="failed"]').waitFor({ timeout: 90000 });
	report.status = await panel.locator('.session').getAttribute('data-status');
	report.eventNames = [...new Set(await panel.locator('.events li').allTextContents())];
	if (testModel) {
		assert.equal(report.status, 'done');
		assert.match(await panel.locator('.result').innerText(), /SINGULARITY_OK/);
		assert(report.eventNames.includes('session.text.delta'), 'no streamed assistant text event');
	}
	await front();
	await cdp.screenshot(path.join(outDir, 'opencode-dark.png'));
	pass('prompt submitted and actual OpenCode SSE events and terminal state displayed');

	await shutdownIde();
	await open();
	assert.equal(hub.hello.hub.instanceId, instance);
	assert.equal((await hub.request('sessions.list'))[0].id, session.id);
	await panel.locator(`textarea[data-session="${session.id}"]`).waitFor();
	pass('closing and reopening the packaged IDE preserved the same Hub session');

	await front();
	await keys('^k'); await lib.sleep(400);
	await keys('^t'); await lib.sleep(900);
	await paste('Event Minimal Light'); await lib.sleep(600);
	await keys('{ENTER}');
	await waitFor(() => cdp.evaluate("document.querySelector('.monaco-workbench')?.classList.contains('vs')"), 'light theme');
	await front();
	await cdp.screenshot(path.join(outDir, 'opencode-light.png'));
	pass('Event Minimal Light and Dark captured');

	await enterPrompt('Write a 100-line numbered poem. Do not use tools or read or modify files.');
	await click(panel.locator('[data-action="prompt"]'));
	await panel.locator('.session[data-status="running"]').waitFor();
	await click(panel.locator('[data-action="interrupt"]'));
	await panel.getByText(/Execução interrompida/).waitFor({ timeout: 15000 });
	report.cancelled = true;
	pass('task interrupted using the panel');
	await click(panel.locator('[data-action="stop"]'));
	await panel.locator('textarea').waitFor({ state: 'detached', timeout: 30000 });
	assert.deepEqual(await hub.request('sessions.list'), []);
	pass('session ended from the panel and Hub removed it after Job Object cleanup');

	assert(await page.locator('.singularity-account-entry').isVisible());
	await command('Singularity Browser: Open Browser', 2200);
	assert(await page.locator('.tabs-container .tab').filter({ hasText: /Browser/ }).count());
	await command('Terminal: Create New Terminal', 2500);
	const probe = path.join(workspace, 'terminal.txt');
	await paste('git status --porcelain | Set-Content -Encoding ascii terminal.txt');
	await keys('{ENTER}');
	await waitFor(() => fs.existsSync(probe), 'Git through the integrated terminal');
	pass('Git, integrated terminal, Browser and GitHub account entry available');
}

smoke().then(() => { report.ok = true; }).catch(error => {
	report.ok = false;
	report.error = error.message;
	console.error(error.stack);
	process.exitCode = 1;
}).finally(async () => {
	try {
		if (hub) {
			for (const session of await hub.request('sessions.list')) {
				await hub.request('session.stop', { id: session.id }, 30000);
			}
			await hub.request('hub.shutdown');
		}
	} catch (error) {
		report.cleanup = error.message;
		process.exitCode = 1;
	} finally {
		hub?.close();
		await shutdownIde().catch(() => undefined);
		fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
	}
});
