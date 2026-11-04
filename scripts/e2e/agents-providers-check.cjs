'use strict';
// Packaged E2E of the three operational providers (OpenCode, Claude Code and Codex CLI) in the Agentes UI, through the real UI, the real Hub, the
// real OpenCode and the real Claude Code CLI, on an isolated profile and a synthetic workspace.
//
//   node scripts/e2e/agents-providers-check.cjs --out <dir> --exe <packaged exe>

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
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'providers-out')));
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

const claudeFor = id => { try { return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -like '*${id}*' } | Measure-Object).Count`], { encoding: 'utf8' }).trim()) || 0; } catch { return -1; } };
// The Codex process (or its helper) is identified by the output directory of this run, which is in every command line.
const codexFor = () => { try { return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'codex.exe' -or $_.Name -eq 'singularity-job.exe') -and $_.CommandLine -like '*codex*' -and $_.CommandLine -like '*${path.basename(outDir)}*' } | Measure-Object).Count`], { encoding: 'utf8' }).trim()) || 0; } catch { return -1; } };
const options = id => editor((doc, id) => [...doc.getElementById(id).options].map(o => ({ value: o.value, text: o.textContent, disabled: o.disabled })), id);
const hidden = id => editor((doc, id) => doc.getElementById(id).hidden, id);
const cardId = () => editor(doc => doc.querySelector('.session')?.dataset.id);
const modelKey = (providerId, modelId) => JSON.stringify([providerId, modelId]);
const live = async () => (await sessionsOnHub()).filter(s => !s.historical);
const navigate = id => waitFor(() => editor((doc, id) => { const link = doc.querySelector(`.session-link[data-id="${id}"]`); if (!link) { return false; } link.click(); return true; }, id, '.navigation'), 'the sidebar lists the session ' + id.slice(0, 8));
/** Waits for the card to show THIS task (a stale `done` from the previous one must not end the wait), then for its end. */
const settle = async (marker, label, ms = 180000) => {
	await waitFor(async () => ((await content('.submitted')) || '').includes(marker), label + ' (task submitted)', 60000, 150);
	return waitFor(async () => { const s = await status(); return s === 'done' || s === 'failed' ? s : undefined; }, label, ms, 500);
};
// The approved UI keeps Encerrar in the session menu and Reabrir on the session card of the side panel; Parar is the send button itself.
const stoppable = () => editor(doc => { const b = doc.getElementById('send'); return b.classList.contains('interrupt') && !b.disabled; });
const endSession = id => editor((doc, id) => { const menu = doc.querySelector(`li.session[data-id="${id}"] details.session-menu`); menu.open = true; menu.querySelector('button[data-action="stop"]').click(); }, id, '.navigation');
const reopenAvailable = id => editor((doc, id) => !!doc.querySelector(`button[data-action="reopen"][data-id="${id}"]`), id, '.navigation');
const reopenSession = id => editor((doc, id) => doc.querySelector(`button[data-action="reopen"][data-id="${id}"]`).click(), id, '.navigation');
const lastState = () => editor(doc => ({ target: doc.getElementById('target').textContent, note: doc.getElementById('note').textContent, send: doc.getElementById('send').disabled }));

