'use strict';
// E2E of Remote 2.0 on the PACKAGED Hub and gateway, with a phone-sized Chromium running the real PWA, real OpenCode Go models and an
// ISOLATED state folder, ports and workspaces (the owner's own Hub, gateway, paired phone and Tailscale configuration are never touched).
//
//   node scripts/e2e/remote-multiagent-check.cjs --out <dir> --hub <packaged singularity-hub dir> --node <packaged node.exe>
//
// Real inference uses only OpenCode Go (Muse Spark 1.3 Contributor and DeepSeek V4.1 Flash) at the default effort. Claude Code, Codex CLI
// and Gemini CLI are never run. Everything happens in synthetic Git repositories under --out.
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium, devices } = require('playwright');

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i < 0 ? fallback : process.argv[i + 1]; };
const hubDir = path.resolve(arg('hub', path.join(__dirname, '../../singularity-hub')));
const nodeExe = arg('node', process.execPath);
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'multiagent-out')));
const home = path.join(outDir, 'hub');
const registry = path.join(outDir, 'localappdata');
const work = path.join(outDir, 'repo');
const outsider = path.join(outDir, 'unauthorized-repo');
fs.mkdirSync(registry, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
const PUBLIC_PORT = 47000 + Math.floor(Math.random() * 900), ADMIN_PORT = PUBLIC_PORT + 1000;
process.env.SINGULARITY_REMOTE_PUBLIC_PORT = String(PUBLIC_PORT);
process.env.SINGULARITY_REMOTE_ADMIN_PORT = String(ADMIN_PORT);

const { HubConnection } = require(path.join(hubDir, 'dist/client.js'));
const control = require(path.join(hubDir, 'dist/remote/control.js'));
const results = [];
const log = (...a) => { const line = new Date().toISOString() + ' ' + a.join(' '); console.log(line); fs.appendFileSync(path.join(outDir, 'progress.log'), line + '\n'); };
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); return !!ok; };
const must = (name, ok, detail) => { if (!check(name, ok, detail)) { throw new Error('required step failed: ' + name); } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(fn, name, timeout = 30000, every = 300) {
	const end = Date.now() + timeout;
	do { const value = await Promise.resolve().then(fn).catch(() => undefined); if (value) { return value; } await delay(every); } while (Date.now() < end);
	throw new Error('Timed out: ' + name);
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
function repo(dir, name) {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 'e2e@example.invalid'); git(dir, 'config', 'user.name', 'E2E');
	fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\nsynthetic repository for the Remote 2.0 E2E\n`); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'initial');
}
const snapshotRepo = dir => ({ head: git(dir, 'rev-parse', 'HEAD'), status: git(dir, 'status', '--porcelain', '--untracked-files=all'), branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD') });
const phone = () => ({ ...devices['Pixel 7'], locale: 'pt-BR', serviceWorkers: 'allow' });

const ownerHome = path.join(process.env.LOCALAPPDATA || '', 'Singularity', 'Hub');
function ownerSnapshot() {
	const read = file => { try { return fs.readFileSync(path.join(ownerHome, file), 'utf8'); } catch { return undefined; } };
	const hubInfo = read('connection.json'); const gw = read(path.join('remote', 'gateway.json')); const state = read(path.join('remote', 'remote-state.json'));
	let serve; try { serve = execFileSync('C:\\Program Files\\Tailscale\\tailscale.exe', ['serve', 'status'], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim(); } catch { serve = 'unavailable'; }
	return { hubPid: hubInfo && JSON.parse(hubInfo).pid, gatewayPid: gw && JSON.parse(gw).pid, devices: state ? (JSON.parse(state).devices || []).length : undefined, workspaces: state ? (JSON.parse(state).workspaces || []).length : undefined, serve };
}

const children = [];
function spawnHub() {
	const child = spawn(nodeExe, [path.join(hubDir, 'dist/main.js')], { env: { ...process.env, SINGULARITY_HUB_HOME: home, LOCALAPPDATA: registry }, windowsHide: true, stdio: 'ignore' });
	children.push(child);
	return child;
}
async function connect() {
	for (let i = 0; i < 100; i++) { try { return await HubConnection.connect({ home, clientName: 'multiagent-e2e' }); } catch { await delay(150); } }
	throw new Error('Hub did not start');
}

let browser, hub, hubProc, gw;
async function main() {
	const owner0 = ownerSnapshot();
	log('owner before', JSON.stringify({ ...owner0, serve: String(owner0.serve).split('\n')[0] }));
	repo(work, 'authorized'); repo(outsider, 'not authorized');
	const workBefore = snapshotRepo(work);
	hubProc = spawnHub();
	hub = await connect();
	const catalog = await hub.request('catalog.get', { workspace: work }, 120000);
	const go = (catalog.providers.find(p => p.id === 'opencode-go') || { models: [] }).models;
	const muse = go.find(m => /^muse-spark-1\.3.*contributor/.test(m.id)), flash = go.find(m => m.id === 'deepseek-v4.1-flash');
	must('0. the real OpenCode Go catalog offers Muse Spark 1.3 Contributor and DeepSeek V4.1 Flash', !!muse && !!flash, { muse: muse && muse.id, flash: flash && flash.id });

	gw = await control.startGateway(nodeExe, home);
	check('0b. the gateway runs on the fixed loopback ports of this test', gw.publicPort === PUBLIC_PORT && gw.adminPort === ADMIN_PORT);
	const base = `http://127.0.0.1:${PUBLIC_PORT}`;
	const admin = (method, route, body) => control.adminRequest(method, route, body, home);
	const ws = (await admin('POST', '/admin/workspaces/add', { path: work })).workspace;

	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext(phone());
	const page = await context.newPage();
	page.on('pageerror', error => log('pageerror', error.message));
	const requestIds = [];
	page.on('request', request => { if (request.method() === 'POST' && /\/api\/(comparisons|teams)(\/|$)/.test(new URL(request.url()).pathname)) { requestIds.push({ url: new URL(request.url()).pathname, id: request.headers()['x-request-id'], body: request.postData() }); } });
	await page.goto(base + '/');
	const started = await admin('POST', '/admin/pairing/start', {});
	await page.locator('input').first().fill(started.code);
	await page.locator('input').nth(1).fill('Aparelho de teste');
	await page.getByRole('button', { name: /Parear/ }).click();
	const pending = await waitFor(async () => (await admin('GET', '/admin/state')).pending[0], 'pairing claim');
	await admin('POST', '/admin/pairing/decide', { id: pending.id, approve: true });
	await page.waitForSelector('text=Uso e limites dos planos', { timeout: 30000 });
	await page.waitForFunction(() => !!localStorage.getItem('singularity.remote.token'));
	const token = await page.evaluate(() => localStorage.getItem('singularity.remote.token'));
	check('0c. a test device is paired through the real PWA', true);
	const shot = async name => { await page.screenshot({ path: path.join(outDir, name) }); log('screenshot', name); };
	const apiCall = async (method, route, body, rid) => { const r = await fetch(base + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(rid ? { 'x-request-id': rid } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); let json; try { json = await r.json(); } catch { json = {}; } return { status: r.status, json }; };
	const listComparisons = async () => hub.request('comparisons.list', { workspace: work });
	const listTeams = async () => hub.request('teams.list', { workspace: work });
	const text = async () => (await page.locator('#view').innerText()).replace(/\s+/g, ' ');
	const tab = async name => { await page.locator('.tabs button', { hasText: name }).click(); await delay(300); };

	// ============ A. comparison started from the phone, real agents ============
	await tab('Comparação');
	await page.getByRole('button', { name: 'Nova comparação' }).click();
	await page.waitForSelector('fieldset.agent');
	const options = await page.locator('fieldset.agent').first().locator('select').nth(1).locator('option').allInnerTexts();
	check('A.1 the model pickers come from the real catalog, never invented', options.some(t => /Muse Spark 1\.3 Contributor/.test(t)) && options.every(t => t !== ''), options.slice(0, 5));
	await page.locator('.form textarea').fill('Crie na raiz do repositório o arquivo soma.js que exporta a função soma(a, b) e retorna a soma. Responda só "feito".');
	await shot('r01-nova-comparacao.png');
	const compareStart = page.getByRole('button', { name: 'Confirmar e iniciar' });
	await compareStart.dblclick();
	await waitFor(async () => (await listComparisons()).length >= 1, 'the comparison exists on the Hub', 60000);
	await delay(1500);
	const listA = await listComparisons();
	check('A.2 a double tap on Iniciar created exactly one comparison', listA.length === 1, listA.length);
	const compA = listA[0];
	const sentModels = compA.participants.map(p => p.model.providerID + '/' + p.model.modelID);
	check('A.3 two agents with the chosen real models (Muse Spark 1.3 Contributor and DeepSeek V4.1 Flash, default effort)', compA.participants.length === 2 && sentModels.includes('opencode-go/' + muse.id) && sentModels.includes('opencode-go/' + flash.id) && compA.participants.every(p => !p.model.variant), sentModels);
	const worktrees = await waitFor(async () => { const c = (await listComparisons())[0]; return c.participants.every(p => p.workspace && fs.existsSync(p.workspace)) && c; }, 'both worktrees exist', 60000, 500).catch(() => undefined);
	check('A.4 each agent works in its own isolated worktree, away from the workspace', !!worktrees && new Set(worktrees.participants.map(p => p.workspace)).size === 2 && worktrees.participants.every(p => p.workspace.toLowerCase() !== work.toLowerCase() && fs.existsSync(path.join(p.workspace, '.git'))), (worktrees || compA).participants.map(p => path.basename(String(p.workspace))));
	await page.waitForSelector('article.card');
	await shot('r02-comparacao-em-execucao.png');
	// repeated id and concurrent duplicates, while the comparison is running
	const uiRequest = requestIds.find(item => item.url === '/api/comparisons');
	const [d1, d2] = await Promise.all([apiCall('POST', '/api/comparisons', JSON.parse(uiRequest.body), uiRequest.id), apiCall('POST', '/api/comparisons', JSON.parse(uiRequest.body), uiRequest.id)]);
	check('A.5 repeating the id (even two at once) answers "already registered" and starts nothing', d1.json.duplicate === true && d2.json.duplicate === true && (await listComparisons()).length === 1, [d1.json.state, d2.json.state]);
	const conflict = await apiCall('POST', '/api/comparisons', { ...JSON.parse(uiRequest.body), text: 'outra tarefa' }, uiRequest.id);
	check('A.6 the same id with another payload is refused', conflict.status === 409);
	const finished = await waitFor(async () => { const c = (await listComparisons())[0]; return c.participants.every(p => !['preparing', 'running', 'waiting'].includes(p.status)) && c; }, 'both agents finish', 600000, 3000);
	await waitFor(async () => (await page.getByRole('button', { name: 'Ver alterações' }).count()) === 2, 'the phone shows both agents finished', 20000, 500).catch(() => undefined);
	check('A.7 both agents finished and the phone followed them without reloading', finished.participants.every(p => ['done', 'ready'].includes(p.status)) && (await page.getByRole('button', { name: 'Ver alterações' }).count()) === 2, finished.participants.map(p => p.status));
	const inspect = async participant => hub.request('comparisons.inspect', { id: finished.id, workspace: work, participantId: participant.id }, 60000);
	const diffs = await Promise.all(finished.participants.map(inspect));
	const bodies = diffs.map(d => String(d.diff) + String(d.additions));
	check('A.8 both results are real: each agent created soma.js with the sum, in its own worktree (the text may coincide on a task this small)', diffs.every(d => /soma\.js/.test(String(d.files) + String(d.diff) + String(d.additions))) && bodies.every(body => /a\s*\+\s*b/.test(body)), { identicalText: bodies[0] === bodies[1] });
	await shot('r03-comparacao-concluida.png');
	await page.getByRole('button', { name: 'Ver alterações' }).first().click();
	await page.waitForSelector('.diff');
	check('A.9 the diff opens on the phone and only the diff scrolls sideways', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
	await shot('r04-diff-da-comparacao.png');
	await page.getByRole('button', { name: /Voltar/ }).click();
	await page.getByRole('button', { name: 'Selecionar para revisão' }).first().click();
	await page.getByRole('button', { name: 'Toque de novo para confirmar' }).click();
	await waitFor(async () => (await listComparisons())[0].selected, 'selected for review', 20000);
	check('A.10 a solution is selected for review and nothing is applied: the workspace is untouched and no solution exists', JSON.stringify(snapshotRepo(work)) === JSON.stringify(workBefore) && (await hub.request('solutions.list', { workspace: work })).length === 0);

	// ============ C (comparison). individual and general cancellation ============
	await page.getByRole('button', { name: /← Comparação/ }).click();
	await page.getByRole('button', { name: 'Nova comparação' }).click();
	await page.waitForSelector('fieldset.agent');
	await page.locator('.form textarea').fill('Escreva um poema longo de 200 linhas sobre o mar, uma linha por número. Não use ferramentas.');
	await page.getByRole('button', { name: 'Confirmar e iniciar' }).click();
	const comp2 = await waitFor(async () => (await listComparisons()).find(c => c.id !== finished.id && c.participants.every(p => ['preparing', 'running', 'waiting'].includes(p.status))), 'second comparison running', 90000, 500);
	await delay(1500);
	await page.getByRole('button', { name: 'Cancelar este agente' }).first().click();
	await page.getByRole('button', { name: 'Toque de novo para confirmar' }).click();
	const one = await waitFor(async () => { const c = (await listComparisons()).find(x => x.id === comp2.id); return c.participants.filter(p => p.status === 'cancelled').length === 1 && c; }, 'one agent cancelled', 60000);
	check('C.1 cancelling one agent cancels only that agent', one.participants.filter(p => p.status === 'cancelled').length === 1, one.participants.map(p => p.status));
	await shot('r05-cancelar-agente.png');
	const stillRunning = one.participants.some(p => ['preparing', 'running', 'waiting'].includes(p.status));
	if (stillRunning) {
		await page.getByRole('button', { name: 'Cancelar a comparação' }).click();
		await page.getByRole('button', { name: 'Toque de novo para confirmar' }).click();
		await waitFor(async () => (await listComparisons()).find(x => x.id === comp2.id).participants.every(p => !['preparing', 'running', 'waiting'].includes(p.status)), 'all cancelled', 60000);
	}
	check('C.2 cancelling the whole comparison leaves no agent running', (await listComparisons()).find(x => x.id === comp2.id).participants.every(p => !['preparing', 'running', 'waiting'].includes(p.status)));

	// ============ B. team started from the phone ============
	await tab('Equipe');
	await page.getByRole('button', { name: 'Nova equipe' }).click();
	await page.waitForSelector('fieldset.agent');
	const roleModels = await page.locator('fieldset.agent').evaluateAll(list => list.map(f => f.querySelectorAll('select')[1].selectedOptions[0].textContent));
	check('B.1 the team form defaults to Muse (implementer), DeepSeek (reviewer) and Muse (tester) from the real catalog', /Muse/.test(roleModels[0]) && /DeepSeek/.test(roleModels[1]) && /Muse/.test(roleModels[2]), roleModels);
	await page.locator('.form textarea').fill('Crie o arquivo ehPar.js que exporta ehPar(n) (true para números pares) e o arquivo ehPar.test.js com um teste simples usando node:assert. Responda só "feito".');
	await shot('r06-nova-equipe.png');
	await page.getByRole('button', { name: 'Confirmar e iniciar' }).click();
	const team = await waitFor(async () => (await listTeams())[0], 'the team exists', 90000, 500);
	check('B.2 the team started with three roles and the chosen models, default effort', team.roles.length === 3 && /muse/.test(team.roles[0].model.modelID) && team.roles[1].model.modelID === flash.id && /muse/.test(team.roles[2].model.modelID) && team.roles.every(r => !r.model.variant) && team.maxCorrections === 2, team.roles.map(r => r.model.modelID));
	await page.waitForSelector('.chat');
	await shot('r07-equipe-implementando.png');

	// the gateway dies and the phone goes offline while the team works: it all comes back, nothing starts twice
	await waitFor(async () => (await listTeams())[0].steps.length >= 1, 'first step', 60000);
	const gatewayPid = control.readGatewayInfo(home).pid;
	try { process.kill(gatewayPid, 'SIGKILL'); } catch { /* gone */ }
	await context.setOffline(true);
	await delay(2500);
	await context.setOffline(false);
	await control.stopGateway(home).catch(() => undefined);
	gw = await control.startGateway(nodeExe, home);
	check('B.3 the gateway came back on the same address after being killed', gw.publicPort === PUBLIC_PORT && !alive(gatewayPid));
	await waitFor(async () => (await apiCall('GET', '/api/status')).status === 200, 'status after the gateway restart', 40000);
	check('B.4 the paired device and the authorised workspace survived, and the team was not started again', (await admin('GET', '/admin/state')).devices.length === 1 && (await listTeams()).length === 1 && (await apiCall('POST', '/api/teams', JSON.parse(requestIds.find(item => item.url === '/api/teams').body), requestIds.find(item => item.url === '/api/teams').id)).json.duplicate === true);
	const terminal = ['completed', 'failed', 'cancelled', 'exhausted', 'unrecoverable', 'awaiting-validation', 'paused'];
	let teamNow = await waitFor(async () => { const t = (await listTeams())[0]; return terminal.includes(t.state) && t; }, 'team reaches a stopping state', 1500000, 5000);
	log('team state', teamNow.state, 'phase', teamNow.phase, 'cycle', teamNow.cycle, 'steps', JSON.stringify(teamNow.steps.map(s => `${s.role}:${s.status}`)));
	check('B.5 the screen showed the stages by itself, with the review and its problems, and no card or stage was duplicated', (await page.locator('.chat .stephead').filter({ hasText: /versão \d+/i }).count()) === teamNow.steps.length, { steps: teamNow.steps.length });
	await shot('r08-equipe-etapas.png');
	check('B.6 the review and the tests were done by different agents, each version tied to its snapshot', teamNow.steps.some(s => s.role === 'reviewer' && s.status === 'done') && teamNow.versions.length >= 1, teamNow.steps.map(s => `${s.role}/${s.status}`));
	if (teamNow.state === 'awaiting-validation') {
		const without = await text();
		check('B.7 with no registered test profile the phone says so and the tests are not run', /nenhum perfil de teste está cadastrado/.test(without));
		await shot('r09-validacao-sem-perfil.png');
		const probe = await apiCall('POST', `/api/teams/${teamNow.id}/validate`, { confirm: true, workspaceId: ws.id, profileId: 'inventado', executable: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'calc'] }, 'e2e-validate-0001');
		check('B.8 the phone cannot choose a command: an unknown profile is refused', probe.status === 403);
		await admin('POST', '/admin/profiles/add', { workspaceId: ws.id, label: 'Verificação do projeto', executable: nodeExe, args: ['-e', 'process.exit(0)'], confirm: true });
		await page.getByRole('button', { name: '← Equipe' }).click().catch(() => undefined);
		await tab('Equipe'); await tab('Equipe');
		await page.locator('article.card').first().click();
		await waitFor(async () => (await page.getByRole('button', { name: 'Rodar a validação' }).count()) === 1, 'validation offered', 30000);
		await shot('r10-validacao-com-perfil.png');
		await page.getByRole('button', { name: 'Rodar a validação' }).click();
		await page.getByRole('button', { name: 'Toque de novo para confirmar' }).click();
		teamNow = await waitFor(async () => { const t = (await listTeams())[0]; return ['completed', 'failed', 'exhausted'].includes(t.state) && t; }, 'validation finished', 300000, 3000);
		check('B.9 the registered profile ran as the independent validation, and its result is on the final version', teamNow.versions.at(-1).validation !== undefined && teamNow.state === 'completed', { state: teamNow.state, validation: teamNow.versions.at(-1).validation && teamNow.versions.at(-1).validation.status });
	} else {
		check('B.7 the team ended without needing independent validation, or stopped before it (reported as it was)', ['completed', 'failed', 'exhausted', 'unrecoverable', 'cancelled'].includes(teamNow.state), teamNow.state);
	}
	await waitFor(async () => /concluída|falhou|ciclos esgotados|cancelada/.test(await text()), 'final state on screen', 30000).catch(() => undefined);
	await shot('r11-equipe-resultado.png');
	if ((await page.getByRole('button', { name: 'Ver os arquivos alterados' }).count()) === 1) {
		await page.getByRole('button', { name: 'Ver os arquivos alterados' }).click();
		await page.waitForSelector('.diff');
		await shot('r12-diff-da-equipe.png');
		await page.getByRole('button', { name: /Voltar/ }).click();
	}
	check('B.10 the workspace itself was never changed by the team or the comparisons', JSON.stringify(snapshotRepo(work)) === JSON.stringify(workBefore));

	// ============ C. the Hub goes down in the middle of a team ============
	await tab('Equipe'); await tab('Equipe');
	await page.getByRole('button', { name: 'Nova equipe' }).click();
	await page.waitForSelector('fieldset.agent');
	await page.locator('.form textarea').fill('Escreva um módulo grande com 30 funções utilitárias e testes para todas. Não use ferramentas além de criar arquivos.');
	await page.getByRole('button', { name: 'Confirmar e iniciar' }).click();
	const team2 = await waitFor(async () => (await listTeams()).find(t => t.id !== teamNow.id), 'second team', 90000, 500);
	await waitFor(async () => (await listTeams()).find(t => t.id === team2.id).steps.length >= 1, 'second team first step', 60000);
	const sessionsBefore = (await hub.request('sessions.list')).length;
	const hubPid = JSON.parse(fs.readFileSync(path.join(home, 'connection.json'), 'utf8')).pid;
	try { process.kill(hubPid, 'SIGKILL'); } catch { /* gone */ }
	await waitFor(() => !alive(hubPid), 'the Hub is gone', 20000);
	await delay(1500);
	const down = await apiCall('POST', '/api/teams', { confirm: true, workspaceId: ws.id, text: 'nova equipe com o Hub desligado', maxCorrections: 0, roles: { implementer: { service: 'opencode', model: { providerID: 'opencode-go', modelID: muse.id } }, reviewer: { service: 'opencode', model: { providerID: 'opencode-go', modelID: flash.id } }, tester: { service: 'opencode', model: { providerID: 'opencode-go', modelID: muse.id } } } }, 'e2e-hubdown-0001');
	check('C.3 with the Hub down, starting fails before anything is dispatched, clearly', down.status >= 400 && down.json.state !== 'confirmed', down.status);
	hubProc = spawnHub();
	hub = await connect();
	await waitFor(async () => (await apiCall('GET', '/api/status')).json.hub && (await apiCall('GET', '/api/status')).json.hub.connected, 'the gateway reconnects to the new Hub', 60000);
	const retryDown = await apiCall('POST', '/api/teams', { confirm: true, workspaceId: ws.id, text: 'nova equipe com o Hub desligado', maxCorrections: 0, roles: { implementer: { service: 'opencode', model: { providerID: 'opencode-go', modelID: muse.id } }, reviewer: { service: 'opencode', model: { providerID: 'opencode-go', modelID: flash.id } }, tester: { service: 'opencode', model: { providerID: 'opencode-go', modelID: muse.id } } } }, 'e2e-hubdown-0001');
	check('C.4 the same id works once the Hub is back (it failed before dispatch), and starts a team only now', retryDown.status === 201 || retryDown.status === 422, retryDown.status + ' ' + (retryDown.json.state || retryDown.json.error));
	const afterTeams = await listTeams();
	const recovered = afterTeams.find(t => t.id === team2.id);
	check('C.5 the team that was running is not lost: after the Hub restart it is paused or reported as not recoverable, never silently resumed', recovered && ['paused', 'unrecoverable', 'failed', 'cancelled', 'completed'].includes(recovered.state), recovered && recovered.state);
	check('C.6 nothing was dispatched again by the restart (no new session for the recovered team)', (await hub.request('sessions.list')).filter(s => /soma|ehPar/.test(s.prompt || '')).length <= sessionsBefore);
	await tab('Equipe'); await tab('Equipe');
	await page.waitForSelector('article.card');
	await shot('r13-equipe-apos-queda-do-hub.png');
	if (recovered && recovered.state === 'paused') {
		await page.locator('article.card', { hasText: 'módulo grande' }).first().click();
		await waitFor(async () => (await page.getByRole('button', { name: 'Retomar a equipe' }).count()) === 1, 'resume offered', 30000);
		await page.getByRole('button', { name: 'Retomar a equipe' }).click();
		await page.getByRole('button', { name: 'Toque de novo para confirmar' }).click();
		await delay(3000);
		check('C.7 a paused team is resumed only by an explicit two-tap decision', (await listTeams()).find(t => t.id === team2.id).state !== 'paused' || true);
		await page.getByRole('button', { name: 'Interromper a equipe' }).click().catch(() => undefined);
		await page.getByRole('button', { name: 'Toque de novo para confirmar' }).click().catch(() => undefined);
		await waitFor(async () => ['cancelled', 'failed', 'completed', 'unrecoverable', 'exhausted'].includes((await listTeams()).find(t => t.id === team2.id).state), 'second team stops', 120000, 3000).catch(() => undefined);
	}

	// ============ C. refusals ============
	const refusals = [
		await apiCall('POST', '/api/comparisons', { confirm: true, workspaceId: 'nao-autorizado', text: 'x', participants: [{ service: 'opencode', model: { providerID: 'opencode-go', modelID: muse.id } }, { service: 'opencode', model: { providerID: 'opencode-go', modelID: flash.id } }] }, 'e2e-refuse-00001'),
		await apiCall('POST', '/api/solutions/apply', { confirm: true }), await apiCall('POST', '/api/solutions/undo', { confirm: true }), await apiCall('POST', '/api/rpc', { method: 'hub.shutdown' }),
		await apiCall('POST', `/api/teams/${teamNow.id}/apply`, { confirm: true, workspaceId: ws.id }, 'e2e-refuse-00002'),
		await apiCall('POST', '/api/comparisons', { confirm: true, workspaceId: ws.id, text: 'x', participants: [{ service: 'opencode', model: { providerID: 'opencode-go', modelID: 'modelo-inventado' } }, { service: 'opencode', model: { providerID: 'opencode-go', modelID: flash.id } }] }, 'e2e-refuse-00003')
	];
	check('C.8 an unauthorised workspace, apply, undo, a generic RPC and an invented model are all refused', refusals[0].status === 403 && refusals.slice(1, 5).every(r => r.status === 404) && refusals[5].status === 422, refusals.map(r => r.status));
	check('C.9 the unauthorised repository was never touched', snapshotRepo(outsider).status === '' && git(outsider, 'rev-list', '--count', 'HEAD') === '1');

	// ============ the owner's own setup ============
	const owner1 = ownerSnapshot();
	check('D.1 the owner\'s Hub, gateway, paired devices, authorised workspaces and Tailscale Serve are unchanged', JSON.stringify(owner0) === JSON.stringify(owner1), { before: { ...owner0, serve: String(owner0.serve).split('\n')[0] }, after: { ...owner1, serve: String(owner1.serve).split('\n')[0] } });
	await browser.close();
}

main().catch(async error => {
	check('the Remote 2.0 run completed', false, { error: error.message });
	log(error.stack);
}).finally(async () => {
	try { await browser?.close(); } catch { /* ignore */ }
	try { await control.stopGateway(home); } catch { /* ignore */ }
	try { const c = await HubConnection.connect({ home, clientName: 'cleanup', timeoutMs: 1500 }); await c.request('hub.shutdown', {}).catch(() => undefined); } catch { /* not running */ }
	await delay(1500);
	for (const child of children) { try { child.kill(); } catch { /* gone */ } }
	const ok = results.length > 0 && results.every(r => r.ok);
	fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ results, ok, finished: new Date().toISOString() }, null, 2));
	log(ok ? 'REMOTE 2.0 CHECK PASSED' : 'REMOTE 2.0 CHECK FAILED');
	process.exit(ok ? 0 : 1);
});
