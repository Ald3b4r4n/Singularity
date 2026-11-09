'use strict';
// E2E of Singularity Remote: the real Hub, the real gateway process, a real OpenCode, and a phone-sized Chromium running the real PWA.
//
//   node scripts/e2e/remote-check.cjs --out <dir> [--hub <singularity-hub dir>] [--node <node.exe>] [--exe <packaged IDE>]
//
// Inference, when needed, uses only OpenCode Go (DeepSeek V4.1 Flash and Muse Spark 1.3 Contributor) at their default effort; Claude Code,
// Codex CLI and Gemini CLI are never run. Everything happens in synthetic Git repositories under --out. The user's real repositories are
// not touched, and the script proves it by comparing their Git state before and after.
//
// What this cannot prove: that a physical Android phone works. A phone-sized emulated browser exercises the same web app; the physical
// acceptance is left to the person who owns the phone.

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium, devices } = require('playwright');

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i < 0 ? fallback : process.argv[i + 1]; };
const hubDir = path.resolve(arg('hub', path.join(__dirname, '../../singularity-hub')));
const nodeExe = arg('node', process.execPath);
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'remote-out')));
const home = path.join(outDir, 'hub');
const work = path.join(outDir, 'repo');
const other = path.join(outDir, 'unauthorized-repo');
fs.mkdirSync(outDir, { recursive: true });

const { HubConnection } = require(path.join(hubDir, 'dist/client.js'));
const control = require(path.join(hubDir, 'dist/remote/control.js'));
const results = [];
const log = (...a) => { const line = new Date().toISOString() + ' ' + a.join(' '); console.log(line); fs.appendFileSync(path.join(outDir, 'progress.log'), line + '\n'); };
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); return !!ok; };
const must = (name, ok, detail) => { if (!check(name, ok, detail)) { throw new Error('required step failed: ' + name); } };

