'use strict';
// Actual providers in the packaged Windows IDE. All repositories, worktrees and profiles are synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');
const WebSocket = require('../../singularity-hub/node_modules/ws');
const ui = require('./lib.cjs');
const exe = path.resolve(process.argv[2]);
const root = path.resolve(process.argv[3]);
assert(!fs.existsSync(root), 'Use a new test directory.');
const dist = path.join(path.dirname(exe), 'resources/app/singularity-hub/dist');
const runtime = path.join(path.dirname(exe), 'resources/app/singularity-hub/runtime/node.exe');
const { HubConnection } = require(path.join(dist, 'client.js'));
const home = path.join(root, 'hub'), workspace = path.join(root, 'workspace'), profile = path.join(root, 'profile');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'sample.txt'), 'base\n');
const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
git('init', '-q'); git('add', '.'); git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', 'commit', '-qm', 'base');
const base = git('rev-parse', 'HEAD');
const env = { ...process.env, SINGULARITY_HUB_HOME: home, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), OPENCODE_API_KEY: '', OPENCODE_ZEN_API_KEY: '', OPENCODE_GO_API_KEY: '' };
let child, client, browser, page, port = 25000 + Math.floor(Math.random() * 6000);
const report = { base, checks: [], comparisons: [] };
const streamed = [];
const jobs = [];
const helper = path.join(dist, 'singularity-job.exe');
function rememberJobs() {
	const directory = path.join(home, 'recovery');
	if (!fs.existsSync(directory)) { return; }
	for (const file of fs.readdirSync(directory).filter(f => f.endsWith('.dpapi'))) {
		const encrypted = Buffer.from(fs.readFileSync(path.join(directory, file), 'utf8'), 'base64');
		const plain = spawnSync(helper, ['unprotect-recovery'], { input: encrypted, windowsHide: true });
		if (plain.status === 0) { const job = JSON.parse(plain.stdout); if (!jobs.some(j => j.sessionId === job.sessionId)) { jobs.push(job); } plain.stdout.fill(0); }
	}
}

