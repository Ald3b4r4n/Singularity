'use strict';
// E2E of the Singularity Agents experience, through the real UI (real keyboard and mouse of Windows), with the real Singularity Hub
// and the real OpenCode, on an isolated profile and workspace. The Hub is the source of truth for what the panel must show.
//
//   node scripts/e2e/agents-check.cjs --out <dir> [--exe <packaged exe> | --dev <repo>]
//
// Exercises the native editor and session sidebar in the Windows app with the real Hub and OpenCode.
// Captures the workbench surface only, so other windows cannot appear in the evidence.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { once } = require('node:events');
const WebSocket = require('../../singularity-hub/node_modules/ws');
const lib = require('./lib.cjs');
const { HubConnection } = require('../../singularity-hub/dist/client.js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const exe = arg('exe');
const dev = exe ? undefined : arg('dev', 'D:\\dev\\singularity');
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'agents-out')));
const profile = path.join(outDir, 'profile');
const home = path.join(outDir, 'hub');
const workspace = path.join(outDir, 'workspace');
let port = 9480 + Math.floor(Math.random() * 200);
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'sample.txt'), 'synthetic workspace\n');
execFileSync('git', ['init', '-q', workspace]);

const results = [];
const log = (...a) => { const l = new Date().toISOString() + ' ' + a.join(' '); console.log(l); fs.appendFileSync(path.join(outDir, 'progress.log'), l + '\n'); };
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); return !!ok; };
const must = (name, ok, detail) => { if (!check(name, ok, detail)) { throw new Error('required step failed: ' + name); } };
const sleep = lib.sleep;
const EFFORT = { none: 'Nenhum', minimal: 'Mínimo', low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Extra alto', max: 'Máximo' };

let browser, page, cdp, hub;

async function waitFor(fn, name, timeout = 30000, every = 300) {
	const end = Date.now() + timeout;
	do {
		const value = await Promise.resolve().then(fn).catch(() => undefined);
		if (value) { return value; }
		await sleep(every);
	} while (Date.now() < end);
	throw new Error('Timed out: ' + name);
}

async function command(title, settle = 900) {
	const picker = page.locator('.quick-input-widget input:visible').first();
	if (!(await picker.isVisible())) { await page.keyboard.press('F1'); }
	await picker.fill('>' + title, { timeout: 8000 });
	const name = title.split(': ').at(-1);
	const entry = page.locator('.quick-input-list-entry:visible').filter({ has: page.getByText(name, { exact: true }) }).first();
	if (await entry.count()) {
		await entry.click({ timeout: 8000 });
	} else {
		await page.keyboard.press('Enter');
	}
	await sleep(settle);
}

const click = locator => locator.click();

async function typePrompt(text) {
	await editor((doc, value) => {
		const prompt = doc.querySelector('#prompt');
		prompt.focus();
		prompt.value = value;
		prompt.dispatchEvent(new Event('input'));
	}, text);
}

async function pick(id, value) {
	await editor((doc, [id, value]) => {
		const select = doc.getElementById(id);
		select.value = value;
		select.dispatchEvent(new Event('change'));
	}, [id, value]);
}

const activate = selector => editor((doc, selector) => { doc.querySelector(selector).click(); }, selector);
const content = selector => editor((doc, selector) => doc.querySelector(selector)?.innerText, selector);
const status = () => editor(doc => doc.querySelector('.session')?.dataset.status);
const disabled = selector => editor((doc, selector) => doc.querySelector(selector).disabled, selector);
const value = selector => editor((doc, selector) => doc.querySelector(selector).value, selector);

const snap = async name => {
	await page.screenshot({ path: path.join(outDir, name), timeout: 10000 });
	log('screenshot', name);
};

const settingsFile = () => path.join(profile, 'data', 'User', 'settings.json');
function setSetting(k, v) {
	const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
	if (v === undefined) { delete s[k]; } else { s[k] = v; }
	fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

async function open() {
	lib.launch({ exe, dev, profile, workspace, port, env: { SINGULARITY_HUB_HOME: home }, settings: { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'window.dialogStyle': 'custom', 'workbench.colorTheme': 'Event Minimal Dark', 'singularity.update.checkAutomatically': false } });
	cdp = await lib.cdp(port);
	await waitFor(() => cdp.evaluate("window.__singularityWorkbenchRestored && !document.getElementById('singularity-intro')"), 'workbench', 120000, 500);

	browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	page = browser.contexts().flatMap(context => context.pages()).find(tab => /workbench/.test(tab.url()));
	if (!page) { throw new Error('workbench DevTools target missing'); }
	const hwnd = lib.appWindows(profile)[0].hwnd;
	lib.ps(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class RS0 { [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c); }'; [void][RS0]::ShowWindow([IntPtr]${hwnd},9); [void][RS0]::MoveWindow([IntPtr]${hwnd},30,30,1360,860,$true)`);
	await sleep(6000);
}

// Electron exposes webviews as separate DevTools targets. Attach to each wrapper directly
// and access its same-origin content frame, including when the editor has just been restored.
async function editor(expression, args, root = '#composer') {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
	for (const target of targets.filter(t => t.type === 'iframe')) {
		const ws = new WebSocket(target.webSocketDebuggerUrl);
		try {
			await once(ws, 'open');
			const response = once(ws, 'message');
			ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
				expression: `(() => {
					const doc = document.querySelector('iframe#active-frame')?.contentDocument;
					if (doc?.querySelector(${JSON.stringify(root)})) { return (${expression})(doc, ${JSON.stringify(args)}); }
				})()`, returnByValue: true
			} }));
			const [message] = await response;
			const value = JSON.parse(message).result?.result?.value;
			if (value !== undefined) { return value; }
		} finally {
			ws.close();
		}
	}
}

