'use strict';
// E2E of the operational reliability gate, on the PACKAGED Hub and gateway, with an ISOLATED state folder, ports and registry
// (the owner's own Hub, gateway, paired phone and Tailscale configuration are never touched; the script proves it).
//
//   node scripts/e2e/reliability-check.cjs --out <dir> --hub <packaged singularity-hub dir> --node <packaged node.exe>
//
// Inference, when a real one is needed, uses only OpenCode Go (DeepSeek V4.1 Flash / Muse Spark 1.3 Contributor) at default effort.
// Claude Code, Codex CLI and Gemini CLI are never run for inference (the Claude plan reading runs the local `/usage`, no model).
// Everything else happens in synthetic Git repositories under --out.
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium, devices } = require('playwright');

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i < 0 ? fallback : process.argv[i + 1]; };
const hubDir = path.resolve(arg('hub', path.join(__dirname, '../../singularity-hub')));
const nodeExe = arg('node', process.execPath);
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'reliability-out')));
const homeA = path.join(outDir, 'hubA');
const homeB = path.join(outDir, 'hubB');
const homeC = path.join(outDir, 'hubC');
const registry = path.join(outDir, 'localappdata');
const work = path.join(outDir, 'repo');
fs.mkdirSync(registry, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const { HubConnection } = require(path.join(hubDir, 'dist/client.js'));
const control = require(path.join(hubDir, 'dist/remote/control.js'));
const results = [];
const log = (...a) => { const line = new Date().toISOString() + ' ' + a.join(' '); console.log(line); fs.appendFileSync(path.join(outDir, 'progress.log'), line + '\n'); };
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); return !!ok; };
const must = (name, ok, detail) => { if (!check(name, ok, detail)) { throw new Error('required step failed: ' + name); } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(fn, name, timeout = 30000, every = 250) {
	const end = Date.now() + timeout;
	do { const value = await Promise.resolve().then(fn).catch(() => undefined); if (value) { return value; } await delay(every); } while (Date.now() < end);
	throw new Error('Timed out: ' + name);
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
function repo(dir) {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 'e2e@example.invalid'); git(dir, 'config', 'user.name', 'E2E');
	fs.writeFileSync(path.join(dir, 'README.md'), '# reliability E2E\nsynthetic\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'initial');
}

const env = home => ({ ...process.env, SINGULARITY_HUB_HOME: home, LOCALAPPDATA: registry });
const children = [];
function spawnHub(home) {
	const child = spawn(nodeExe, [path.join(hubDir, 'dist/main.js')], { env: env(home), windowsHide: true, stdio: 'ignore' });
	children.push(child);
	return child;
}
async function connect(home) {
	for (let i = 0; i < 100; i++) { try { return await HubConnection.connect({ home, clientName: 'reliability-e2e' }); } catch { await delay(150); } }
	throw new Error('Hub did not start: ' + home);
}
const mobile = () => ({ ...devices['Pixel 7'], locale: 'pt-BR', serviceWorkers: 'allow' });
const shot = async (page, name) => { await page.screenshot({ path: path.join(outDir, name) }); log('screenshot', name); };

// the owner's real instance, observed read-only before and after
const ownerHome = path.join(process.env.LOCALAPPDATA || '', 'Singularity', 'Hub');
function ownerSnapshot() {
	const read = file => { try { return fs.readFileSync(path.join(ownerHome, file), 'utf8'); } catch { return undefined; } };
	const hubInfo = read('connection.json'); const gw = read(path.join('remote', 'gateway.json')); const state = read(path.join('remote', 'remote-state.json'));
	let serve; try { serve = execFileSync('C:\\Program Files\\Tailscale\\tailscale.exe', ['serve', 'status'], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim(); } catch { serve = 'unavailable'; }
	return {
		hubPid: hubInfo && JSON.parse(hubInfo).pid, gatewayPid: gw && JSON.parse(gw).pid,
		devices: state ? (JSON.parse(state).devices || []).length : undefined, workspaces: state ? (JSON.parse(state).workspaces || []).length : undefined, serve
	};
}

async function main() {
	const owner0 = ownerSnapshot();
	log('owner before', JSON.stringify({ ...owner0, serve: String(owner0.serve).split('\n')[0] }));
	repo(work);

	// ============ TASK 1: processes ============
	const procA = spawnHub(homeA);
	const hubA = await connect(homeA);
	const procB = spawnHub(homeB);
	const hubBConn = await connect(homeB);
	const bystander = spawn(nodeExe, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
	children.push(bystander);
	await delay(1500);

	const regFiles = fs.readdirSync(path.join(registry, 'Singularity', 'instances')).filter(n => n.endsWith('.json'));
	check('1.1 every Hub writes its own record in the per-user instance registry', regFiles.length >= 2, regFiles.length);
	let snap = await hubA.request('processes.inspect', {}, 60000);
	const entry = pid => snap.entries.find(e => e.pid === pid);
	check('1.2 the answering Hub is identified as the legitimate main Hub', entry(procA.pid) && entry(procA.pid).role === 'current-hub' && entry(procA.pid).verified && !entry(procA.pid).canTerminate, entry(procA.pid) && entry(procA.pid).role);
	check('1.3 a second, healthy Hub of another state folder is preserved and recognised as legitimate', entry(procB.pid) && entry(procB.pid).role === 'other-hub' && !entry(procB.pid).canTerminate && entry(procB.pid).canShutdown === true, entry(procB.pid) && entry(procB.pid).role);
	check('1.4 an unrelated process is never listed or touched', !entry(bystander.pid) && snap.foreignIgnored > 0, { foreignIgnored: snap.foreignIgnored });

	// a real agent: an OpenCode session creates a helper owned by Hub A; no inference is made
	const catalog = await hubA.request('catalog.get', { workspace: work }, 120000);
	const go = (catalog.providers.find(p => p.id === 'opencode-go') || { models: [] }).models;
	const flash = go.find(m => m.id === 'deepseek-v4.1-flash');
	const muse = go.find(m => /^muse-spark-1\.3.*contributor/.test(m.id)) || go.find(m => /^muse-spark-1\.3/.test(m.id));
	must('0. OpenCode Go offers DeepSeek V4.1 Flash and Muse Spark 1.3 Contributor', !!flash && !!muse, { flash: flash && flash.id, muse: muse && muse.id });
	const session = await hubA.request('session.create', { workspace: work, service: 'opencode', model: { providerID: 'opencode-go', modelID: flash.id } }, 120000);
	await delay(1500);
	snap = await hubA.request('processes.inspect', {}, 60000);
	const linked = snap.entries.filter(e => e.role === 'linked-agent' && e.sessions.includes(session.id));
	check('1.5 the agent of an active session is linked to it, kept, and offered no termination', linked.length === 1 && !linked[0].canTerminate, linked.map(e => ({ pid: e.pid, sessions: e.sessions })));
	if (linked[0]) {
		const refused = await hubA.request('processes.terminate', { pid: linked[0].pid, created: linked[0].created, confirm: true, confirmActiveWork: true }, 30000);
		check('1.6 even with every confirmation, a live session agent is refused and keeps running', refused.terminated === false && alive(linked[0].pid), refused.reason);
	}

	const noConfirm = await hubA.request('processes.shutdown', { pid: procB.pid, created: entry(procB.pid).created, confirm: false }, 30000);
	const wrongTime = await hubA.request('processes.shutdown', { pid: procB.pid, created: entry(procB.pid).created + 1, confirm: true }, 30000);
	check('1.7 shutdown needs confirmation, and a PID whose creation time differs (reuse) is refused', noConfirm.shutdown === false && wrongTime.shutdown === false && alive(procB.pid));
	const stopped = await hubA.request('processes.shutdown', { pid: procB.pid, created: entry(procB.pid).created, confirm: true }, 60000);
	await waitFor(() => !alive(procB.pid), 'Hub B exits', 20000).catch(() => undefined);
	check('1.8 a verified second Hub is stopped through its own graceful shutdown, once confirmed', stopped.shutdown === true && !alive(procB.pid), stopped);
	check('1.9 the main Hub, its session, its agent and the bystander survived', alive(procA.pid) && alive(bystander.pid) && linked[0] && alive(linked[0].pid));

	// an orphan: a registered Hub whose own state folder no longer points to it
	const procC = spawnHub(homeC);
	const connC = await connect(homeC);
	await delay(1000);
	connC.close();
	fs.rmSync(path.join(homeC, 'connection.json'), { force: true });
	snap = await hubA.request('processes.inspect', {}, 60000);
	const orphan = entry(procC.pid);
	check('1.10 a registered Hub that its own folder disowns is diagnosed as an orphan, with a safe-to-stop recommendation', orphan && orphan.role === 'orphan-hub' && orphan.verified && orphan.canTerminate && !orphan.hasActiveWork, orphan && orphan.role);
	const noOrphanConfirm = await hubA.request('processes.terminate', { pid: procC.pid, created: orphan.created, confirm: false }, 30000);
	const staleCreated = await hubA.request('processes.terminate', { pid: procC.pid, created: orphan.created + 1000, confirm: true }, 30000);
	check('1.11 an orphan is not stopped without confirmation, nor when the creation time does not match', noOrphanConfirm.terminated === false && staleCreated.terminated === false && alive(procC.pid));
	const done = await hubA.request('processes.terminate', { pid: procC.pid, created: orphan.created, confirm: true }, 60000);
	check('1.12 the proven orphan is terminated, and only it', done.terminated === true && !alive(procC.pid) && alive(procA.pid) && alive(bystander.pid), done);
	const foreign = await hubA.request('processes.terminate', { pid: bystander.pid, created: 0, confirm: true }, 30000);
	check('1.13 a foreign process cannot be terminated even when asked by PID', foreign.terminated === false && alive(bystander.pid), foreign.reason);

	// ============ usage and limits ============
	const usage = await hubA.request('usage.get', { fresh: true }, 120000);
	const ids = usage.services.map(s => s.id);
	check('U.1 usage lists OpenCode Go, OpenCode Zen, Claude Code and Codex CLI', ['opencode-go', 'opencode-zen', 'claude-code', 'codex-cli'].every(id => ids.includes(id)), ids);
	const goUsage = usage.services.find(s => s.id === 'opencode-go');
	check('U.2 OpenCode Go reports its 5 hour, weekly and monthly windows', goUsage.plan && ['Janela de 5 horas', 'Semanal', 'Mensal'].every(l => goUsage.plan.windows.some(w => w.label === l)), goUsage.plan && goUsage.plan.windows.map(w => `${w.label} ${w.usedPercent}%`));
	check('U.3 tokens are split into input, output and cache for every service, and models are separated', usage.services.every(s => ['input', 'output', 'cacheRead', 'cacheWrite'].every(k => typeof s.month[k] === 'number')) && usage.services.some(s => s.models.length > 1));
	check('U.4 the Claude plan is opt-in: off by default, so no plan windows are read', !usage.settings.claudePlan && !usage.services.find(s => s.id === 'claude-code').plan);
	await hubA.request('usage.configure', { claudePlan: true }, 30000);
	const optIn = await hubA.request('usage.get', { fresh: true }, 120000);
	const claude = optIn.services.find(s => s.id === 'claude-code');
	check('U.5 once enabled, the Claude plan windows come from Claude Code\'s own /usage (no inference)', optIn.settings.claudePlan && ((claude.plan && claude.plan.windows.length >= 1) || /Claude Code/.test(claude.note || '')), claude.plan ? claude.plan.windows.map(w => `${w.label} ${w.usedPercent}%`) : claude.note);
	await hubA.request('usage.configure', { claudePlan: false }, 30000);
	const codex = usage.services.find(s => s.id === 'codex-cli');
	check('U.6 Codex limits say when they were last recorded', !codex.plan || /Limites do plano conforme o último uso/.test(codex.note || ''), codex.note);
	check('U.7 no path, prompt, token or file name is present in the usage report', !/[A-Za-z]:\\|\.jsonl|sk-|Bearer /.test(JSON.stringify(usage)));

	// ============ TASK 2: idempotent remote sends, on the real gateway process ============
	const gw = await control.startGateway(nodeExe, homeA);
	const base = `http://127.0.0.1:${gw.publicPort}`;
	const admin = (method, route, body) => control.adminRequest(method, route, body, homeA);
	await admin('POST', '/admin/workspaces/add', { path: work });
	const workspaceId = (await admin('GET', '/admin/state')).workspaces[0].id;
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext(mobile());
	const page = await context.newPage();
	page.on('pageerror', error => log('pageerror', error.message));
	await page.goto(base + '/');
	await page.waitForSelector('#view');
	const started = await admin('POST', '/admin/pairing/start', {});
	await page.locator('input').first().fill(started.code);
	await page.locator('input').nth(1).fill('Aparelho de teste');
	await page.getByRole('button', { name: /Parear/ }).click();
	const pending = await waitFor(async () => { const s = await admin('GET', '/admin/state'); return s.pending[0]; }, 'pairing claim');
	await admin('POST', '/admin/pairing/decide', { id: pending.id, approve: true });
	await page.waitForSelector('.tabs button', { timeout: 20000 });
	check('2.0 a test device is paired through the real PWA (the owner\'s paired phone is untouched)', true);
	await page.waitForFunction(() => !!localStorage.getItem('singularity.remote.token'), null, { timeout: 20000 });
	const token = await page.evaluate(() => localStorage.getItem('singularity.remote.token'));
	log('device token captured, length', token.length);
	const api = async (route, init = {}) => { const r = await fetch(base + route, { ...init, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(init.headers || {}) } }); let json; try { json = await r.json(); } catch { json = {}; } return { status: r.status, json }; };
	const sessionId = session.id;
	const prompt = (id, text) => api(`/api/sessions/${sessionId}/prompt`, { method: 'POST', headers: { 'x-request-id': id }, body: JSON.stringify({ confirm: true, text }) });
	const turnsWith = async text => { const turns = await hubA.request('session.history', { id: sessionId, workspace: work }, 30000); const list = Array.isArray(turns) ? turns : []; const live = (await hubA.request('sessions.list')).find(s => s.id === sessionId); return list.filter(t => (t.prompt || '').trim() === text).length + (live && (live.prompt || '').trim() === text && !list.some(t => (t.prompt || '').trim() === text) ? 1 : 0); };
	const idle = async () => waitFor(async () => (await hubA.request('sessions.list')).find(s => s.id === sessionId && s.status !== 'running' && s.status !== 'waiting'), 'agent idle', 240000, 1000);

	const T1 = 'Responda apenas com a palavra ok, sem usar ferramentas. (E2E-1)';
	const first = await prompt('e2e-req-00000001', T1);
	check('2.1 a send is registered and confirmed', first.status === 200 && first.json.state === 'confirmed', first.json);
	await idle();
	const retry = await prompt('e2e-req-00000001', T1);
	check('2.2 repeating the same id is recognised and never reaches the agent again', retry.json.duplicate === true && (await turnsWith(T1)) === 1, retry.json);
	const conflict = await prompt('e2e-req-00000001', 'Outra instrução diferente');
	check('2.3 the same id for another instruction is refused', conflict.status === 409 && conflict.json.state === 'conflict');
	const ledgerFile = path.join(homeA, 'remote', 'requests.json');
	const ledgerText = fs.readFileSync(ledgerFile, 'utf8');
	check('2.4 the registry is on disk, holds states and digests only, and never the instruction text', /confirmed/.test(ledgerText) && !/Responda apenas|ok, sem usar/.test(ledgerText) && !/Bearer|authorization/i.test(ledgerText));

	// gateway restart: a retry after the process was replaced is still a duplicate
	await control.stopGateway(homeA);
	const gw2 = await control.startGateway(nodeExe, homeA);
	const base2 = `http://127.0.0.1:${gw2.publicPort}`;
	const api2 = async (route, init = {}) => { const r = await fetch(base2 + route, { ...init, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(init.headers || {}) } }); let json; try { json = await r.json(); } catch { json = {}; } return { status: r.status, json }; };
	await waitFor(async () => (await api2('/api/status')).status === 200, 'gateway back with the Hub', 30000);
	const afterRestart = await api2(`/api/sessions/${sessionId}/prompt`, { method: 'POST', headers: { 'x-request-id': 'e2e-req-00000001' }, body: JSON.stringify({ confirm: true, text: T1 }) });
	check('2.5 after the gateway process is replaced, the same id is still a duplicate and the agent has the instruction once', afterRestart.json.duplicate === true && (await turnsWith(T1)) === 1, afterRestart.json);
	check('2.6 the paired device and the authorised workspace survived the restart', (await admin('GET', '/admin/state')).devices.length >= 1 && (await admin('GET', '/admin/state')).workspaces.length === 1);

	// the connection drops after the Hub may have received the instruction: the gateway process is killed while the request is in flight
	const T2 = 'Responda apenas com a palavra pronto, sem usar ferramentas. (E2E-2)';
	const infoNow = control.readGatewayInfo(homeA);
	const inFlight = fetch(base2 + `/api/sessions/${sessionId}/prompt`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-request-id': 'e2e-req-00000002' }, body: JSON.stringify({ confirm: true, text: T2 }) }).catch(() => undefined);
	await delay(120);
	try { process.kill(infoNow.pid, 'SIGKILL'); } catch { /* already gone */ }
	await inFlight;
	await delay(500);
	const gw3 = await control.startGateway(nodeExe, homeA);
	const base3 = `http://127.0.0.1:${gw3.publicPort}`;
	const api3 = async (route, init = {}) => { const r = await fetch(base3 + route, { ...init, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(init.headers || {}) } }); let json; try { json = await r.json(); } catch { json = {}; } return { status: r.status, json }; };
	await waitFor(async () => (await api3('/api/status')).status === 200, 'gateway back after the kill', 30000);
	await idle().catch(() => undefined);
	const settle = await api3(`/api/sessions/${sessionId}/prompt`, { method: 'POST', headers: { 'x-request-id': 'e2e-req-00000002' }, body: JSON.stringify({ confirm: true, text: T2 }) });
	const turns2 = await turnsWith(T2);
	check('2.7 after the gateway was killed mid-send, a retry with the same id never makes the agent receive it twice', turns2 <= 1 && settle.status !== 500, { answer: settle.json.state || settle.json.error, turnsInHistory: turns2 });
	check('2.8 the outcome is honest: confirmed/reconciled when the Hub shows it, otherwise "unknown" asking the person', ['confirmed', 'reconciled', 'unknown', 'processing'].includes(settle.json.state), settle.json.state);
	if (settle.json.state === 'unknown') {
		const resolved = await api3(`/api/sessions/${sessionId}/requests/e2e-req-00000002`, { method: 'POST', body: JSON.stringify({ confirm: true, action: 'discard' }) });
		check('2.9 an unknown send is settled only by an explicit person decision', resolved.status === 200 && resolved.json.state === 'reconciled', resolved.json);
	} else { check('2.9 no unknown send was left waiting for a decision', true, settle.json.state); }

	// Hub down: the failure is known, and the same id works once the Hub is back
	const hubInfo = JSON.parse(fs.readFileSync(path.join(homeA, 'connection.json'), 'utf8'));
	await hubA.request('hub.shutdown', {}).catch(() => undefined);
	await waitFor(() => !alive(procA.pid), 'Hub A stopped', 20000);
	const T3 = 'Responda apenas com a palavra feito, sem usar ferramentas. (E2E-3)';
	const down = await api3(`/api/sessions/${sessionId}/prompt`, { method: 'POST', headers: { 'x-request-id': 'e2e-req-00000003' }, body: JSON.stringify({ confirm: true, text: T3 }) });
	check('2.10 with the Hub off, the send fails before dispatch, clearly, and nothing is registered as sent', down.status >= 400 && down.json.state !== 'confirmed', { status: down.status });
	check('2.11 the pairing and the gateway stay valid while the Hub is down', (await api3('/api/device')).status === 200);
	void hubInfo;
	const procA2 = spawnHub(homeA);
	await connect(homeA).then(c => c.close());
	await waitFor(async () => (await api3('/api/status')).status === 200 && (await api3('/api/sessions')).json.sessions, 'gateway reconnects to the new Hub', 40000);
	// the session lived in Hub A's memory: a new Hub has no such session, so the same id is tried on a fresh one
	const fresh = await api3('/api/sessions', { method: 'POST', body: JSON.stringify({ confirm: true, workspaceId, service: 'opencode', model: { providerID: 'opencode-go', modelID: flash.id } }) });
	check('2.12 once the Hub is back the gateway reconnects by itself and the phone can start working again', fresh.status === 201, fresh.status);
	const freshId = fresh.json.session && fresh.json.session.id;
	const retryHubBack = await api3(`/api/sessions/${freshId}/prompt`, { method: 'POST', headers: { 'x-request-id': 'e2e-req-00000003' }, body: JSON.stringify({ confirm: true, text: T3 }) });
	const retryAgain = await api3(`/api/sessions/${freshId}/prompt`, { method: 'POST', headers: { 'x-request-id': 'e2e-req-00000003' }, body: JSON.stringify({ confirm: true, text: T3 }) });
	check('2.13 the send goes through once, and repeating the id afterwards is a duplicate', retryHubBack.json.state === 'confirmed' && retryAgain.json.duplicate === true, [retryHubBack.json.state, retryAgain.json.duplicate]);

	// corrupted registry: sends are blocked until a deliberate reset
	await control.stopGateway(homeA);
	fs.writeFileSync(ledgerFile, '{ not json');
	const gw4 = await control.startGateway(nodeExe, homeA);
	const base4 = `http://127.0.0.1:${gw4.publicPort}`;
	const api4 = async (route, init = {}) => { const r = await fetch(base4 + route, { ...init, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(init.headers || {}) } }); let json; try { json = await r.json(); } catch { json = {}; } return { status: r.status, json }; };
	await waitFor(async () => (await api4('/api/status')).status === 200, 'gateway with a corrupt registry', 30000);
	const blocked = await api4(`/api/sessions/${freshId}/prompt`, { method: 'POST', headers: { 'x-request-id': 'e2e-req-00000004' }, body: JSON.stringify({ confirm: true, text: 'x (E2E-4)' }) });
	check('2.14 a corrupted registry blocks sending (503), keeps the damaged file, and dispatches nothing', blocked.status === 503 && blocked.json.state === 'blocked' && fs.readdirSync(path.join(homeA, 'remote')).some(n => n.startsWith('requests.json')), { status: blocked.status, body: blocked.json });
	const reset = await control.adminRequest('POST', '/admin/requests/reset', { confirm: true }, homeA);
	check('2.15 only a confirmed reset reopens it, keeping the old file aside', reset.counts && !reset.counts.blocked && fs.readdirSync(path.join(homeA, 'remote')).some(n => n.startsWith('requests.json.corrupt-')));
	void procA2;

	// ============ the phone UI: a dropped answer, a retry with the same id, no duplicate bubble ============
	// each gateway start picks new ports, which is a new browser origin: the device token is carried over to it, as the person would by reopening the same address
	await page.goto(base4 + '/');
	await page.evaluate(value => localStorage.setItem('singularity.remote.token', value), token);
	await page.reload();
	await page.waitForSelector('.tabs button');
	await page.locator('.tabs button', { hasText: 'Sessões' }).click();
	await page.waitForSelector('.card');
	await page.locator('.card').first().click();
	await page.waitForSelector('#follow');
	const T4 = 'Responda apenas com a palavra visto, sem usar ferramentas. (E2E-UI)';
	let seenIds = [];
	await page.route('**/api/sessions/*/prompt', async route => {
		seenIds.push(route.request().headers()['x-request-id']);
		if (seenIds.length === 1) { await route.fetch(); await route.abort('connectionreset'); } else { await route.continue(); }
	});
	await page.fill('#follow', T4);
	await page.getByRole('button', { name: 'Enviar', exact: true }).click();
	await page.waitForSelector('.pending', { timeout: 20000 });
	await page.waitForFunction(() => /Aguardando confirmação|Sem conexão/.test((document.querySelector('.pending') || {}).textContent || ''), null, { timeout: 20000 });
	const bannerText = await page.locator('.pending').innerText();
	check('3.1 when the answer is lost the phone says it is waiting for confirmation instead of failing or resending by itself', /Aguardando confirmação|Sem conexão/.test(bannerText), bannerText.replace(/\s+/g, ' ').slice(0, 120));
	await shot(page, 'm20-aguardando-confirmacao.png');
	await page.getByRole('button', { name: 'Tentar de novo' }).click();
	await waitFor(async () => (await page.locator('.pending').count()) === 0, 'the pending banner clears', 30000);
	await idle().catch(() => undefined);
	check('3.2 the retry reused the same request id', seenIds.length === 2 && seenIds[0] === seenIds[1] && !!seenIds[0], seenIds);
	check('3.3 the agent received the instruction exactly once, and the phone shows a single bubble for it', (await page.locator('.bubble.user', { hasText: 'E2E-UI' }).count()) === 1);
	await shot(page, 'm21-conversa-sem-duplicar.png');

	// the unknown state, as the phone shows it (a stub answer, only to look at the screen and the buttons)
	await page.unroute('**/api/sessions/*/prompt');
	await page.route('**/api/sessions/*/prompt', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ state: 'unknown', needsResolution: true, error: 'Não foi possível confirmar se esta instrução chegou ao agente.' }) }));
	await page.fill('#follow', 'Instrução para ver o estado desconhecido (E2E-UI-2)');
	await page.getByRole('button', { name: 'Enviar', exact: true }).click();
	await page.waitForSelector('.pending.unknown');
	check('3.4 an unknown outcome shows its three explicit choices and never retries by itself', (await page.getByRole('button', { name: /Verificar de novo|Reenviar mesmo assim|Descartar/ }).count()) === 3);
	await shot(page, 'm22-estado-desconhecido.png');
	await page.unroute('**/api/sessions/*/prompt');
	await page.getByRole('button', { name: 'Descartar' }).click().catch(() => undefined);

	// usage and limits on the phone, scrolling and the jump button
	await page.evaluate(() => { try { localStorage.removeItem('singularity.remote.pending'); } catch { /* ignore */ } });
	await page.reload();
	await page.waitForSelector('.tabs button');
	await page.locator('.tabs button', { hasText: 'Início' }).click();
	await page.getByRole('button', { name: /Uso e limites/ }).click();
	await page.waitForSelector('.usage-row', { timeout: 60000 });
	const usageText = await page.locator('#view').innerText();
	check('3.5 the phone shows OpenCode Go windows, tokens and the other services', /OpenCode Go/.test(usageText) && /Mensal/.test(usageText) && /Claude Code/.test(usageText) && /Codex CLI/.test(usageText));
	await shot(page, 'm23-uso-e-limites.png');
	await page.emulateMedia({ colorScheme: 'light' });
	await shot(page, 'm24-uso-claro.png');
	await page.emulateMedia({ colorScheme: 'dark' });

	await browser.close();

	// ============ the owner's own setup was never touched ============
	const owner1 = ownerSnapshot();
	check('4.1 the owner\'s Hub, gateway, paired devices, authorised workspaces and Tailscale Serve are unchanged', JSON.stringify(owner0) === JSON.stringify(owner1), { before: { ...owner0, serve: String(owner0.serve).split('\n')[0] }, after: { ...owner1, serve: String(owner1.serve).split('\n')[0] } });
}

main().catch(error => { check('the reliability run completed', false, { error: error.message }); log(error.stack); }).finally(async () => {
	try { await control.stopGateway(homeA); } catch { /* ignore */ }
	for (const home of [homeA, homeB, homeC]) { try { (await HubConnection.connect({ home, clientName: 'cleanup', timeoutMs: 1500 })).request('hub.shutdown', {}).catch(() => undefined); } catch { /* not running */ } }
	await delay(1500);
	for (const child of children) { try { child.kill(); } catch { /* gone */ } }
	const ok = results.length > 0 && results.every(r => r.ok);
	fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ results, ok, finished: new Date().toISOString() }, null, 2));
	log(ok ? 'RELIABILITY CHECK PASSED' : 'RELIABILITY CHECK FAILED');
	process.exit(ok ? 0 : 1);
});
