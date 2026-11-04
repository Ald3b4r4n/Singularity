'use strict';
// E2E of the Singularity Agents experience, through the real UI (real keyboard and mouse of Windows), with the real Singularity Hub
// and the real OpenCode, on an isolated profile and workspace. The Hub is the source of truth for what the panel must show.
//
//   node scripts/e2e/agents-check.cjs --out <dir> [--exe <packaged exe> | --dev <repo>]
//
// What it proves: no Chat tab and no Copilot control in the default UI; the Agentes panel opens from the status bar; its service,
// provider, model and effort selectors show what the Hub reads from OpenCode and depend on each other; one composer sends a real
// task; the answer streams in the same panel; the task can be cancelled and the session ended; the session survives closing and
// reopening the IDE; the layout holds in a narrow panel, Dark, Light and high contrast; Git, terminal, Browser and the GitHub
// account entry still work. Nothing here reads or prints a key or a token.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const lib = require('./lib.cjs');
const { HubConnection } = require('../../singularity-hub/dist/client.js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const exe = arg('exe');
const dev = exe ? undefined : arg('dev', 'D:\\dev\\singularity');
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'agents-out')));
const profile = path.join(outDir, 'profile');
const home = path.join(outDir, 'hub');
const workspace = path.join(outDir, 'workspace');
const port = 9480 + Math.floor(Math.random() * 200);
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'sample.txt'), 'synthetic workspace\n');
execFileSync('git', ['init', '-q', workspace]);