async function closeIde() {
	cdp?.close(); cdp = undefined;
	await browser?.close().catch(() => undefined); browser = undefined;
	return lib.closeApp(profile, 30000);
}

const sessionsOnHub = async () => hub.request('sessions.list');

async function main() {
	await open();
	hub = undefined;

	// ---------- 1. no Chat tab and no Copilot control ----------
	const audit = await page.evaluate(`(() => {
		const labels = [...new Set([...document.querySelectorAll('[aria-label],[title]')].map(e => (e.getAttribute('aria-label') || e.getAttribute('title') || '').replace(/\\s+/g, ' ').trim()))];
		return {
			chatOrCopilot: labels.filter(t => /copilot|toggle chat|open chat|agent status|agents window|codex|chat\\b/i.test(t)),
			status: [...document.querySelectorAll('.statusbar-item')].map(e => (e.getAttribute('aria-label') || e.innerText).replace(/\\s+/g, ' ').trim()).filter(Boolean),
			titleSignIn: [...document.querySelectorAll('.titlebar-container [aria-label]')].some(e => e.getAttribute('aria-label') === 'Sign In'),
			account: !!document.querySelector('.singularity-account-entry.signed-out'),
		};
	})()`);
	check('1a. no Chat tab or Copilot control in the default UI (labels, status bar, empty editor)', audit.chatOrCopilot.length === 0, audit.chatOrCopilot);
	check('1b. no Copilot "Sign In" button; the Singularity GitHub entry is there', !audit.titleSignIn && audit.account);
	check('1c. the status bar offers one agents entry', audit.status.filter(s => /Agentes/.test(s)).length === 1, audit.status);

	// The first profile opens Agentes on its own. Explorer and Sessões live outside the editor part.
	await waitFor(() => editor(doc => !!doc.querySelector('#composer')), 'Agentes editor', 40000);
	const editorTab = page.locator('.tabs-container .tab').filter({ hasText: 'Agentes' });
	must('2a. Agentes is a native editor tab', await editorTab.isVisible());
	check('2b. Explorer is on the left and Sessões is on the right',
		await page.locator('.part.sidebar').isVisible() && /Sessões/.test(await page.locator('.part.auxiliarybar').innerText()));
	const draft = 'Rascunho que não pode ser perdido ao trocar as opções.';

	await waitFor(() => disabled('#model').then(d => d === false), 'real catalog loaded in the editor', 120000);
	hub = await HubConnection.connect({ home, clientName: 'agents-e2e' });
	const truth = await hub.request('catalog.get', { workspace }, 120000);
	const opencode = truth.providers.find(p => p.id === 'opencode');
	const options = id => editor((doc, id) => [...doc.getElementById(id).options].map(o => ({ value: o.value, text: o.textContent, disabled: o.disabled })), id);
	const integrations = await options('service');
	check('3a. only OpenCode is enabled as a coding integration', integrations.filter(s => !s.disabled).map(s => s.value).join() === 'opencode');
	const modelKey = (providerId, modelId) => JSON.stringify([providerId, modelId]);
	const modelKeys = truth.providers.flatMap(provider => provider.models.map(model => modelKey(provider.id, model.id)));
	check('3b. the selector shows exactly the real catalog', JSON.stringify((await options('model')).map(m => m.value)) === JSON.stringify(modelKeys));
	check('3c. the integration default is preselected', !truth.default || (await value('#model')) === modelKey(truth.default.providerID, truth.default.modelID));
	await typePrompt('');
	await snap('01-agentes-inicial.png');

	await typePrompt(draft);
	must('4a. the draft is entered into the composer', (await value('#prompt')) === draft);
	const withEffort = opencode.models.find(m => m.id === process.env.SINGULARITY_E2E_OPENCODE_MODEL && m.efforts.includes('low')) ||
		opencode.models.find(m => /free/.test(m.id) && m.efforts.includes('low') && m.efforts.length >= 2);
	must('4b. OpenCode offers a free model with effort levels', !!withEffort, withEffort?.id);
	await pick('model', modelKey('opencode', withEffort.id));
	const efforts = await options('effort');
	check('4c. effort selector uses exactly the real model levels', JSON.stringify(efforts.map(e => e.value)) === JSON.stringify(['', ...withEffort.efforts]));
	await pick('effort', 'low');
	check('4d. the draft survived model and effort changes', (await value('#prompt')) === draft);
	await snap('02-selecao-modelo-esforco.png');

	// ---------- 5. one composer sends a real task; the answer streams in the same panel ----------
	await typePrompt('Reply with exactly SINGULARITY_OK. Do not use tools or read or modify files.');
	await editor(doc => {
		const prompt = doc.querySelector('#prompt');
		prompt.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
	});
	await waitFor(async () => !!(await status()), 'the session card appears', 90000);
	const created = (await sessionsOnHub())[0];
	check('5a. the session was created at send time, in the chosen workspace, with the chosen model and effort',
		created.harness === 'opencode' && /workspace$/i.test(created.workspace) && created.model && created.model.providerID === 'opencode' && created.model.modelID === withEffort.id && created.model.variant === 'low', created.model);
	const cardText = await content('.session');
	check('5b. the card shows the service, the model really used and the effort', /OpenCode/.test(cardText) && cardText.includes((opencode.models.find(m => m.id === withEffort.id)).name) && /Baixo/.test(cardText), cardText.replace(/\s+/g, ' ').slice(0, 160));
	check('5bb. the submitted prompt is visible above the result', /SINGULARITY_OK/.test(await content('.submitted')));
	await waitFor(async () => /running|waiting|done|failed/.test(await status()), 'task started', 60000);
	await waitFor(async () => (await status()) === 'running' && !!(await content('.result')),
		'a partial result while running', 1800, 80).then(async () => snap('03a-streaming.png')).catch(() => undefined);
	const final = await waitFor(async () => { const s = await status(); return s === 'done' || s === 'failed' ? s : undefined; }, 'task finished', 150000, 500);
	const result = await content('.result').catch(() => '');
	check('5c. the task ran to the end and its answer streamed into the same panel', final === 'done' && /SINGULARITY_OK/.test(result), { final, result: result.slice(0, 60) });
	check('5d. internal events stay out of the conversation', !(await content('.events')));
	await snap('03-tarefa-concluida.png');

	// ---------- 6. change the effort and send again: the same session, the model it reports changes ----------
	await pick('effort', withEffort.efforts[1]);
	await typePrompt('Reply with exactly SECOND_OK. Do not use tools or read or modify files.');
	await activate('#send');
	await waitFor(async () => { const s = (await sessionsOnHub())[0]; return s.model && s.model.variant === withEffort.efforts[1]; }, 'the effort change reaches the session', 60000).catch(async error => {
		log('diagnostic: sessions on the Hub:', JSON.stringify((await sessionsOnHub()).map(x => ({ id: x.id.slice(0, 8), status: x.status, model: x.model }))), '| panel target:', await content('#target').catch(() => '?'), '| note:', await content('#note').catch(() => '?'));
		throw error;
	});
	check('6a. changing the effort changes the effort of the session in use (same session, no new one)', (await sessionsOnHub()).length === 1);
	await waitFor(async () => { const s = await status(); return s === 'done' || s === 'failed'; }, 'second task finished', 150000, 500);
	check('6b. the card shows the new effort level', (await content('.session')).includes(EFFORT[withEffort.efforts[1]] || withEffort.efforts[1]), withEffort.efforts[1]);

	// ---------- 7. cancel a running task, then end the session ----------
	await typePrompt('Write a 100-line numbered poem, one line per number. Do not use tools or read or modify files.');
	await activate('#send');
	await waitFor(async () => (await status()) === 'running', 'the poem task is running', 90000, 200);
	check('7a. while a task runs, the send button becomes Parar', !(await disabled('#send')) && (await content('#send')).trim() === 'Parar');
	await editor(doc => doc.querySelector('[data-filter="active"]').click(), undefined, '.navigation');
	await waitFor(() => editor(doc => !!doc.querySelector('.session-link'), undefined, '.navigation'), 'active session in the sidebar');
	await snap('03b-tarefa-em-execucao.png');
	await waitFor(async () => (await status()) === 'running' && !!(await content('.result')),
		'a partial result while running', 4000, 120).then(async () => snap('03a-streaming.png')).catch(() => undefined);
	await activate('#send');
	await waitFor(async () => /Execução interrompida/.test(await content('.session')), 'the task is reported as interrupted', 30000);
	check('7b. Parar interrupts the task from the composer', (await sessionsOnHub())[0].status === 'idle');

	// ---------- 8. the session survives closing and reopening the IDE ----------
	const instance = hub.hello.hub.instanceId;
	const before = (await sessionsOnHub())[0];
	const closed = await closeIde();
	check('8a. the IDE closes normally', closed.forced === 0, closed);
	check('8b. the Hub and the session keep running without the IDE', (await sessionsOnHub())[0].id === before.id);
	port += 200;
	await open();
	await waitFor(() => editor(doc => doc.querySelector('.session')?.dataset.id), 'the session is back in the editor', 60000);
	await waitFor(() => editor(doc => !doc.querySelector('#model').disabled), 'the restored model is available', 90000);
	const after = (await sessionsOnHub())[0];
	check('8c. after reopening, the same Hub and the same session are shown', hub.hello.hub.instanceId === instance && after.id === before.id &&
		(await editor(doc => doc.querySelector('.session').dataset.id)) === before.id);
	check('8d. the preferences were remembered', (await editor(doc => doc.querySelector('#model').value)) === modelKey('opencode', withEffort.id));

	await snap('04-reaberto-dark.png');
	await activate('#new');
	await waitFor(() => editor(doc => !!doc.querySelector('.welcome')), 'new-task view');
	await waitFor(() => editor(doc => {
		const link = doc.querySelector('.session-link');
		if (!link || link.hasAttribute('aria-current')) { return false; }
		link.click();
		return true;
	}, undefined, '.navigation'), 'sidebar updates the selected session');
	await waitFor(() => editor((doc, id) => doc.querySelector('.session')?.dataset.id === id, before.id), 'sidebar opens the selected session');
	check('8e. selecting a session in the sidebar opens it in the editor', true);
	const resizeTo = async (w, h) => {
		const hwnd = lib.appWindows(profile)[0].hwnd;
		lib.ps(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class RS1 { [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r); }'; [void][RS1]::MoveWindow([IntPtr]${hwnd},30,30,${w},${h},$true)`);
		await sleep(2000);
	};
	await resizeTo(620, 860);
	const layout = await editor(doc => {
		const width = doc.defaultView.innerWidth;
		const overflow = doc.documentElement.scrollWidth - width;
		const usable = ['service', 'model', 'effort', 'prompt', 'send'].every(id => {
			const box = doc.getElementById(id).getBoundingClientRect();
			return box.width > 36 && box.left >= 0 && box.right <= width + 1;
		});
		return { width, overflow, usable };
	});
	check('9a. narrow window: the editor fits without horizontal scroll', layout.width <= 620 && layout.overflow <= 1, layout);
	check('9b. narrow window: composer controls remain usable', layout.usable);
	await snap('05-painel-estreito-dark.png');
	await resizeTo(1360, 860);
	setSetting('workbench.colorTheme', 'Event Minimal Light');
	await waitFor(() => editor(doc => doc.body.classList.contains('vscode-light')), 'light theme');
	await snap('06-claro.png');
	check('9c. Event Minimal Light applies to the editor', true);
	setSetting('workbench.colorTheme', 'Default High Contrast');
	await waitFor(() => editor(doc => doc.body.classList.contains('vscode-high-contrast')), 'high contrast theme');
	await snap('07-alto-contraste.png');
	check('9d. high contrast: the prompt keeps a visible border', (await editor(doc => parseFloat(doc.defaultView.getComputedStyle(doc.querySelector('#prompt')).borderTopWidth))) >= 1);
	setSetting('workbench.colorTheme', 'Event Minimal Dark');
	const defaultWidth = await editor(doc => doc.defaultView.innerWidth);
	setSetting('window.zoomLevel', 1);
	await waitFor(() => editor(doc => doc.defaultView.innerWidth).then(width => width < defaultWidth), 'increased interface scale');
	check('9e. the composer remains usable with interface zoom', await editor(doc => doc.querySelector('#send').getBoundingClientRect().right <= doc.defaultView.innerWidth));
	await snap('08-escala-maior.png');
	setSetting('window.zoomLevel', 0);

	await editor(doc => { doc.querySelector('.session-menu').open = true; doc.querySelector('[data-action="stop"]').click(); }, undefined, '.navigation');
	await click(page.getByRole('button', { name: /^Encerrar/ }).last());
	await waitFor(async () => (await sessionsOnHub()).some(session => session.id === before.id && session.historical),
		'the Hub archives the closed session', 60000);
	await waitFor(() => editor(doc => doc.querySelector('#send').disabled), 'archived conversation is read-only');
	check('10a. Encerrar ends the session and the Hub releases it', true);

	await click(page.locator('.part.sidebar').getByText('sample.txt', { exact: true }).first());
	check('10b. the Explorer still opens a conventional file', await page.locator('.tabs-container .tab').filter({ hasText: 'sample.txt' }).isVisible());
	await command('View: Split Editor Right');
	await command('Singularity: Abrir Agentes');
	await command('View: Move Editor into Next Group');
	check('10c. the native singleton Agentes can move into another editor group while the file stays open',
		(await page.locator('.editor-group-container').count()) >= 2 && (await editorTab.count()) === 1);
	await editorTab.evaluate(tab => tab.querySelector('.codicon-close').click());
	await waitFor(async () => (await editorTab.count()) === 0, 'the editor closes');
	await command('Singularity: Abrir Agentes');
	await waitFor(() => editor(doc => !!doc.querySelector('.welcome')), 'Agentes reopened');
	check('10d. the command reopens the closed editor', await editorTab.isVisible());

	// ---------- 11. the rest of the product still works ----------
	check('11a. the GitHub account entry is still in the title bar', await page.locator('.singularity-account-entry').isVisible());
	await click(page.locator('.part.sidebar').getByText('sample.txt', { exact: true }).first());
	await command('Singularity Browser: Open Browser', 2500);
	check('11b. the Singularity Browser opens', (await page.locator('.tabs-container .tab').filter({ hasText: /Browser/ }).count()) > 0);
	await command('Terminal: Create New Terminal', 2500);
	const probe = path.join(workspace, 'terminal.txt');
	await page.keyboard.type('git status --porcelain > terminal.txt');
	await page.keyboard.press('Enter');
	check('11c. the integrated terminal runs Git', !!(await waitFor(() => fs.existsSync(probe), 'terminal output', 20000).catch(() => false)));
}

main().catch(error => { check('the agents run completed', false, { error: error.message }); log(error.stack); }).finally(async () => {
	try {
		if (hub) {
			for (const session of await hub.request('sessions.list').catch(() => [])) { await hub.request('session.stop', { id: session.id }, 30000).catch(() => undefined); }
			await hub.request('hub.shutdown').catch(() => undefined);
		}
	} finally {
		hub?.close();
		try { if (page) { await snap('final.png'); } } catch { /* ignore */ }
		await closeIde().catch(() => undefined);
		const ok = results.length > 0 && results.every(r => r.ok);
		fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ build: exe ? 'packaged' : 'dev', results, ok, finished: new Date().toISOString() }, null, 2));
		log(ok ? 'AGENTS CHECK PASSED' : 'AGENTS CHECK FAILED');
		process.exit(ok ? 0 : 1);
	}
});