const check = (name, ok, detail) => { assert(ok, name); report.checks.push({ name, ok: true, detail }); console.log(name); };
async function until(fn, label, ms = 150000) {
	const end = Date.now() + ms;
	while (Date.now() < end) { const result = await fn(); if (result) { return result; } await ui.sleep(250); }
	throw new Error('Timed out: ' + label);
}
async function startHub() {
	child = spawn(runtime, [path.join(dist, 'main.js')], { env, windowsHide: true, stdio: 'ignore' });
	return until(async () => { try { return await HubConnection.connect({ home, clientName: 'comparison-e2e' }); } catch { return undefined; } }, 'packaged Hub');
}
async function doc(fn, args) {
	for (const target of (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(t => t.type === 'iframe')) {
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		try {
			await once(socket, 'open'); const reply = once(socket, 'message');
			socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(() => { const d = document.querySelector('iframe#active-frame')?.contentDocument; return d?.querySelector('#mode-comparison') ? (${fn.toString()})(d, ${JSON.stringify(args ?? null)}) : undefined; })()`, returnByValue: true } }));
			const value = JSON.parse((await reply)[0]).result?.result?.value;
			if (value !== undefined) { return value; }
		} finally { socket.close(); }
	}
}
async function launch() {
	ui.launch({ exe, profile, workspace, port, env, settings: { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'singularity.agents.hub.autoStart': false, 'singularity.update.checkAutomatically': false, 'workbench.colorTheme': 'Event Minimal Dark' } });
	await ui.waitPage(port); browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('workbench'));
	await until(() => doc(d => { d.querySelector('#mode-comparison').click(); return true; }), 'comparison UI');
}
async function configure(selections) {
	await doc((d, count) => { const select = d.querySelector('#comparison-count'); select.value = String(count); select.dispatchEvent(new Event('change', { bubbles: true })); return true; }, selections.length);
	for (const [index, selection] of selections.entries()) {
		await doc((d, x) => { const s = d.querySelector(`[data-index="${x.index}"][data-field="service"]`); s.value = x.service; s.dispatchEvent(new Event('change', { bubbles: true })); return true; }, { index, ...selection });
		await until(() => doc((d, x) => {
			const s = d.querySelector(`[data-index="${x.index}"][data-field="model"]`);
			const option = [...s.options].find(o => o.value.endsWith('\t' + x.model)); if (!option) { return false; }
			s.value = option.value; s.dispatchEvent(new Event('change', { bubbles: true }));
			const e = d.querySelector(`[data-index="${x.index}"][data-field="effort"]`); if ([...e.options].some(o => o.value === 'low')) { e.value = 'low'; e.dispatchEvent(new Event('change', { bubbles: true })); }
			return true;
		}, { index, ...selection }), 'model ' + selection.model);
	}
}
const list = () => client.request('comparisons.list', { workspace });
async function submit(text) {
	const before = (await list()).length;
	await doc((d, value) => { const p = d.querySelector('#prompt'); p.value = value; p.dispatchEvent(new Event('input', { bubbles: true })); return true; }, text);
	await until(() => doc(d => { const b = d.querySelector('#send'); if (b.disabled) { return false; } b.click(); return true; }), 'enabled comparison send');
	return until(async () => { const runs = await list(); return runs.length > before && runs.at(-1).participants.every(p => p.status !== 'preparing') ? runs.at(-1) : undefined; }, 'created comparison');
}
async function terminal(id) { return until(async () => { const r = (await list()).find(r => r.id === id); return r.participants.every(p => !['running', 'preparing'].includes(p.status)) ? r : undefined; }, 'terminal comparison', 240000); }
const inspect = (run, p) => client.request('comparisons.inspect', { workspace, id: run.id, participantId: p.id });
const shot = name => page.screenshot({ path: path.join(root, name) });
async function main() {
	client = await startHub();
	client.on('notification', (method, payload) => { if (method === 'session.event') { streamed.push(payload.event); } });
	await client.request('session.subscribe', {});
	await launch();
	const two = [{ service: 'claude-code', model: process.env.SINGULARITY_E2E_CLAUDE_MODEL || 'sonnet' }, { service: 'codex-cli', model: process.env.SINGULARITY_E2E_CODEX_MODEL || 'gpt-5.6-luna' }];
	await configure(two);
	let run = await submit('Read sample.txt and replace its content with exactly COMPARISON-OK. Then explain that change as 100 numbered short lines. Use only this worktree.');
	check('Two providers launched in parallel', run.participants.every(p => p.status === 'running'), run.participants.map(p => ({ service: p.service, model: p.model, sessionId: p.sessionId })));
	check('Independent worktrees share the exact base', run.participants.every(p => execFileSync('git', ['-C', p.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === base) && new Set(run.participants.map(p => p.workspace)).size === 2);
	await until(() => doc((d, id) => { const b = d.querySelector(`[data-cmp="cancel"][data-participant="${id}"]`); if (!b) { return false; } b.click(); return true; }, run.participants[0].id), 'individual cancel');
	run = await terminal(run.id);
	check('Individual cancellation preserves the other result', run.participants[0].status === 'cancelled' && run.participants[1].status === 'done', run.participants.map(p => p.status));
	let result = await inspect(run, run.participants[1]);
	check('Real file edit and diff are inspectable', /COMPARISON-OK/.test(result.diff));
	await doc((d, id) => { d.querySelector(`[data-cmp="inspect"][data-participant="${id}"]`).click(); return true; }, run.participants[1].id);
	await until(() => doc(d => !!d.querySelector('.comparison-diff')), 'visible diff');
	await shot('dois-agentes.png');
	report.comparisons.push({ id: run.id, participants: run.participants.map(p => ({ id: p.id, service: p.service, status: p.status })), base: run.base });
	await ui.closeApp(profile); await browser.close(); port++;
	const sessionIds = run.participants.map(p => p.sessionId);
	await launch();
	check('IDE reopen retains the same comparison and sessions', (await list()).some(r => r.id === run.id && r.participants.every((p, i) => p.sessionId === sessionIds[i])));
	await until(() => doc(d => !!d.querySelector('[data-cmp="new"]')), 'restored comparison');
	await doc(d => { d.querySelector('[data-cmp="new"]').click(); return true; });
	await configure([...two, { service: 'opencode', model: 'crouton-alpha-free' }]);
	run = await submit('Read sample.txt and replace its entire content with exactly THREE-AGENTS-OK. Answer DONE. Use only this worktree.');
	run = await terminal(run.id);
	rememberJobs();
	check('Individual provider streams observed', run.participants.every(p => streamed.some(e => e.sessionId === p.sessionId && ['opencode.event', 'claude.event', 'codex.event'].includes(e.type))));
	check('Three real providers completed', run.participants.every(p => p.status === 'done'), run.participants.map(p => ({ service: p.service, status: p.status, error: p.error })));
	for (const p of run.participants) {
		const result = await inspect(run, p); check('Isolated result and diff for ' + p.service, /THREE-AGENTS-OK/.test(result.diff));
		await doc((d, id) => { d.querySelector(`[data-cmp="inspect"][data-participant="${id}"]`).click(); return true; }, p.id);
	}
	await until(() => doc(d => d.querySelectorAll('.comparison-diff').length === 3), 'three visible diffs');
	await doc((d, id) => { d.querySelector(`[data-cmp="select"][data-participant="${id}"]`).click(); return true; }, run.participants[1].id);
	await until(async () => (await list()).find(r => r.id === run.id)?.selected === run.participants[1].id, 'chosen result');
	await shot('tres-agentes.png');
	report.comparisons.push({ id: run.id, participants: run.participants.map(p => ({ id: p.id, service: p.service, status: p.status })), base: run.base });
	check('Main workspace remains unchanged', git('status', '--porcelain') === '' && fs.readFileSync(path.join(workspace, 'sample.txt'), 'utf8') === 'base\n');
	await doc(d => { d.querySelector('[data-cmp="new"]').click(); return true; });
	await configure([{ service: 'opencode', model: 'crouton-alpha-free' }, two[1]]);
	const events = []; client.on('notification', (method, payload) => { if (method === 'session.event') { events.push(payload.event); } });
	await client.request('session.subscribe', {});
	run = await submit('Without tools, write a numbered poem with 500 lines, one line per number.');
	await until(() => events.some(e => e.sessionId === run.participants[0].sessionId && e.type === 'opencode.event'), 'OpenCode live events');
	rememberJobs();
	const firstInstance = client.hello.hub.instanceId;
	const closed = once(client, 'close'); child.kill(); await closed;
	client = await startHub();
	check('Only the Hub was restarted', client.hello.hub.instanceId !== firstInstance);
	const recovered = (await list()).find(r => r.id === run.id);
	check('OpenCode control recovered without duplicate execution', recovered.participants[0].sessionId === run.participants[0].sessionId && ['running', 'done'].includes(recovered.participants[0].status));
	check('Interrupted Codex session accurately marked unrecoverable', recovered.participants[1].status === 'unrecoverable');
	let resumedSse = false;
	client.on('notification', (method, payload) => { if (method === 'session.event' && payload.event?.sessionId === run.participants[0].sessionId && payload.event?.data?.name === 'session.text.delta') { resumedSse = true; } });
	await client.request('session.subscribe', {});
	await until(() => resumedSse, 'post-recovery SSE', 30000);
	check('Recovered OpenCode SSE resumes', resumedSse);
	await client.request('comparisons.cancel', { id: run.id, workspace, participantId: run.participants[0].id }, 60000);
	await until(() => doc(d => d.querySelector('#comparison-results').textContent.includes('não recuperável')), 'visible recovery condition');
	await shot('recuperacao.png');
	check('Recovery never edits the main workspace', git('status', '--porcelain') === '');
	// Stop all remaining live sessions through their authenticated owners before shutdown.
	for (const s of await client.request('sessions.list')) { if (!s.historical && !s.recovery) { await client.request('session.stop', { id: s.id }, 60000); } }
	check('Authenticated OpenCode job controls no longer accept connections', jobs.every(job => spawnSync(helper, ['inspect-job', job.pipeId, String(job.helperPid)], { input: job.control, windowsHide: true }).status !== 0));
	check('All surviving sessions stopped', (await client.request('sessions.list')).every(s => s.historical || s.recovery));
	const clean = await client.request('comparisons.create', { workspace, text: 'Reply OK without tools.', participants: two.map(p => ({ service: p.service, model: { providerID: p.service, modelID: p.model, variant: 'low' } })) }, 120000);
	const cleanResult = await terminal(clean.id);
	const metrics = await Promise.all(cleanResult.participants.map(p => inspect(cleanResult, p)));
	check('CLI usage contains only provider-reported numbers', metrics.every(m => m.usage && Object.values(m.usage).every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)), metrics.map(m => ({ service: m.participant.service, usage: m.usage })));
	await client.request('comparisons.cleanup', { workspace, id: clean.id }, 60000);
	check('Clean worktrees safely removed', (await list()).find(r => r.id === clean.id).participants.every(p => p.removed));
	check('Modified worktrees retained', await client.request('comparisons.cleanup', { workspace, id: report.comparisons[1].id }).then(() => false, () => true));
	fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
	const processCheck = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='opencode.exe' OR Name='claude.exe' OR Name='codex.exe' OR Name='singularity-job.exe'\" | Where-Object { $_.CommandLine -like '*" + root.replaceAll("'", "''") + "*' }).Count"], { encoding: 'utf8', windowsHide: true }).trim();
	check('No provider or helper processes reference the synthetic test root', processCheck === '0');
	fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
	console.log('Packaged multiagent E2E passed.');
}
main().catch(e => { console.error(e); fs.writeFileSync(path.join(root, 'failure.json'), JSON.stringify({ message: e.message, checks: report.checks }, null, 2)); process.exitCode = 1; }).finally(async () => {
	if (client) { await client.request('hub.shutdown', {}).catch(() => {}); client.close(); }
	if (browser) { await ui.closeApp(profile).catch(() => {}); await browser.close().catch(() => {}); }
	if (child?.exitCode === null) { await ui.sleep(1200); if (child.exitCode === null) { child.kill(); } }
});