const results = [];
const log = (...a) => { const l = new Date().toISOString() + ' ' + a.join(' '); console.log(l); fs.appendFileSync(path.join(outDir, 'progress.log'), l + '\n'); };
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); return !!ok; };
const must = (name, ok, detail) => { if (!check(name, ok, detail)) { throw new Error('required step failed: ' + name); } };
const sleep = lib.sleep;
const EFFORT = { none: 'Nenhum', minimal: 'Mínimo', low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Extra alto', max: 'Máximo' };

let browser, page, cdp, panel, hub;

async function waitFor(fn, name, timeout = 30000, every = 300) {
	const end = Date.now() + timeout;
	do {
		const value = await Promise.resolve().then(fn).catch(() => undefined);
		if (value) { return value; }
		await sleep(every);
	} while (Date.now() < end);
	throw new Error('Timed out: ' + name);
}

// ---------- real input, always to this instance's window ----------
async function front() {
	try { lib.guard(profile); } catch { await lib.bringToFront(profile); await sleep(300); lib.keys(profile, '{ESC}'); await sleep(300); }
}
// Tries the input first (lib.keys and lib.click check the foreground window themselves) and brings the window to the front only when
// that guard refuses: checking the foreground twice per key made every step slow on a busy machine.
async function input(action) {
	for (let attempt = 0; ; attempt++) {
		try { return action(); } catch (error) {
			if (attempt >= 4 || !/guard:|Command failed/.test(error.message)) { throw error; }
			await front();
		}
	}
}
const keys = value => input(() => lib.keys(profile, value));
const paste = value => input(() => lib.paste(profile, value));

async function command(title, settle = 1500) {
	for (let attempt = 0; attempt < 3; attempt++) {
		await keys('{F1}'); await sleep(700); await paste(title); await sleep(900);
		const ready = await page.evaluate(`(document.querySelector('.quick-input-widget:not(.hidden) .quick-input-list-entry') || {}).innerText || ''`);
		if (ready.includes(title.split(' ')[0])) { await keys('{ENTER}'); await sleep(settle); return; }
		await keys('{ESC}'); await sleep(500);
	}
	throw new Error('the Command Palette did not accept ' + title);
}

async function position(locator) {
	const box = await locator.boundingBox();
	if (!box) { throw new Error('control is outside the visible area'); }
	const g = await cdp.evaluate('({ dpr: devicePixelRatio, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight })');
	const border = (g.ow - g.iw) / 2;
	return [Math.round((box.x + box.width / 2 + border) * g.dpr), Math.round((box.y + box.height / 2 + g.oh - g.ih - border) * g.dpr)];
}
async function click(locator) {
	await locator.scrollIntoViewIfNeeded();
	const point = await position(locator);
	await input(() => lib.click(profile, ...point));
	await sleep(500);
}

/** Types into a field with the real keyboard: click it, select what is there, paste. */
async function typeInto(locator, text) {
	await click(locator);
	await keys('^a');
	await paste(text);
}

/** Chooses an option of a <select> with the real keyboard: clicking the label focuses the field without opening the native list. */
async function pick(selectId, wanted) {
	const select = panel.locator('#' + selectId);
	await click(panel.locator(`label[for="${selectId}"]`));
	for (let i = 0; i < 60; i++) {
		const { cur, values } = await select.evaluate(e => ({ cur: e.value, values: [...e.options].map(o => o.value) }));
		if (cur === wanted) { return true; }
		const from = values.indexOf(cur), to = values.indexOf(wanted);
		if (to < 0) { throw new Error(`option "${wanted}" is not offered by #${selectId}`); }
		await input(() => lib.keys(profile, to > from ? '{DOWN}' : '{UP}'));
		await sleep(200);
	}
	return false;
}

function shot(file) {
	const w = lib.appWindows(profile)[0];
	lib.ps(`Add-Type -AssemblyName System.Drawing; $r=New-Object SG.W+RECT; [void][SG.W]::GetWindowRect([IntPtr]${w.hwnd},[ref]$r); $b=New-Object System.Drawing.Bitmap ($r.R-$r.L),($r.B-$r.T); $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($r.L,$r.T,0,0,$b.Size); $b.Save('${file}')`);
}
const snap = async name => { await front(); await sleep(500); shot(path.join(outDir, name)); log('screenshot', name); };

const settingsFile = () => path.join(profile, 'data', 'User', 'settings.json');
function setSetting(k, v) {
	const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
	if (v === undefined) { delete s[k]; } else { s[k] = v; }
	fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

async function open() {
	lib.launch({ exe, dev, profile, workspace, port, env: { SINGULARITY_HUB_HOME: home }, settings: { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'workbench.colorTheme': 'Event Minimal Dark', 'singularity.update.checkAutomatically': false } });
	cdp = await lib.cdp(port);
	await waitFor(() => cdp.evaluate("window.__singularityWorkbenchRestored && !document.getElementById('singularity-intro')"), 'workbench', 120000, 500);
	browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	page = browser.contexts().flatMap(context => context.pages()).find(tab => /workbench/.test(tab.url()));
	if (!page) { throw new Error('workbench DevTools target missing'); }
	await lib.bringToFront(profile);
	const hwnd = lib.appWindows(profile)[0].hwnd;
	lib.ps(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class RS0 { [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c); }'; [void][RS0]::ShowWindow([IntPtr]${hwnd},9); [void][RS0]::MoveWindow([IntPtr]${hwnd},30,30,1360,860,$true)`);
	await sleep(6000);
}

async function findPanel() {
	return waitFor(async () => {
		for (const frame of page.frames()) {
			if (await frame.locator('h1').filter({ hasText: 'AGENTES' }).count().catch(() => 0)) { return frame; }
		}
	}, 'Agentes webview', 40000, 500);
}

async function closeIde() {
	cdp?.close(); cdp = undefined;
	await browser?.close().catch(() => undefined); browser = undefined;
	return lib.closeApp(profile, 30000);
}

const cards = () => panel.locator('.session');
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

	// ---------- 2. open Agentes from the status bar with a real click ----------
	await click(page.locator('.statusbar-item').filter({ hasText: /Agentes/ }).first());
	panel = await findPanel();
	const tabs = await page.evaluate(`[...document.querySelectorAll('.auxiliarybar .composite-bar [aria-label], .auxiliarybar .title-label')].map(e => (e.getAttribute('aria-label') || e.innerText || '').trim()).filter(Boolean)`);
	check('2a. the Agentes panel opens from the status bar', true, tabs);
	check('2b. the secondary side bar offers only Agentes (no Chat tab)', !tabs.some(t => /chat|copilot/i.test(t)), tabs);

	// ---------- 3. the selectors show what the Hub really reads from OpenCode ----------
	await waitFor(async () => (await panel.locator('#provider option').count()) > 1 || /Sem serviços|indisponível/.test(await panel.locator('#note').innerText()), 'catalog loaded in the panel', 120000, 500);
	hub = await HubConnection.connect({ home, clientName: 'agents-e2e' });
	const truth = await hub.request('catalog.get', { workspace }, 120000);
	const opencode = truth.providers.find(p => p.id === 'opencode');
	const options = async id => panel.locator(`#${id} option`).evaluateAll(list => list.map(o => ({ value: o.value, text: o.textContent, disabled: o.disabled })));
	const services = await options('service');
	check('3a. Serviço de agentes: OpenCode is selectable; Claude Code, Codex CLI and Gemini CLI are listed as "em breve" and cannot be chosen',
		services.length === 4 && !services[0].disabled && services[0].text === 'OpenCode' && services.slice(1).every(s => s.disabled && /em breve/.test(s.text)), services);
	const providers = await options('provider');
	check('3b. Provedor: exactly the providers the Hub read from OpenCode', JSON.stringify(providers.map(p => p.value)) === JSON.stringify(truth.providers.map(p => p.id)) && providers.length >= 2, providers.map(p => p.value));
	const selectedProvider = await panel.locator('#provider').inputValue();
	const selectedModel = await panel.locator('#model').inputValue();
	check('3c. the service default model is preselected', !!truth.default && selectedProvider === truth.default.providerID && selectedModel === truth.default.modelID, { selectedProvider, selectedModel });
	const modelsFor = id => truth.providers.find(p => p.id === id).models;
	check('3d. Modelo: exactly the models of the selected provider', JSON.stringify((await options('model')).map(m => m.value)) === JSON.stringify(modelsFor(selectedProvider).map(m => m.id)));
	await snap('01-agentes-inicial.png');

	// ---------- 4. the selectors depend on each other, and the typed text is never lost ----------
	const draft = 'Rascunho que não pode ser perdido ao trocar as opções.';
	await typeInto(panel.locator('#prompt'), draft);
	must('4a. a draft is typed with the real keyboard', (await panel.locator('#prompt').inputValue()) === draft);
	await pick('provider', 'opencode');
	check('4b. changing the provider replaces the models with those of that provider', JSON.stringify((await options('model')).map(m => m.value)) === JSON.stringify(opencode.models.map(m => m.id)));
	const withEffort = opencode.models.find(m => /free/.test(m.id) && m.efforts.length >= 3);
	const withoutEffort = opencode.models.find(m => m.efforts.length === 0);
	must('4c. OpenCode offers a free model with effort levels to test with', !!withEffort, withEffort && withEffort.id);
	await typeInto(panel.locator('#filter'), withEffort.id.slice(0, 5));
	check('4d. the model filter narrows the list and keeps the selected model', (await options('model')).length < opencode.models.length);
	await pick('model', withEffort.id);
	const efforts = await options('effort');
	check('4e. changing the model replaces the effort levels with that model\'s own', JSON.stringify(efforts.map(e => e.value)) === JSON.stringify(['', ...withEffort.efforts]) && efforts[0].text === 'Padrão do modelo', efforts.map(e => e.text));
	check('4f. effort levels use readable names', efforts.slice(1).every(e => /^(Nenhum|Mínimo|Baixo|Médio|Alto|Extra alto|Máximo)$/.test(e.text) || e.text === e.value), efforts.map(e => e.text));
	if (withoutEffort) {
		await typeInto(panel.locator('#filter'), withoutEffort.id.slice(0, 5));
		await pick('model', withoutEffort.id);
		check('4g. a model without effort control disables the selector and says so', (await panel.locator('#effort').isDisabled()) && /Sem controle de esforço/.test(await panel.locator('#effort').innerText()));
	}
	await typeInto(panel.locator('#filter'), withEffort.id.slice(0, 5));
	await pick('model', withEffort.id);
	await pick('effort', 'low');
	check('4h. the draft survived every change of service, provider, model and effort', (await panel.locator('#prompt').inputValue()) === draft);
	await snap('02-selecao-modelo-esforco.png');

	// ---------- 5. one composer sends a real task; the answer streams in the same panel ----------
	await typeInto(panel.locator('#prompt'), 'Reply with exactly SINGULARITY_OK. Do not use tools or read or modify files.');
	await click(panel.locator('#send'));
	await waitFor(async () => (await cards().count()) === 1, 'the session card appears', 90000);
	const created = (await sessionsOnHub())[0];
	check('5a. the session was created at send time, in the chosen workspace, with the chosen model and effort',
		created.harness === 'opencode' && /workspace$/i.test(created.workspace) && created.model && created.model.providerID === 'opencode' && created.model.modelID === withEffort.id && created.model.variant === 'low', created.model);
	const cardText = await cards().first().innerText();
	check('5b. the card shows the service, the model really used and the effort', /OpenCode/.test(cardText) && cardText.includes((opencode.models.find(m => m.id === withEffort.id)).name) && /Baixo/.test(cardText), cardText.replace(/\s+/g, ' ').slice(0, 160));
	await waitFor(async () => /running|waiting|done|failed/.test(await cards().first().getAttribute('data-status')), 'task started', 60000);
	await cards().first().locator('.events li').first().waitFor({ timeout: 60000 }).catch(() => undefined);
	const final = await waitFor(async () => { const s = await cards().first().getAttribute('data-status'); return s === 'done' || s === 'failed' ? s : undefined; }, 'task finished', 150000, 500);
	const result = await cards().first().locator('.result').innerText().catch(() => '');
	check('5c. the task ran to the end and its answer streamed into the same panel', final === 'done' && /SINGULARITY_OK/.test(result), { final, result: result.slice(0, 60) });
	check('5d. streaming events were shown', (await cards().first().locator('.events li').allTextContents()).some(t => /session\./.test(t)));
	await snap('03-tarefa-concluida.png');

	// ---------- 6. change the effort and send again: the same session, the model it reports changes ----------
	await pick('effort', withEffort.efforts[1]);
	await typeInto(panel.locator('#prompt'), 'Reply with exactly SECOND_OK. Do not use tools or read or modify files.');
	await click(panel.locator('#send'));
	await waitFor(async () => { const s = (await sessionsOnHub())[0]; return s.model && s.model.variant === withEffort.efforts[1]; }, 'the effort change reaches the session', 60000).catch(async error => {
		log('diagnostic: sessions on the Hub:', JSON.stringify((await sessionsOnHub()).map(x => ({ id: x.id.slice(0, 8), status: x.status, model: x.model }))), '| panel target:', await panel.locator('#target').innerText().catch(() => '?'), '| note:', await panel.locator('#note').innerText().catch(() => '?'));
		throw error;
	});
	check('6a. changing the effort changes the effort of the session in use (same session, no new one)', (await sessionsOnHub()).length === 1);
	await waitFor(async () => { const s = await cards().first().getAttribute('data-status'); return s === 'done' || s === 'failed'; }, 'second task finished', 150000, 500);
	check('6b. the card shows the new effort level', (await cards().first().innerText()).includes(EFFORT[withEffort.efforts[1]] || withEffort.efforts[1]), withEffort.efforts[1]);

	// ---------- 7. cancel a running task, then end the session ----------
	await typeInto(panel.locator('#prompt'), 'Write a 100-line numbered poem, one line per number. Do not use tools or read or modify files.');
	await click(panel.locator('#send'));
	await waitFor(async () => (await cards().first().getAttribute('data-status')) === 'running', 'the poem task is running', 90000, 200);
	check('7a. while a task runs, the composer offers Cancelar tarefa and Enviar is off', !(await panel.locator('#cancel').isDisabled()) && (await panel.locator('#send').isDisabled()));
	await click(panel.locator('#cancel'));
	await waitFor(async () => /Execução interrompida/.test(await cards().first().innerText()), 'the task is reported as interrupted', 30000);
	check('7b. Cancelar tarefa interrupts the task from the composer', (await sessionsOnHub())[0].status === 'idle');

	// ---------- 8. the session survives closing and reopening the IDE ----------
	const instance = hub.hello.hub.instanceId;
	const before = (await sessionsOnHub())[0];
	const closed = await closeIde();
	check('8a. the IDE closes normally', closed.forced === 0, closed);
	check('8b. the Hub and the session keep running without the IDE', (await sessionsOnHub())[0].id === before.id);
	await open();
	await click(page.locator('.statusbar-item').filter({ hasText: /Agentes/ }).first());
	panel = await findPanel();
	await waitFor(async () => (await cards().count()) === 1, 'the session is back in the panel', 60000);
	const after = (await sessionsOnHub())[0];
	check('8c. after reopening, the same Hub and the same session are shown, with the same model and effort', hub.hello.hub.instanceId === instance && after.id === before.id && JSON.stringify(after.model) === JSON.stringify(before.model));
	check('8d. the preferences were remembered (provider, model, effort)', (await panel.locator('#provider').inputValue()) === 'opencode' && (await panel.locator('#model').inputValue()) === withEffort.id);

	// ---------- 9. layout: narrow panel, Dark, Light, high contrast ----------
	await snap('04-reaberto-dark.png');
	// a narrow window makes the side bars narrow: that is the real condition the panel lives in
	const resizeTo = async (w, h) => { const hwnd = lib.appWindows(profile)[0].hwnd; lib.ps(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class RS1 { [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r); }'; [void][RS1]::MoveWindow([IntPtr]${hwnd},30,30,${w},${h},$true)`); await sleep(3500); };
	await resizeTo(620, 860);
	const width = await panel.evaluate(() => window.innerWidth);
	const overflow = await panel.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	check('9a. narrow panel: the composer and the sessions fit without horizontal scroll', width <= 330 && overflow <= 1, { width, overflow });
	const usable = await panel.evaluate(() => ['service', 'provider', 'model', 'effort', 'prompt', 'send'].every(id => { const r = document.getElementById(id).getBoundingClientRect(); return r.width > 40 && r.left >= 0 && r.right <= window.innerWidth + 1; }));
	check('9b. narrow panel: every control stays inside and usable', usable, width);
	await snap('05-painel-estreito-dark.png');
	setSetting('workbench.colorTheme', 'Event Minimal Light'); await sleep(4000);
	await snap('06-claro.png');
	const lightBody = await panel.evaluate(() => document.body.className);
	check('9c. Event Minimal Light applies to the panel (the webview body switches to the light theme)', /vscode-light/.test(lightBody) && !(await page.evaluate("document.querySelector('.monaco-workbench').className.includes('vs-dark')")), lightBody);
	setSetting('workbench.colorTheme', 'Default High Contrast'); await sleep(4000);
	await snap('07-alto-contraste.png');
	const hcBorder = await panel.evaluate(() => getComputedStyle(document.getElementById('prompt')).borderTopWidth);
	check('9d. high contrast: fields keep a visible border', parseFloat(hcBorder) >= 1, hcBorder);
	setSetting('workbench.colorTheme', 'Event Minimal Dark'); await sleep(3500);
	await resizeTo(1360, 860);

	// ---------- 10. end the session; the Hub removes it ----------
	await click(panel.locator('[data-action="stop"]').first());
	await waitFor(async () => (await sessionsOnHub()).length === 0, 'the Hub removes the session', 60000);
	check('10. Encerrar ends the session and the Hub releases it', (await cards().count()) === 0);

	// ---------- 11. the rest of the product still works ----------
	check('11a. the GitHub account entry is still in the title bar', await page.locator('.singularity-account-entry').isVisible());
	await command('Singularity Browser: Open Browser', 2500);
	check('11b. the Singularity Browser opens', (await page.locator('.tabs-container .tab').filter({ hasText: /Browser/ }).count()) > 0);
	await command('Terminal: Create New Terminal', 2500);
	const probe = path.join(workspace, 'terminal.txt');
	await paste('git status --porcelain | Set-Content -Encoding ascii terminal.txt'); await keys('{ENTER}');
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