async function main() {
	await open();
	hub = undefined;
	await waitFor(() => editor(doc => !!doc.querySelector('#composer')), 'Agentes editor', 40000);
	await waitFor(() => disabled('#model').then(d => d === false), 'real catalog loaded in the editor', 120000);
	hub = await HubConnection.connect({ home, clientName: 'providers-e2e' });
	const openCode = await hub.request('catalog.get', { workspace }, 120000);
	const claude = await hub.request('catalog.get', { service: 'claude-code', workspace }, 60000);
	const claudeModels = claude.providers[0]?.models ?? [];
	const codex = await hub.request('catalog.get', { service: 'codex-cli', workspace }, 60000);
	const codexModels = codex.providers[0]?.models ?? [];
	const opencodeModel = openCode.providers.flatMap(p => p.models.map(m => ({ ...m, providerID: p.id }))).find(m => m.id === process.env.SINGULARITY_E2E_OPENCODE_MODEL);
	must('0. the Hub offers OpenCode, Claude Code and Codex CLI, and the OpenCode model for this test exists', claude.services.filter(s => s.status === 'available').map(s => s.id).sort().join() === 'claude-code,codex-cli,opencode' && claudeModels.length > 0 && codexModels.length > 0 && !!opencodeModel,
		{ services: claude.services.map(s => s.id + ':' + s.status), claude: claudeModels.map(m => m.id), opencode: opencodeModel?.id });

	// ---------- 1. the provider selector ----------
	const services = await options('service');
	const byId = id => services.find(s => s.value === id);
	check('1a. OpenCode, Claude Code and Codex CLI are operational (selectable)', !byId('opencode')?.disabled && !byId('claude-code')?.disabled && !byId('codex-cli')?.disabled, services.map(s => s.text));
	check('1b. Gemini CLI is "em breve" and cannot be selected', ['gemini-cli'].every(id => byId(id)?.disabled && /em breve/.test(byId(id).text)), services.map(s => s.text));
	check('1c. the permission control is hidden while OpenCode is selected', (await hidden('permission-field')) === true);
	await snap('c00-provedores.png');

	// ---------- 2. Claude Code: models and efforts from the real capabilities ----------
	await pick('service', 'claude-code');
	await waitFor(async () => JSON.stringify((await options('model')).map(m => m.value)) === JSON.stringify(claudeModels.map(m => modelKey('claude-code', m.id))), 'the model list follows the provider', 60000);
	check('2a. switching to Claude Code lists exactly the models the CLI documents', true, claudeModels.map(m => m.id));
	await pick('model', modelKey('claude-code', 'sonnet'));
	const efforts = await options('effort');
	check('2b. the effort levels are exactly the real ones', JSON.stringify(efforts.map(e => e.value)) === JSON.stringify(['', ...claudeModels.find(m => m.id === 'sonnet').efforts]), efforts.map(e => e.value));
	check('2c. the permission control appears for Claude Code and offers no bypass', (await hidden('permission-field')) === false && !(await options('permission')).some(o => /bypass|auto|dontAsk/i.test(o.value + o.text)), (await options('permission')).map(o => o.text));
	await pick('effort', 'low');
	await pick('permission', 'acceptEdits');
	await snap('c01-claude-selecionado.png');

	// ---------- 3. a real task: streaming, the real model, a file edited in the workspace ----------
	await typePrompt('Create a file named hello.txt in the current directory containing exactly the text SINGULARITY-CLAUDE-OK (no trailing text). Then answer with the single word DONE.');
	await activate('#send');
	await waitFor(async () => !!(await status()), 'the Claude Code card appears', 90000);
	const first = (await live())[0];
	check('3a. the session was created at send time for Claude Code, in the workspace, with the chosen alias, effort and permissions',
		first.harness === 'claude-code' && /workspace$/i.test(first.workspace) && first.model.variant === 'low' && first.permissionMode === 'acceptEdits', { model: first.model, permissionMode: first.permissionMode });
	await waitFor(async () => (await status()) === 'running' && !!(await content('.result')), 'a partial result while running', 60000, 80).then(async () => { snap('c02-streaming.png'); check('3b. the answer streams into the panel while the task runs', true); }).catch(() => check('3b. the answer streams into the panel while the task runs', false));
	const done = await waitFor(async () => { const s = await status(); return s === 'done' || s === 'failed' ? s : undefined; }, 'the controlled task finished', 180000, 500);
	const card = await content('.session');
	check('3c. the task finished', done === 'done', { done, summary: (await content('.summary').catch(() => '')) });
	check('3d. the card shows Claude Code, the model really used, the effort and the permissions', /Claude Code/.test(card) && /claude-sonnet/.test(card) && /Baixo/.test(card) && /Permissões: Aceitar edições/.test(card), card.replace(/\s+/g, ' ').slice(0, 200));
	check('3e. the file was written in the synthetic workspace', fs.existsSync(path.join(workspace, 'hello.txt')) && fs.readFileSync(path.join(workspace, 'hello.txt'), 'utf8').trim() === 'SINGULARITY-CLAUDE-OK');
	check('3f. no Claude Code process is left after the task', await waitFor(() => claudeFor(first.id) === 0, 'process exit', 15000, 500).then(() => true, () => false));
	await snap('c03-claude-concluido.png');

	// ---------- 4. continue the same session ----------
	await typePrompt('Which exact text did you write into hello.txt? Answer with only that text.');
	await activate('#send');
	await settle('Which exact text', 'the continuation finished');
	check('4a. the same session continues the same conversation, with no second session', (await live()).length === 1 && /SINGULARITY-CLAUDE-OK/.test(await content('.result')), (await content('.result')).slice(0, 80));

	// ---------- 5. cancel one execution ----------
	await typePrompt('Write a numbered poem with 200 lines, one line per number. Do not use tools.');
	await activate('#send');
	await waitFor(async () => ((await content('.submitted')) || '').includes('numbered poem'), 'the poem is submitted', 60000, 150);
	await waitFor(async () => (await status()) === 'running' && !!(await content('.result')), 'the poem is streaming', 90000, 150);
	check('5a. while a task runs, the send button becomes Parar', await stoppable());
	await activate('#send');
	await waitFor(async () => /Execução interrompida/.test(await content('.session')), 'the task is reported as interrupted', 30000);
	check('5b. Parar interrupts the execution and the Job Object releases the process', (await live())[0].status === 'idle' && await waitFor(() => claudeFor(first.id) === 0, 'process exit', 15000, 500).then(() => true, () => false));
	const claudeId = first.id;

	// ---------- 5c. Codex CLI: its real capabilities, a task, a continuation and a cancellation ----------
	await activate('#new');
	await waitFor(() => editor(doc => !!doc.querySelector('.welcome')), 'new-task view');
	await pick('service', 'codex-cli');
	await waitFor(async () => JSON.stringify((await options('model')).map(m => m.value)) === JSON.stringify(codexModels.map(m => modelKey('codex-cli', m.id))), 'the Codex models appear', 60000);
	check('5a. switching to Codex CLI lists exactly the models its catalog reports', true, codexModels.map(m => m.id));
	const codexModel = codexModels.find(m => m.id === 'gpt-5.6-luna');
	await pick('model', modelKey('codex-cli', 'gpt-5.6-luna'));
	const codexEfforts = await options('effort');
	check('5b. the effort levels are exactly the ones this model reports', JSON.stringify(codexEfforts.map(e => e.value)) === JSON.stringify(['', ...codexModel.efforts]), codexEfforts.map(e => e.value));
	const codexPermissions = await options('permission');
	check('5c. the permission control follows the provider: sandbox modes, no bypass', (await hidden('permission-field')) === false && JSON.stringify(codexPermissions.map(o => o.value)) === JSON.stringify(['', 'workspace-write']), codexPermissions.map(o => o.text));
	await pick('effort', 'low');
	await pick('permission', 'workspace-write');
	await snap('c04a-codex-selecionado.png');
	await typePrompt('Create a file named hello-codex.txt in the current directory containing exactly the text SINGULARITY-CODEX-OK (no trailing text). Then answer with the single word DONE.');
	await activate('#send');
	await waitFor(async () => (await live()).some(s => s.harness === 'codex-cli'), 'the Codex session exists', 90000);
	const codexId = (await live()).find(s => s.harness === 'codex-cli').id;
	const codexFirst = (await live()).find(s => s.id === codexId);
	check('5d. created for Codex CLI, in the workspace, with the chosen model, effort and sandbox', /workspace$/i.test(codexFirst.workspace) && codexFirst.model.modelID === 'gpt-5.6-luna' && codexFirst.model.variant === 'low' && codexFirst.permissionMode === 'workspace-write', codexFirst.model);
	const codexDone = await settle('hello-codex.txt', 'the Codex task finished', 240000);
	const codexCard = await content('.session');
	check('5e. the task finished; the card shows Codex CLI, the requested model, the effort and the sandbox', codexDone === 'done' && /Codex CLI/.test(codexCard) && /gpt-5\.6-luna/i.test(codexCard) && /Baixo/.test(codexCard) && /Permissões: Escrever no workspace/.test(codexCard), codexCard.replace(/\s+/g, ' ').slice(0, 200));
	check('5f. the file was written in the synthetic workspace', fs.existsSync(path.join(workspace, 'hello-codex.txt')) && fs.readFileSync(path.join(workspace, 'hello-codex.txt'), 'utf8').trim() === 'SINGULARITY-CODEX-OK');
	check('5h. no Codex CLI process is left after the task', await waitFor(() => codexFor() === 0, 'process exit', 20000, 500).then(() => true, () => false));
	await snap('c04b-codex-concluido.png');
	await typePrompt('Which exact text did you write into hello-codex.txt? Answer with only that text.');
	await activate('#send');
	await settle('Which exact text did you write into hello-codex', 'the Codex continuation finished', 240000);
	check('5i. the same Codex session continues the same conversation, with no second Codex session', (await live()).filter(s => s.harness === 'codex-cli').length === 1 && /SINGULARITY-CODEX-OK/.test(await content('.result')), (await content('.result')).slice(0, 80));
	await typePrompt('Write a numbered poem with 200 lines, one line per number, thinking carefully about rhyme for every line. Do not use tools.');
	await activate('#send');
	await waitFor(async () => ((await content('.submitted')) || '').includes('numbered poem'), 'the poem is submitted', 60000, 150);
	await waitFor(async () => (await status()) === 'running', 'the Codex poem is running', 90000, 150);
	await sleep(3500);
	check('5j. while a Codex task runs, the send button becomes Parar', await stoppable());
	await activate('#send');
	await waitFor(async () => /Execução interrompida/.test(await content('.session')), 'the Codex task is reported as interrupted', 40000);
	check('5k. Parar interrupts the Codex execution and the Job Object releases the process', (await live()).find(s => s.id === codexId).status === 'idle' && await waitFor(() => codexFor() === 0, 'process exit', 20000, 500).then(() => true, () => false));

	// ---------- 6. an independent OpenCode session in the same workspace, next to the other two ----------
	await activate('#new');
	await waitFor(() => editor(doc => !!doc.querySelector('.welcome')), 'new-task view');
	await pick('service', 'opencode');
	await waitFor(async () => (await options('model')).some(m => m.value === modelKey(opencodeModel.providerID, opencodeModel.id)), 'the OpenCode models are back', 60000);
	await pick('model', modelKey(opencodeModel.providerID, opencodeModel.id));
	check('6a. back on OpenCode the permission control is hidden again', (await hidden('permission-field')) === true);
	await typePrompt('Reply with exactly SINGULARITY_OK. Do not use tools or read or modify files.');
	await activate('#send');
	await waitFor(async () => (await live()).length === 3, 'the third session exists', 90000);
	const openCodeId = (await live()).find(s => s.harness === 'opencode').id;
	await settle('SINGULARITY_OK', 'the OpenCode task finished');
	check('6b. OpenCode ran in the same workspace as its own session, next to the Claude Code and Codex CLI ones', (await content('.result')).includes('SINGULARITY_OK') && (await live()).map(s => s.harness).sort().join() === 'claude-code,codex-cli,opencode');
	const sessions = await live();
	const claudeSession = sessions.find(s => s.id === claudeId);
	const openCodeSession = sessions.find(s => s.id === openCodeId);
	const codexSession = sessions.find(s => s.id === codexId);
	check('6c. results are not mixed between the providers', !/SINGULARITY_OK|SINGULARITY-CODEX-OK/.test(claudeSession.result ?? '') && !/SINGULARITY-CLAUDE-OK|SINGULARITY-CODEX-OK/.test(openCodeSession.result ?? '') && !/SINGULARITY-CLAUDE-OK|SINGULARITY_OK/.test(codexSession.result ?? '') && claudeSession.model.providerID === 'claude-code' && codexSession.model.providerID === 'codex-cli' && openCodeSession.model.providerID !== 'claude-code' && openCodeSession.model.providerID !== 'codex-cli');
	await snap('c04-tres-sessoes.png');

	// ---------- 7. switching between the sessions ----------
	await navigate(claudeId);
	await waitFor(async () => (await cardId()) === claudeId, 'the editor shows the Claude Code session');
	check('7a. selecting the Claude Code session shows it and moves the selectors to its provider', (await value('#service')) === 'claude-code' && (await value('#model')) === modelKey('claude-code', 'sonnet'), await lastState());
	await navigate(openCodeId);
	await waitFor(async () => (await cardId()) === openCodeId, 'the editor shows the OpenCode session');
	check('7b. selecting the OpenCode session shows it and moves the selectors back', (await value('#service')) === 'opencode');
	await navigate(codexId);
	await waitFor(async () => (await cardId()) === codexId, 'the editor shows the Codex CLI session');
	check('7b2. selecting the Codex CLI session shows it and moves the selectors, effort and sandbox to it', (await value('#service')) === 'codex-cli' && (await value('#model')) === modelKey('codex-cli', 'gpt-5.6-luna') && (await value('#effort')) === 'low' && (await value('#permission')) === 'workspace-write', await lastState());
	await navigate(claudeId);
	await waitFor(async () => (await cardId()) === claudeId, 'the editor shows the Claude Code session again');
	await pick('service', 'opencode');
	check('7c. a session never changes provider: sending after picking another provider is blocked', (await disabled('#send')) && /Nova sessão/.test((await lastState()).note), await lastState());
	await pick('service', 'claude-code');

	// ---------- 8. end the Claude Code session; history is kept per provider ----------
	await endSession(claudeId);
	await click(page.getByRole('button', { name: /^Encerrar/ }).last());
	await waitFor(async () => (await sessionsOnHub()).some(s => s.id === claudeId && s.historical), 'the Hub archives the Claude Code session', 60000);
	await navigate(codexId);
	await waitFor(async () => (await cardId()) === codexId, 'the editor shows the Codex CLI session to end it');
	await endSession(codexId);
	await click(page.getByRole('button', { name: /^Encerrar/ }).last());
	await waitFor(async () => (await sessionsOnHub()).some(s => s.id === codexId && s.historical), 'the Hub archives the Codex CLI session', 60000);
	check('8a. Encerrar archives the Claude Code and Codex CLI sessions; OpenCode is untouched', (await live()).map(s => s.id).join() === openCodeId);
	const codexTurns = await hub.request('session.history', { id: codexId, workspace });
	check('8a2. the protected history of the Codex CLI session keeps its turns, apart from the other providers', codexTurns.length >= 3 && codexTurns.every(t => !/SINGULARITY-CLAUDE-OK/.test(t.result ?? '')), { turns: codexTurns.length });
	const turnsBefore = await hub.request('session.history', { id: claudeId, workspace });
	check('8b. the protected history of the Claude Code session keeps its turns', turnsBefore.length >= 3, { turns: turnsBefore.length });

	// ---------- 9. close and reopen the IDE: history persists, the session can be reopened and resumed ----------
	const closed = await closeIde();
	check('9a. the IDE closes', closed.forced === 0, closed);
	port += 200;
	await open();
	await waitFor(() => editor(doc => !!doc.querySelector('#composer')), 'Agentes editor after reopening', 60000);
	await waitFor(() => editor(doc => !!doc.querySelector('.session-link'), undefined, '.navigation'), 'the sidebar lists sessions after reopening', 60000);
	const reopenButton = await waitFor(() => reopenAvailable(claudeId), 'the archived Claude Code session offers Reabrir', 30000);
	check('9b. after reopening the IDE the archived Claude Code session is listed with Reabrir; the OpenCode session is still live', !!reopenButton && (await live()).some(s => s.id === openCodeId));
	await navigate(claudeId);
	await waitFor(async () => (await cardId()) === claudeId, 'the archived session opens read-only');
	await waitFor(async () => /Você/.test(await content('.session').then(() => editor(doc => doc.getElementById('sessions').innerText))), 'the protected history is shown', 20000).catch(() => undefined);
	check('9c. the archived conversation is read-only and shows its history', (await disabled('#send')) && /SINGULARITY-CLAUDE-OK/.test(await editor(doc => doc.getElementById('sessions').innerText)));
	await snap('c05-historico-claude.png');
	await reopenSession(claudeId);
	await waitFor(async () => (await sessionsOnHub()).some(s => s.id === claudeId && !s.historical && s.status === 'idle'), 'the Hub reopens the session', 60000);
	check('9d. Reabrir makes the session usable without starting any execution', claudeFor(claudeId) === 0);
	await typePrompt('What exact text is in hello.txt? Answer with only that text.');
	await waitFor(async () => !(await disabled('#send')), 'the reopened session accepts a task', 30000);
	await activate('#send');
	await settle('What exact text is in', 'the resumed task finished');
	check('9e. the reopened session resumes its original conversation', /SINGULARITY-CLAUDE-OK/.test(await content('.result')), (await content('.result')).slice(0, 80));
	await snap('c06-retomado-dark.png');

	// the archived Codex CLI session: history shown per provider, reopened, resumed
	await navigate(codexId);
	await waitFor(async () => (await cardId()) === codexId, 'the archived Codex CLI session opens read-only');
	check('9f. the archived Codex CLI conversation is read-only, shows its own history and offers Reabrir', (await disabled('#send')) && /SINGULARITY-CODEX-OK/.test(await editor(doc => doc.getElementById('sessions').innerText)) && await reopenAvailable(codexId));
	await snap('c06a-historico-codex.png');
	await reopenSession(codexId);
	await waitFor(async () => (await sessionsOnHub()).some(s => s.id === codexId && !s.historical && s.status === 'idle'), 'the Hub reopens the Codex CLI session', 60000);
	check('9g. Reabrir makes the Codex session usable without starting any execution', codexFor() === 0);
	await typePrompt('What exact text is in hello-codex.txt? Answer with only that text.');
	await waitFor(async () => !(await disabled('#send')), 'the reopened Codex session accepts a task', 30000);
	await activate('#send');
	await settle('What exact text is in hello-codex', 'the resumed Codex task finished', 240000);
	check('9h. the reopened Codex session resumes its original conversation', /SINGULARITY-CODEX-OK/.test(await content('.result')), (await content('.result')).slice(0, 80));
	await snap('c06b-codex-retomado.png');

	// ---------- 10. themes ----------
	setSetting('workbench.colorTheme', 'Event Minimal Light');
	await waitFor(() => editor(doc => doc.body.classList.contains('vscode-light')), 'light theme');
	await snap('c07-claro.png');
	check('10a. Event Minimal Light applies', true);
	setSetting('workbench.colorTheme', 'Default High Contrast');
	await waitFor(() => editor(doc => doc.body.classList.contains('vscode-high-contrast')), 'high contrast theme');
	await snap('c08-alto-contraste.png');
	check('10b. high contrast keeps visible borders on the new control', (await editor(doc => parseFloat(doc.defaultView.getComputedStyle(doc.querySelector('#permission')).borderTopWidth))) >= 1 || (await hidden('permission-field')));
	setSetting('workbench.colorTheme', 'Event Minimal Dark');
	await waitFor(() => editor(doc => doc.body.classList.contains('vscode-dark')), 'dark theme');

	// ---------- 11. the rest of the product still works ----------
	check('11a. the GitHub account entry is still in the title bar', await page.locator('.singularity-account-entry').isVisible());
	await click(page.locator('.part.sidebar').getByText('sample.txt', { exact: true }).first());
	check('11b. the Explorer still opens a conventional file', await page.locator('.tabs-container .tab').filter({ hasText: 'sample.txt' }).isVisible());
	// Browser, terminal and Git are exercised by run.cjs and browser-check.cjs on the same package; the keyboard-driven palette here
	// would only add focus noise after the theme changes.
	check('11c. the Hub is still the one that serves the three providers', (await live()).map(s => s.harness).sort().join() === 'claude-code,codex-cli,opencode');
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
		log(ok ? 'PROVIDERS CHECK PASSED' : 'PROVIDERS CHECK FAILED');
		process.exit(ok ? 0 : 1);
	}
});