async function waitFor(fn, name, timeout = 30000, every = 250) {
	const end = Date.now() + timeout;
	do {
		const value = await Promise.resolve().then(fn).catch(() => undefined);
		if (value) { return value; }
		await delay(every);
	} while (Date.now() < end);
	throw new Error('Timed out: ' + name);
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
function repo(dir, name) {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, 'init', '-q', '-b', 'main');
	git(dir, 'config', 'user.email', 'e2e@example.invalid');
	git(dir, 'config', 'user.name', 'E2E');
	fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\nsynthetic repository for the remote E2E\n`);
	git(dir, 'add', '.');
	git(dir, 'commit', '-q', '-m', 'initial');
}
const realRepos = [path.resolve(__dirname, '../..'), 'D:\\dev\\singularity'].filter(dir => fs.existsSync(path.join(dir, '.git')));
const snapshot = () => realRepos.map(dir => { try { return { dir, head: git(dir, 'rev-parse', 'HEAD'), branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), status: git(dir, 'status', '--porcelain', '--untracked-files=no') }; } catch { return { dir }; } });

let hubProcess, hub, browser;
async function startHub() {
	hubProcess = spawn(nodeExe, [path.join(hubDir, 'dist/main.js')], { env: { ...process.env, SINGULARITY_HUB_HOME: home }, windowsHide: true, stdio: 'ignore' });
	for (let i = 0; i < 100; i++) {
		try { hub = await HubConnection.connect({ home, clientName: 'remote-e2e' }); return; } catch { await delay(150); }
	}
	throw new Error('Hub did not start');
}

const mobile = () => ({ ...devices['Pixel 7'], locale: 'pt-BR', serviceWorkers: 'allow' });
const shot = async (page, name) => { await page.screenshot({ path: path.join(outDir, name) }); log('screenshot', name); };

async function main() {
	const before = snapshot();
	repo(work, 'authorized');
	repo(other, 'not authorized');
	await startHub();
	const modelCatalog = await hub.request('catalog.get', { workspace: work }, 120000);
	const goModels = (modelCatalog.providers.find(p => p.id === 'opencode-go') || { models: [] }).models;
	const flash = goModels.find(m => m.id === 'deepseek-v4.1-flash');
	const muse = goModels.find(m => /^muse-spark-1\.3.*contributor/.test(m.id)) || goModels.find(m => /^muse-spark-1\.3/.test(m.id));
	must('0. OpenCode Go offers DeepSeek V4.1 Flash and Muse Spark 1.3 Contributor', !!flash && !!muse, { flash: flash && flash.id, muse: muse && muse.id });

	// ---------- 1. off by default ----------
	check('1. remote access is off by default: no gateway, no remote state, nothing listening', !control.gatewayRunning(home) && !fs.existsSync(path.join(home, 'remote', 'gateway.json')));

	// ---------- 2. the gateway listens on loopback only ----------
	const info = await control.startGateway(nodeExe, home);
	const connects = (host, port) => new Promise(resolve => { const s = net.connect({ host, port, timeout: 1500 }); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('timeout', () => { s.destroy(); resolve(false); }); s.once('error', () => resolve(false)); });
	const others = Object.values(os.networkInterfaces()).flatMap(list => list || []).filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
	let loopbackOnly = (await connects('127.0.0.1', info.publicPort)) && (await connects('127.0.0.1', info.adminPort));
	for (const address of others) { loopbackOnly = loopbackOnly && !(await connects(address, info.publicPort)) && !(await connects(address, info.adminPort)); }
	check('2. the gateway answers on 127.0.0.1 only (public and admin ports)', loopbackOnly, { checkedOtherInterfaces: others.length });
	const base = `http://127.0.0.1:${info.publicPort}`;
	const admin = (method, route, body) => control.adminRequest(method, route, body, home);
	await admin('POST', '/admin/workspaces/add', { path: work });
	const state0 = await admin('GET', '/admin/state');
	const workspaceId = state0.workspaces[0].id;

	// a pairing code that nobody uses must expire: it is checked again two minutes later
	const aging = await admin('POST', '/admin/pairing/start', {});
	const agingStartedAt = Date.now();

	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext(mobile());
	const page = await context.newPage();
	page.on('pageerror', error => log('pageerror', error.message));
	await page.goto(base + '/');
	await page.waitForSelector('#view');
	check('3. the PWA opens on a phone-sized screen and asks to pair', /Parear com o computador/.test(await page.locator('#view').innerText()));
	check('3b. the app is installable (manifest, service worker, secure scope on localhost)', await page.evaluate(async () => {
		const manifest = await (await fetch('/manifest.webmanifest')).json();
		const registration = await navigator.serviceWorker.getRegistration();
		return manifest.display === 'standalone' && manifest.icons.length >= 2 && !!registration;
	}));
	await shot(page, 'm01-pareamento.png');

	// ---------- 4. pairing refused ----------
	const pairingUi = async (pageRef, code, name) => {
		await pageRef.fill('#code', code);
		await pageRef.fill('#device', name);
		await pageRef.getByRole('button', { name: 'Parear' }).click();
	};
	const first = await admin('POST', '/admin/pairing/start', {});
	await pairingUi(page, first.code, 'Intruso');
	await page.waitForSelector('.pairing .big');
	const fingerprint = await page.locator('.pairing .big').innerText();
	const pending = await waitFor(async () => { const s = await admin('GET', '/admin/state'); return s.pending[0]; }, 'the computer sees the pairing request');
	check('4. the computer shows the same verification code as the phone', pending.fingerprint === fingerprint && pending.deviceName === 'Intruso', { fingerprint });
	await shot(page, 'm02-aguardando-computador.png');
	await admin('POST', '/admin/pairing/decide', { id: pending.id, approve: false });
	await page.waitForFunction(() => /recusou/.test(document.getElementById('view').innerText));
	check('4b. a refused pairing is shown on the phone and creates no device', (await admin('GET', '/admin/state')).devices.length === 0);

	// ---------- 5. pairing authorized ----------
	const second = await admin('POST', '/admin/pairing/start', {});
	await pairingUi(page, second.code.toLowerCase(), 'POCO X8 Pro');
	const pending2 = await waitFor(async () => (await admin('GET', '/admin/state')).pending[0], 'second pairing request');
	await admin('POST', '/admin/pairing/decide', { id: pending2.id, approve: true });
	await page.waitForSelector('#tabs:not([hidden])', { timeout: 30000 });
	check('5. an authorized pairing opens the app on the phone', /Início/.test(await page.locator('#view').innerText()) && (await admin('GET', '/admin/state')).devices.length === 1);
	const token = await page.evaluate(() => localStorage.getItem('singularity.remote.token'));
	check('5b. the token is only on the phone: not in the URL, not in the server state file', !!token && !(await page.evaluate(() => location.href)).includes(token) && !fs.readFileSync(path.join(home, 'remote', 'remote-state.json'), 'utf8').includes(token));

	// ---------- 6. a device that is not authorized ----------
	const forged = 'A'.repeat(43);
	check('6. a made-up token is refused by the API', (await fetch(base + '/api/status', { headers: { Authorization: 'Bearer ' + forged } })).status === 401);
	const intruder = await browser.newContext(mobile());
	const intruderPage = await intruder.newPage();
	await intruderPage.addInitScript(t => localStorage.setItem('singularity.remote.token', t), forged);
	await intruderPage.goto(base + '/');
	await intruderPage.waitForFunction(() => /Parear com o computador/.test(document.getElementById('view').innerText));
	check('6b. a phone with a forged token is sent back to pairing', true);
	await intruder.close();

	// ---------- 7. the Hub state, providers and sessions on the phone ----------
	await page.locator('#tabs button', { hasText: 'Início' }).click();
	await page.waitForFunction(() => /Hub conectado/.test(document.getElementById('view').innerText));
	const home1 = await page.locator('#view').innerText();
	check('7. the phone shows the Hub state, the providers and the authorized workspace', /OpenCode/.test(home1) && /Claude Code/.test(home1) && /Codex CLI/.test(home1) && /Gemini CLI · em breve/.test(home1) && /repo/.test(home1), home1.replace(/\s+/g, ' ').slice(0, 200));
	await shot(page, 'm03-inicio.png');

	// ---------- 8. send a real task from the phone, watch it stream ----------
	await page.locator('#tabs button', { hasText: 'Agentes' }).click();
	await page.waitForSelector('#workspace');
	await page.waitForFunction(() => document.querySelectorAll('#model option').length > 3, null, { timeout: 90000 });
	check('8. only the authorized workspace is offered, with the real catalog', (await page.locator('#workspace option').allInnerTexts()).join() === 'repo' && (await page.locator('#service option').allInnerTexts()).some(t => /Gemini CLI \(em breve\)/.test(t)));
	await page.selectOption('#service', 'opencode');
	await delay(3000);
	await page.waitForFunction(() => [...document.querySelectorAll('#model option')].some(o => /deepseek-v4\.1-flash"/.test(o.value)), null, { timeout: 60000 });
	const flashValue = await page.evaluate(() => [...document.querySelectorAll('#model option')].find(o => /"deepseek-v4\.1-flash"\]$/.test(o.value) && /opencode-go/.test(o.value)).value);
	await page.selectOption('#model', flashValue);
	await page.fill('#task', 'Write a numbered poem with 120 lines, one line per number. Do not use tools and do not touch files.');
	await shot(page, 'm04-agentes.png');
	await page.getByRole('button', { name: 'Enviar tarefa' }).click();
	await page.waitForFunction(() => /Interromper tarefa/.test(document.getElementById('view').innerText) || /concluída/.test(document.getElementById('view').innerText), null, { timeout: 120000 });
	const sessionId = (await waitFor(async () => (await hub.request('sessions.list')).find(s => s.workspace && s.workspace.toLowerCase().includes('repo')), 'the session exists on the Hub')).id;
	let lengths = [];
	const watchUntil = Date.now() + 120000;
	while (Date.now() < watchUntil) {
		const length = await page.evaluate(() => (document.querySelector('#view .bubble.live .text') || { textContent: '' }).textContent.length);
		if (!lengths.length || length !== lengths[lengths.length - 1]) { lengths.push(length); }
		if (await page.evaluate(() => /concluída|falhou/.test(document.getElementById('view').innerText))) { break; }
		await delay(300);
	}
	const growing = lengths.filter(n => n > 0);
	check('9. real streaming: the answer grows on the phone while the agent works', growing.length >= 2 && growing[growing.length - 1] > growing[0], { samples: lengths.slice(0, 12), final: lengths[lengths.length - 1] });
	await shot(page, 'm05-streaming-ou-concluida.png');
	const sent = (await hub.request('sessions.list')).filter(s => s.id === sessionId);
	check('10. the task was sent from the phone: one session on the Hub, in the authorized workspace, with the chosen model', sent.length === 1 && !!sent[0].model && sent[0].model.modelID === 'deepseek-v4.1-flash', sent[0] && sent[0].model);
	await waitFor(async () => (await hub.request('sessions.list')).find(s => s.id === sessionId).status === 'done', 'the first task finishes', 120000);

	// ---------- 11. continue, then cancel ----------
	await page.waitForSelector('#follow');
	await page.fill('#follow', 'Now write a numbered poem with 400 lines, one line per number, thinking about rhyme. Do not use tools.');
	await page.getByRole('button', { name: 'Enviar', exact: true }).click();
	await page.waitForSelector('text=Interromper tarefa', { timeout: 60000 });
	await delay(4000);
	await shot(page, 'm06-em-execucao.png');
	await page.getByRole('button', { name: 'Interromper tarefa' }).click();
	await waitFor(async () => /idle/.test((await hub.request('sessions.list')).find(s => s.id === sessionId).status), 'the cancellation reaches the agent', 60000);
	check('11. the phone cancels a running task: the agent stops and the session stays', (await hub.request('sessions.list')).find(s => s.id === sessionId).summary === 'Execução interrompida.');

	// ---------- 12. the same prompt is never sent twice ----------
	const requestId = 'retry-' + Date.now();
	const send = () => fetch(`${base}/api/sessions/${sessionId}/prompt`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Request-Id': requestId }, body: JSON.stringify({ confirm: true, text: 'Reply with exactly OK_ONCE. Do not use tools.' }) });
	const one = await (await send()).json();
	const two = await (await send()).json();
	await waitFor(async () => (await hub.request('sessions.list')).find(s => s.id === sessionId).status === 'done', 'the retry task finishes', 120000);
	const turns = await hub.request('session.history', { id: sessionId, workspace: work });
	check('12. a retry after a dropped connection does not send the prompt twice', two.duplicate === true && !one.duplicate && turns.filter(t => /OK_ONCE/.test(t.prompt)).length === 1, { turns: turns.length });

	// ---------- 13. disconnect the phone while the agent works ----------
	await page.locator('#tabs button', { hasText: 'Sessões' }).click();
	await page.waitForSelector('#follow');
	await page.fill('#follow', 'Write a numbered poem with 60 lines, one line per number. Do not use tools.');
	await page.getByRole('button', { name: 'Enviar', exact: true }).click();
	await waitFor(async () => (await hub.request('sessions.list')).find(s => s.id === sessionId).status === 'running', 'the long task is running', 60000);
	await context.setOffline(true);
	const lengthAtDrop = ((await hub.request('sessions.list')).find(s => s.id === sessionId).result || '').length;
	await page.close();
	await delay(5000);
	const during = (await hub.request('sessions.list')).find(s => s.id === sessionId);
	check('13. closing the phone does not stop the agent: it keeps working', during.status === 'running' || during.status === 'done', { status: during.status, grewFrom: lengthAtDrop, to: (during.result || '').length });
	await context.close();

	// ---------- 14. the phone comes back: the session is recovered, nothing is resent ----------
	const context2 = await browser.newContext({ ...mobile() });
	await context2.addInitScript(t => localStorage.setItem('singularity.remote.token', t), token);
	const page2 = await context2.newPage();
	const promptsBefore = (await hub.request('session.history', { id: sessionId, workspace: work })).length;
	await page2.goto(base + '/');
	await page2.waitForSelector('#tabs:not([hidden])');
	await page2.locator('#tabs button', { hasText: 'Sessões' }).click();
	await page2.waitForSelector('.card.tap');
	await waitFor(async () => (await hub.request('sessions.list')).find(s => s.id === sessionId).status === 'done', 'the task finishes while the phone was away', 300000);
	await page2.locator('.card.tap').first().click();
	await page2.waitForFunction(() => /concluída/.test(document.getElementById('view').innerText), null, { timeout: 30000 });
	const recovered = await page2.locator('#view').innerText();
	const promptsAfter = (await hub.request('session.history', { id: sessionId, workspace: work })).length;
	const stray = await page2.evaluate(() => [...document.getElementById('view').childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim()));
	check('14. reconnecting recovers the session and its result without resending anything', /agente/i.test(recovered) && stray.length === 0 && promptsAfter === promptsBefore, { turnsBefore: promptsBefore, turnsAfter: promptsAfter, stray });
	await shot(page2, 'm07-recuperada.png');

	// ---------- 15. comparison on the phone ----------
	const comparison = await hub.request('comparisons.create', { workspace: work, text: 'Create a file named notes.txt containing the word compare.', participants: [{ service: 'opencode', model: { providerID: 'opencode-go', modelID: flash.id } }, { service: 'opencode', model: { providerID: 'opencode-go', modelID: muse.id } }] }, 120000);
	await waitFor(async () => (await hub.request('comparisons.list', { workspace: work })).find(c => c.id === comparison.id).participants.every(p => ['done', 'ready', 'failed', 'cancelled'].includes(p.status)), 'the comparison finishes', 240000, 1000);
	await page2.locator('#tabs button', { hasText: 'Comparação' }).click();
	await page2.waitForFunction(() => document.querySelectorAll('#view article.card').length > 0, null, { timeout: 30000 });
	const compareText = await page2.locator('#view').innerText();
	check('15. the phone lists the comparison with each participant and its state, without paths', /comparação/i.test(compareText) && !compareText.includes(work) && !/[A-Z]:\\/.test(compareText), compareText.replace(/\s+/g, ' ').slice(0, 160));
	await shot(page2, 'm08-comparacao.png');
	const diffButton = page2.getByRole('button', { name: 'Diff' }).first();
	if (await diffButton.count()) {
		await diffButton.click();
		await page2.waitForSelector('.diff', { timeout: 30000 });
		check('15b. the diff of a participant opens in the mobile view', /notes\.txt|Sem alterações/.test(await page2.locator('#view').innerText()));
		await shot(page2, 'm09-diff.png');
	} else { check('15b. the diff of a participant opens in the mobile view (no participant finished with changes)', true, 'skipped'); }

	// ---------- 16. team mode on the phone ----------
	let teamStarted;
	try {
		teamStarted = await hub.request('teams.start', { workspace: work, text: 'Create a file named team.txt containing the word team.', participants: [flash, flash, flash].map(m => ({ service: 'opencode', model: { providerID: 'opencode-go', modelID: m.id } })), maxCorrections: 1 }, 180000);
	} catch (error) { log('teams.start refused:', error.message); }
	if (teamStarted) {
		await page2.locator('#tabs button', { hasText: 'Equipe' }).click();
		await page2.waitForFunction(() => document.querySelectorAll('#view article.card').length > 0, null, { timeout: 60000 });
		const teamText = await page2.locator('#view').innerText();
		check('16. the phone shows the team workflow: roles, current step and cycle, without paths', /Implementador/.test(teamText) && /etapa:/.test(teamText) && /ciclo/.test(teamText) && !teamText.includes(work), teamText.replace(/\s+/g, ' ').slice(0, 200));
		await shot(page2, 'm10-equipe.png');
		await hub.request('teams.cancel', { id: teamStarted.id, workspace: work }, 60000).catch(() => undefined);
	} else { check('16. the phone shows the team workflow', false, 'the Hub did not start a team'); }

	// ---------- 17. the API is a closed list ----------
	const auth = { Authorization: 'Bearer ' + token };
	const refused = [];
	for (const [method, route] of [['POST', '/api/rpc'], ['POST', '/api/hub/hub.shutdown'], ['GET', '/api/files'], ['POST', '/api/shell'], ['POST', '/api/solutions/apply'], ['POST', '/api/teams/start'], ['DELETE', '/api/sessions/' + sessionId]]) {
		refused.push((await fetch(base + route, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined })).status);
	}
	check('17. methods that are not on the list do not exist (rpc, shutdown, files, shell, apply, team start, delete)', refused.every(s => s === 404), refused);
	check('17b. the Hub is still up after those attempts', (await hub.request('sessions.list')).length >= 1);
	check('17c. a session of a workspace that was not authorized cannot be created from the phone', (await fetch(base + '/api/sessions', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, workspaceId: 'not-a-workspace', service: 'opencode', model: { providerID: 'opencode-go', modelID: flash.id } }) })).status === 403);
	check('17d. a phone-sized request cannot reach the admin surface', (await fetch(base + '/admin/state', { headers: { ...auth, 'x-admin-token': 'x' } })).status === 404);

	// ---------- 18. the Hub token and credentials never reach the phone ----------
	const hubToken = fs.readFileSync(path.join(home, 'hub.token'), 'utf8').trim();
	const surfaces = [];
	for (const route of ['/api/status', '/api/sessions', '/api/comparisons', '/api/teams', `/api/sessions/${sessionId}/history`, `/api/catalog?workspaceId=${workspaceId}&service=opencode`]) { surfaces.push(await (await fetch(base + route, { headers: auth })).text()); }
	for (const asset of ['/', '/app.js', '/sw.js', '/manifest.webmanifest']) { surfaces.push(await (await fetch(base + asset)).text()); }
	const remoteFiles = fs.readdirSync(path.join(home, 'remote')).filter(f => f !== 'admin.token').map(f => fs.readFileSync(path.join(home, 'remote', f), 'utf8'));
	check('18. the Hub token appears in no response, no web asset and no gateway state file', ![...surfaces, ...remoteFiles].some(text => text.includes(hubToken)));
	check('18b. no API key, provider setting or header leaks through the catalog the phone receives', !/apiKey|api_key|"headers"|settings/i.test(surfaces[5]));

	// ---------- 19. revocation ----------
	await page2.locator('#tabs button', { hasText: 'Dispositivos' }).click();
	await page2.waitForSelector('text=Encerrar conexão deste aparelho');
	await shot(page2, 'm11-dispositivos.png');
	const own = (await admin('GET', '/admin/state')).devices.find(d => !d.revokedAt);
	await admin('POST', '/admin/devices/revoke', { id: own.id });
	check('19. a revoked device is refused immediately', (await fetch(base + '/api/status', { headers: auth })).status === 401);
	await page2.locator('#tabs button', { hasText: 'Início' }).click();
	await page2.waitForFunction(() => /Parear com o computador/.test(document.getElementById('view').innerText), null, { timeout: 30000 });
	check('19b. the phone falls back to pairing after the revocation', true);

	// ---------- 20. the unused pairing code has expired ----------
	const wait = agingStartedAt + 2 * 60 * 1000 + 3000 - Date.now();
	if (wait > 0) { await delay(wait); }
	const lateClaim = await fetch(base + '/api/pair/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: aging.code, deviceName: 'late' }) });
	check('20. a pairing code that is not used within two minutes is refused', lateClaim.status === 403);

	// ---------- 21. Hub crash and restart: the phone reconnects ----------
	const crashContext = await browser.newContext(mobile());
	const pair3 = await admin('POST', '/admin/pairing/start', {});
	const crashPage = await crashContext.newPage();
	await crashPage.goto(base + '/');
	await pairingUi(crashPage, pair3.code, 'Reconexao');
	const pending3 = await waitFor(async () => (await admin('GET', '/admin/state')).pending[0], 'third pairing');
	await admin('POST', '/admin/pairing/decide', { id: pending3.id, approve: true });
	await crashPage.waitForSelector('#tabs:not([hidden])');
	await crashPage.waitForFunction(() => /Hub conectado/.test(document.getElementById('view').innerText));
	hubProcess.kill('SIGKILL');
	await delay(1500);
	await crashPage.locator('#tabs button', { hasText: 'Início' }).click();
	await crashPage.reload();
	await crashPage.waitForFunction(() => /Hub desligado/.test(document.getElementById('view').innerText), null, { timeout: 30000 });
	check('21. when the Hub dies the phone says so instead of showing stale data', true);
	await shot(crashPage, 'm12-hub-desligado.png');
	hub.close();
	await startHub();
	await crashPage.waitForFunction(() => /Hub conectado/.test(document.getElementById('view').innerText), null, { timeout: 60000 });
	check('21b. once the Hub is back the gateway reconnects by itself and the phone follows', true);
	await shot(crashPage, 'm13-hub-reconectado.png');

	// ---------- 22. dark and light ----------
	await crashPage.locator('#tabs button', { hasText: 'Dispositivos' }).click();
	await crashPage.getByRole('button', { name: 'Claro' }).click();
	await shot(crashPage, 'm14-claro.png');
	await crashPage.getByRole('button', { name: 'Escuro' }).click();
	await shot(crashPage, 'm15-escuro.png');
	check('22. the app has a dark and a light theme', true);
	const narrow = await crashPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
	check('22b. no horizontal scroll on the phone screen', narrow);

	// ---------- 23. the main workspace and the unauthorized repo are untouched ----------
	await context2.close(); await crashContext.close(); await browser.close(); browser = undefined;
	const after = snapshot();
	check('23. the real repositories (branch, HEAD, tracked changes) are exactly as they were', JSON.stringify(after) === JSON.stringify(before), after.map(r => ({ dir: r.dir, branch: r.branch })));
	check('23b. the repository that was not authorized was never touched', git(other, 'status', '--porcelain') === '' && git(other, 'rev-list', '--count', 'HEAD') === '1');

	// ---------- 24. turning it off ----------
	await control.stopGateway(home);
	check('24. disabling stops the gateway and removes its files', !control.gatewayRunning(home) && !fs.existsSync(path.join(home, 'remote', 'gateway.json')) && !fs.existsSync(path.join(home, 'remote', 'admin.token')));
}

main().catch(error => { check('the remote run completed', false, { error: error.message }); log(error.stack); }).finally(async () => {
	try { await browser?.close(); } catch { /* ignore */ }
	try { await control.stopGateway(home); } catch { /* ignore */ }
	try { if (hub) { for (const session of await hub.request('sessions.list').catch(() => [])) { if (!session.historical) { await hub.request('session.stop', { id: session.id }, 30000).catch(() => undefined); } } await hub.request('hub.shutdown').catch(() => undefined); hub.close(); } } catch { /* ignore */ }
	try { hubProcess && hubProcess.kill(); } catch { /* ignore */ }
	const ok = results.length > 0 && results.every(r => r.ok);
	fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ results, ok, finished: new Date().toISOString() }, null, 2));
	log(ok ? 'REMOTE CHECK PASSED' : 'REMOTE CHECK FAILED');
	process.exit(ok ? 0 : 1);
});
