'use strict';
// UI test of Remote 2.0 (new comparison, new team, tracking and controls) on a phone-sized Chromium, against the REAL gateway and the REAL
// PWA, with a scripted Hub (no model is called). It checks what is sent, the states the screen goes through, the controls, the duplicate
// protection and that nothing overflows horizontally at 360 and 320 px, also with the Android keyboard open.
//
//   node scripts/e2e/remote-multiagent-ui.cjs --out <dir> [--hub <singularity-hub dir>]
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium, devices } = require('playwright');

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i < 0 ? fallback : process.argv[i + 1]; };
const hubDir = path.resolve(arg('hub', path.join(__dirname, '../../singularity-hub')));
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'multiagent-ui-out')));
fs.mkdirSync(outDir, { recursive: true });
const { RemoteGateway } = require(path.join(hubDir, 'dist/remote/gateway.js'));
const { BridgeError } = require(path.join(hubDir, 'dist/remote/bridge.js'));

const results = [];
const log = (...a) => { const line = new Date().toISOString() + ' ' + a.join(' '); console.log(line); fs.appendFileSync(path.join(outDir, 'progress.log'), line + '\n'); };
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); return !!ok; };
async function waitFor(fn, name, timeout = 20000, every = 150) {
	const end = Date.now() + timeout;
	do { const value = await Promise.resolve().then(fn).catch(() => undefined); if (value) { return value; } await delay(every); } while (Date.now() < end);
	throw new Error('Timed out: ' + name);
}

// ---------- a scripted Hub: comparisons and teams that progress by themselves ----------
class ScriptedHub extends EventEmitter {
	connected = true; instanceId = 'scripted';
	calls = []; comparisons = []; teams = []; catalogFailures = 0; catalogReads = 0;
	constructor(workspace) { super(); this.workspace = workspace; }
	start() { } close() { } eventsAfter() { return []; }
	async sessions() { return []; }
	async call(method, params = {}) {
		this.calls.push({ method, params });
		if (method === 'catalog.get') {
			this.catalogReads++;
			if (this.catalogFailures > 0) { this.catalogFailures--; throw new Error('A ativação dos plugins do OpenCode não terminou (HTTP 503).'); }
			const claude = params.service === 'claude-code';
			return claude ? { services: [{ id: 'claude-code', name: 'Claude Code', status: 'available' }], service: 'claude-code', providers: [{ id: 'claude-code', name: 'Claude Code', models: [{ id: 'sonnet', name: 'Sonnet', efforts: ['low', 'high'] }] }] }
				: { services: [{ id: 'opencode', name: 'OpenCode', status: 'available' }], service: 'opencode', providers: [
					{ id: 'opencode-go', name: 'OpenCode Go', models: [{ id: 'muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor', efforts: [] }, { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', efforts: ['low', 'high'] }] },
					{ id: 'opencode', name: 'OpenCode Zen', models: [{ id: 'big-pickle', name: 'Big Pickle', efforts: [] }] }] };
		}
		if (method === 'comparisons.list') { return this.comparisons.map(item => structuredClone(item)); }
		if (method === 'teams.list') { return this.teams.map(item => structuredClone(item)); }
		if (method === 'comparisons.inspect') {
			const group = this.comparisons.find(item => item.id === params.id); const participant = group && group.participants.find(item => item.id === params.participantId);
			const answer = participant && participant.status === 'done' ? 'Criei soma.js com a função soma(a, b). Resposta final do agente.' : 'Escrevendo soma.js… resposta parcial ' + Math.floor((Date.now() - (participant ? participant.startedAt : Date.now())) / 500);
			const activity = participant && participant.status !== 'done' ? [{ kind: 'thinking', text: 'Vou ler o projeto antes de escrever.', status: 'completed' }, { kind: 'tool', tool: 'read', detail: 'src/validar.js', status: 'completed' }, { kind: 'tool', tool: 'execute', detail: 'npm test', status: 'error', exitCode: 1, output: 'not ok 1 - valida entrada vazia' }, { kind: 'tool', tool: 'execute', detail: 'npm test', status: 'completed', exitCode: 0, output: 'ok 1 - valida entrada vazia' }, { kind: 'tool', tool: 'write', detail: 'src/validar.js', status: 'streaming' }, { kind: 'text', text: answer }] : undefined;
			return { participant: participant && structuredClone(participant), activity, idleMs: 1200, result: answer, usage: participant && participant.status === 'done' ? { inputTokens: 1234, outputTokens: 321 } : undefined, durationMs: participant ? (participant.endedAt || Date.now()) - participant.startedAt : 0, files: 'M  src/app.js', diff: '--- a/src/app.js\n+++ b/src/app.js\n@@ -1,3 +1,4 @@\n-const a = 1;\n+const a = 2; // uma linha muito comprida que deve rolar só dentro do diff e nunca empurrar a página inteira para o lado em uma tela estreita\n+const b = 3;\n' };
		}
		if (method === 'comparisons.create') {
			if (String(params.text).includes('RECUSAR')) { throw new BridgeError('A árvore de origem contém alterações. Faça commit ou escolha um repositório limpo.'); }
			const now = Date.now();
			const record = { id: '11111111-1111-4111-8111-' + String(100000000000 + this.comparisons.length), workspace: this.workspace, prompt: params.text, createdAt: now, participants: params.participants.map((p, i) => ({ id: 'part-' + (i + 1), service: p.service, model: p.model, status: 'running', startedAt: now })) };
			this.comparisons.push(record);
			record.participants.forEach((p, i) => setTimeout(() => { p.status = 'done'; p.endedAt = Date.now(); }, 2500 + i * 1500));
			return record;
		}
		if (method === 'comparisons.cancel') { const c = this.comparisons.find(item => item.id === params.id); for (const p of c.participants) { if ((!params.participantId || p.id === params.participantId) && p.status === 'running') { p.status = 'cancelled'; p.endedAt = Date.now(); } } return { cancelled: true }; }
		if (method === 'comparisons.select') { this.comparisons.find(item => item.id === params.id).selected = params.participantId; return { selected: true }; }
		if (method === 'teams.start') {
			const now = Date.now();
			const group = { id: '33333333-3333-4333-8333-' + String(100000000000 + this.comparisons.length), workspace: this.workspace, prompt: params.text, createdAt: now, team: true, participants: params.participants.map((p, i) => ({ id: 'tp-' + (i + 1), service: p.service, model: p.model, role: ['implementer', 'reviewer', 'tester'][i], status: 'running', startedAt: now })) };
			this.comparisons.push(group);
			const team = { id: '22222222-2222-4222-8222-' + String(100000000000 + this.teams.length), workspace: this.workspace, task: params.text, roles: params.participants, createdAt: now, updatedAt: now, state: 'running', phase: 'implementer', cycle: 0, maxCorrections: params.maxCorrections, comparisonId: group.id, steps: [{ role: 'implementer', version: 1, sessionId: 's1', status: 'sent', startedAt: now }], versions: [] };
			this.teams.push(team);
			setTimeout(() => { team.steps[0].status = 'done'; team.steps[0].endedAt = Date.now(); team.steps[0].result = 'Implementei o módulo conforme pedido.'; team.versions.push({ number: 1, comparisonId: group.id, solutionId: 'sol1', tree: 't', patchHash: 'h' }); team.phase = 'reviewer'; team.steps.push({ role: 'reviewer', version: 1, sessionId: 's2', status: 'sent', startedAt: Date.now() }); }, 2500);
			setTimeout(() => { team.steps[1].status = 'done'; team.steps[1].endedAt = Date.now(); team.versions[0].review = { verdict: 'changes_requested', summary: 'Falta tratar o erro de entrada vazia.', issues: [{ file: 'src/app.js', line: 3, severity: 'medium', message: 'A função não trata a entrada vazia.' }] }; team.cycle = 1; team.phase = 'implementer'; team.steps.push({ role: 'implementer', version: 2, sessionId: 's3', status: 'sent', startedAt: Date.now() }); }, 5000);
			setTimeout(() => { team.steps[2].status = 'done'; team.steps[2].endedAt = Date.now(); team.versions.push({ number: 2, comparisonId: group.id, solutionId: 'sol2', tree: 't2', patchHash: 'h2', review: { verdict: 'approve', summary: 'Sem pendências.', issues: [] }, testPlan: { verdict: 'approve', summary: 'Cenários descritos.', issues: [], scenarios: ['entrada vazia', 'entrada grande'] } }); team.state = 'awaiting-validation'; team.phase = 'validation'; }, 8000);
			return team;
		}
		if (method === 'teams.cancel') { const t = this.teams.find(item => item.id === params.id); t.state = 'cancelled'; t.phase = t.phase; t.finishedAt = Date.now(); return { cancelled: true }; }
		if (method === 'teams.validate') { const t = this.teams.find(item => item.id === params.id); t.versions[t.versions.length - 1].validation = { status: 'passed' }; t.state = 'completed'; t.finishedAt = Date.now(); return t; }
		if (method === 'teams.choose') { this.teams.find(item => item.id === params.id).chosen = true; return { chosen: true }; }
		if (method === 'teams.instruct') { const t = this.teams.find(item => item.id === params.id), now = Date.now(); t.followUps = [...(t.followUps || []), { text: params.text, at: now }]; t.state = 'running'; t.phase = 'implementer'; t.cycle++; t.finishedAt = undefined; t.steps.push({ role: 'implementer', version: t.cycle + 1, status: 'sent', startedAt: now + 1 }); return t; }
		if (method === 'teams.delete') { this.teams = this.teams.filter(item => item.id !== params.id); return { deleted: true }; }
		if (method === 'policy.get') { return { mode: 'development', external: false, updatedAt: 1 }; }
		if (method === 'teams.resume') { const t = this.teams.find(item => item.id === params.id); t.state = 'running'; return t; }
		return {};
	}
}

const net = require('node:net');
const freePort = () => new Promise(resolve => { const server = net.createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const phone = (width, height) => ({ ...devices['Pixel 7'], viewport: { width, height }, screen: { width, height }, locale: 'pt-BR', serviceWorkers: 'block' });
let browser, gateway, pageRef;

async function main() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-ma-'));
	const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-ma-ws-')));
	const runner = path.join(workspace, 'run-tests.cmd');
	fs.writeFileSync(runner, '@echo ok\r\n');
	const hub = new ScriptedHub(workspace);
	const ports = { publicPort: await freePort(), adminPort: await freePort() };
	const makeGateway = () => new RemoteGateway({ directory, webDir: path.join(hubDir, 'web'), bridge: hub, retryDelayMs: 30, ...ports });
	gateway = makeGateway();
	await gateway.start();
	const base = `http://127.0.0.1:${gateway.publicPort}`;
	// every gateway start makes a new admin secret: read it each time
	const admin = async (route, body) => (await fetch(`http://127.0.0.1:${gateway.adminPort}` + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': fs.readFileSync(path.join(directory, 'admin.token'), 'utf8') }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
	const added = await admin('/admin/workspaces/add', { path: workspace });

	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext(phone(360, 780));
	const page = await context.newPage();
	pageRef = page;
	page.on('request', request => { if (request.method() === 'POST' && /api\/(comparisons|teams)$/.test(request.url())) { log('POST body', (request.postData() || '').slice(0, 500)); } });
	page.on('pageerror', error => log('pageerror', error.message));
	const sentRequests = [];
	page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/comparisons') { sentRequests.push({ url: '/api/comparisons', id: request.headers()['x-request-id'], body: request.postData() }); } });
	page.on('console', message => { if (['error', 'warning'].includes(message.type())) { log('console', message.type(), message.text().slice(0, 200)); } });
	await page.goto(base + '/');
	const started = await admin('/admin/pairing/start', {});
	await page.locator('input').first().fill(started.code);
	await page.locator('input').nth(1).fill('POCO de teste');
	await page.getByRole('button', { name: /Parear/ }).click();
	const pending = await waitFor(async () => (await admin('/admin/state')).pending[0], 'pairing claim');
	await admin('/admin/pairing/decide', { id: pending.id, approve: true });
	await page.waitForSelector('text=Uso e limites dos planos', { timeout: 30000 });
	const shot = async name => { await page.screenshot({ path: path.join(outDir, name) }); log('screenshot', name); };
	const noSideScroll = async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
	const calls = method => hub.calls.filter(call => call.method === method);

	// ============ comparison ============
	await page.locator('.tabs button', { hasText: 'Comparação' }).click();
	await page.getByRole('button', { name: 'Nova comparação' }).click();
	await page.waitForSelector('fieldset.agent');
	check('A.1 the new-comparison form shows the workspace, the task, the agent count and the model pickers from the real catalog', (await page.locator('fieldset.agent').count()) === 2 && (await page.locator('fieldset.agent').first().locator('select').nth(1).locator('option').allInnerTexts()).some(text => /Muse Spark/.test(text)));
	check('A.2 the OpenCode providers are separate entries (Go and Zen) in each agent picker', (await page.locator('fieldset.agent').first().locator('select').first().locator('option').allInnerTexts()).join('|').includes('OpenCode Go|OpenCode Zen'));
	check('A.3 a defaulted second agent is a different model, so the form is valid once the task is written', (await page.locator('fieldset.agent select').nth(1).inputValue()) !== (await page.locator('fieldset.agent select').nth(4).inputValue()));
	const startButton = page.getByRole('button', { name: 'Confirmar e iniciar' });
	check('A.4 starting is disabled until there is a task', await startButton.isDisabled());
	await page.locator('.form textarea').fill('Implemente a função soma e cubra com testes.');
	await shot('p01-nova-comparacao.png');
	check('A.5 the form says the work is isolated and nothing is applied to the project', /Nada é aplicado ao projeto principal/.test(await page.locator('.form').innerText()));
	await startButton.dblclick();
	await waitFor(async () => (await page.locator('h2', { hasText: 'Comparação' }).count()) > 0 && (await page.locator('article.card').count()) >= 2, 'comparison detail');
	await delay(500);
	check('A.6 a double tap on Iniciar starts exactly one comparison', calls('comparisons.create').length === 1, calls('comparisons.create').length);
	const sent = calls('comparisons.create')[0].params;
	check('A.7 the Hub received the real models and the real path, never an id from the phone', sent.workspace === workspace && sent.participants.length === 2 && sent.participants.every(p => p.service === 'opencode' && p.model.providerID === 'opencode-go') && sent.participants[0].model.modelID !== sent.participants[1].model.modelID, sent.participants);
	check('A.8 the detail shows two agents, running, with model and duration', (await page.locator('article.card').count()) === 2 && /em execução|executando|running/i.test(await page.locator('#view').innerText()));
	await shot('p02-comparacao-em-execucao.png');
	await waitFor(async () => (await page.getByRole('button', { name: 'Ver alterações' }).count()) === 2, 'both agents finish by themselves', 20000);
	check('A.9 the screen updates by itself and does not duplicate cards', (await page.locator('article.card').count()) === 2);
	await shot('p03-comparacao-concluida.png');
	await page.getByRole('button', { name: 'Ver alterações' }).first().click();
	await page.waitForSelector('.diff');
	check('A.10 the diff is shown, and only the diff scrolls sideways, never the page', (await noSideScroll()) && (await page.locator('.diff').evaluate(el => el.scrollWidth > el.clientWidth)));
	await shot('p04-diff.png');
	await page.getByRole('button', { name: /Voltar/ }).click();
	await page.getByRole('button', { name: 'Selecionar para revisão' }).first().click();
	check('A.11 selecting a solution needs a second tap', calls('comparisons.select').length === 0);
	await page.getByRole('button', { name: 'Toque de novo para confirmar' }).click();
	await waitFor(() => calls('comparisons.select').length === 1, 'select reached the Hub');
	check('A.12 selecting for review calls only comparisons.select (nothing is applied)', calls('comparisons.select').length === 1 && !hub.calls.some(call => /solutions\./.test(call.method)));
	await page.waitForFunction(() => /ficam na IDE do computador/.test(document.body.innerText), null, { timeout: 10000 }).catch(() => undefined);
	check('A.13 the screen offers no apply and no undo, and says where they are done', !/Aplicar a solução$|Desfazer$/m.test(await page.locator('#view').innerText()) && /ficam na IDE do computador/.test(await page.locator('#view').innerText()));

	// a lost answer: the request reaches the computer, the answer does not; the retry reuses the id and nothing starts twice
	await page.getByRole('button', { name: /← Comparação/ }).click();
	await page.getByRole('button', { name: 'Nova comparação' }).click();
	await page.waitForSelector('fieldset.agent');
	await page.locator('.form textarea').fill('Segunda comparação, resposta perdida.');
	const ids = [];
	await page.route('**/api/comparisons', async route => {
		if (route.request().method() !== 'POST') { await route.continue(); return; }
		ids.push(route.request().headers()['x-request-id']);
		if (ids.length === 1) { await route.fetch(); await route.abort('connectionreset'); } else { await route.continue(); }
	});
	await page.getByRole('button', { name: 'Confirmar e iniciar' }).click();
	await page.waitForFunction(() => /Aguardando confirmação|Sem conexão/.test((document.querySelector('.pending') || {}).textContent || ''), null, { timeout: 15000 });
	await shot('p05-aguardando-confirmacao.png');
	await page.getByRole('button', { name: 'Tentar de novo' }).click();
	await waitFor(async () => (await page.locator('.pending').count()) === 0, 'the banner clears');
	check('A.14 after a lost answer the retry reuses the same id and the comparison exists once', ids.length === 2 && ids[0] === ids[1] && calls('comparisons.create').length === 2, { ids, creates: calls('comparisons.create').length });
	await page.unroute('**/api/comparisons');

	// ============ team ============
	await page.locator('.tabs button', { hasText: 'Equipe' }).click();
	await page.getByRole('button', { name: 'Nova equipe' }).click();
	await page.waitForSelector('fieldset.agent');
	check('B.1 the new-team form has the three roles, each with its own provider, model and effort', (await page.locator('fieldset.agent legend').allTextContents()).join('|') === 'Implementador|Revisor|Testador');
	await page.waitForFunction(() => /Desenvolvimento: usa o terminal/.test((document.getElementById('team-policy') || {}).textContent || ''), null, { timeout: 15000 });
	check('B.2b the form shows what the implementer may do with the terminal in this project, says it is chosen on the computer, and offers no control to change it', /sem publicação externa/.test(await page.locator('#team-policy').innerText()) && /o celular não pode mudá-lo/.test(await page.locator('.form').innerText()) && (await page.locator('.form select').count()) === (await page.locator('.form fieldset.agent select').count()) + 2, await page.locator('#team-policy').innerText());
	check('B.2 the form offers 0 to 2 correction cycles and explains that independent tests need a Windows profile', (await page.locator('.form select').last().locator('option').count()) === 3 && /perfil de teste cadastrado na IDE Windows/.test(await page.locator('.form').innerText()));
	await page.locator('.form textarea').fill('Construa o módulo de validação.');
	await shot('p06-nova-equipe.png');
	await page.getByRole('button', { name: 'Confirmar e iniciar' }).click();
	await waitFor(() => calls('teams.start').length === 1, 'team start');
	const teamSent = calls('teams.start')[0].params;
	check('B.3 the team starts with implementer, reviewer and tester in that order, and the cycle limit', teamSent.participants.length === 3 && teamSent.maxCorrections === 2 && teamSent.workspace === workspace, teamSent.participants.map(p => p.model.modelID));
	await page.waitForSelector('.chat');
	await page.waitForFunction(() => { const feed = document.getElementById('team-live'); return feed && /Escrevendo/.test(feed.textContent) && /src\/validar\.js/.test(feed.textContent); }, null, { timeout: 15000 });
	check('B.3b the running step shows by itself what the agent is doing: its reasoning, each tool and the file', /Racioc/i.test(await page.locator('#team-live').innerText()) && /Lendo/i.test(await page.locator('#team-live').innerText()) && /Implementador trabalhando/.test(await page.locator('#team-status').innerText()), await page.locator('#team-status').innerText());
	check('B.3d a command the agent ran shows what it was, how it ended (exit code) and what it printed, failure and success apart', (await page.locator('#team-live .act.tool .exit.bad').first().innerText()) === 'saída 1' && (await page.locator('#team-live .act.tool .exit.ok').first().innerText()) === 'saída 0' && /Executando/.test(await page.locator('#team-live').innerText()) && (await page.locator('#team-live details.output').count()) === 2);
	check('B.3c the task is shown as the message of the person, like a conversation', /Construa o módulo de validação/.test(await page.locator('.chat .bubble.user').first().innerText()));
	await shot('p07-equipe-implementando.png');
	await waitFor(async () => /Revisor/i.test(await page.locator('.chat').innerText()), 'the review step appears by itself', 15000);
	await waitFor(async () => /A função não trata a entrada vazia/.test(await page.locator('#view').innerText()), 'the issue found by the reviewer is shown', 15000);
	check('B.4 the stages, the problems found and the correction cycle appear by themselves', /Implementador · versão 2/i.test(await page.locator('.chat').innerText()) && /pede alterações/i.test(await page.locator('.chat').innerText()));
	await shot('p08-equipe-problemas.png');
	await waitFor(async () => /nenhum perfil de teste está cadastrado/.test(await page.locator('#view').innerText()), 'awaiting independent validation', 20000);
	check('B.5 without a registered profile the screen says the tests must be authorised on Windows, and offers no command field', !(await page.getByRole('button', { name: 'Rodar a validação' }).count()) && (await page.locator('#view input[type=text], #view input:not([type])').count()) === 0);
	await shot('p09-validacao-sem-perfil.png');
	const profile = await admin('/admin/profiles/add', { workspaceId: added.workspace.id, label: 'Testes do projeto', executable: runner, args: ['--rapido'], confirm: true });
	await page.getByRole('button', { name: '← Equipe' }).click();
	await page.locator('article.card').first().click();
	await page.waitForSelector('.chat');
	await waitFor(async () => (await page.getByRole('button', { name: 'Rodar a validação' }).count()) === 1, 'validation offered with the registered profile', 15000);
	check('B.6 with a profile registered on Windows the phone can choose it by label, and only by label', /Testes do projeto/.test(await page.locator('#view select').last().innerText()) && !/rapido|run-tests/.test(await page.locator('#view').innerText()));
	await shot('p10-validacao-com-perfil.png');
	await page.getByRole('button', { name: 'Rodar a validação' }).click();
	await page.getByRole('button', { name: 'Toque de novo para confirmar' }).click();
	await waitFor(() => calls('teams.validate').length === 1, 'validation reached the Hub');
	check('B.7 the Hub gets exactly the registered command, approved, never one from the phone', JSON.stringify(calls('teams.validate')[0].params.command) === JSON.stringify({ executable: runner, args: ['--rapido'], approved: true }) && profile.profile.id.length > 4);
	await waitFor(async () => /concluída/.test(await page.locator('#view').innerText()), 'team completed', 15000);
	await page.getByRole('button', { name: 'Marcar para revisão na IDE' }).click();
	await page.getByRole('button', { name: 'Toque de novo para confirmar' }).click();
	await waitFor(() => calls('teams.choose').length === 1, 'team choose');
	check('B.8 the final solution can be inspected and selected for review, never applied', (await page.getByRole('button', { name: 'Ver os arquivos alterados' }).count()) === 1 && !hub.calls.some(call => /solutions\.|apply|undo/.test(call.method)));
	await page.getByRole('button', { name: 'Ver os arquivos alterados' }).click();
	await page.waitForSelector('.diff');
	await shot('p11-diff-da-equipe.png');
	await page.getByRole('button', { name: /Voltar/ }).click();

	// answering the team after it delivered: the instruction goes once, and the team works again on top of its version
	await page.waitForSelector('.chatbar textarea');
	const order = await page.evaluate(() => { const bar = document.querySelector('.chatbar').getBoundingClientRect(), chat = document.querySelector('.chat').getBoundingClientRect(); const after = [...document.querySelectorAll('#view button, #view article, #view section')].filter(node => !node.closest('.chatbar') && node.getBoundingClientRect().top > bar.bottom); return { below: bar.top >= chat.bottom - 1, after: after.length }; });
	check('B.8a the answer field is the last thing of the conversation, at the end of the page, with nothing to tap below it', order.below && order.after === 0, order);
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.waitForFunction(() => { const jump = document.querySelector('button.jump'); return jump && !jump.hidden; }, null, { timeout: 5000 });
	await shot('p11a-botao-descer.png');
	await page.locator('button.jump').click();
	await page.waitForFunction(() => document.documentElement.scrollHeight - (window.scrollY + window.innerHeight) < 160 && document.querySelector('button.jump').hidden, null, { timeout: 5000 });
	check('B.8c after scrolling up in the team conversation a button brings it back down to the end', true);
	await page.locator('.chatbar textarea').fill('Publique também o resultado.');
	await page.locator('.chatbar button.send').click();
	await waitFor(() => calls('teams.instruct').length === 1, 'the new instruction reached the Hub');
	await waitFor(async () => /Publique também o resultado/.test(await page.locator('.chat').innerText()) && /em execução/i.test(await page.locator('#view').innerText()), 'the instruction is shown in the conversation and the team works again', 15000);
	check('B.8b after the delivery the person can answer the team: the instruction is sent once, shown as their message, and a new cycle starts', calls('teams.instruct')[0].params.text === 'Publique também o resultado.' && (await page.locator('.chat .bubble.user').count()) === 2 && !(await page.locator('.chatbar textarea').count()), calls('teams.instruct').length);
	await page.waitForFunction(() => document.getElementById('team-live') && document.documentElement.scrollHeight - (window.scrollY + window.innerHeight) < 160, null, { timeout: 15000 });
	check('B.8d while the agents work the page follows the newest activity down', true);
	await shot('p11b-resposta-a-equipe.png');
	await hub.call('teams.cancel', { id: hub.teams[0].id });

	// cancelling a running team: two taps, once
	await page.getByRole('button', { name: '← Equipe' }).click();
	await page.getByRole('button', { name: 'Nova equipe' }).click();
	await page.waitForSelector('fieldset.agent');
	await page.locator('.form textarea').fill('Equipe para cancelar.');
	await page.getByRole('button', { name: 'Confirmar e iniciar' }).click();
	await page.waitForSelector('.chat');
	await page.getByRole('button', { name: 'Interromper a equipe' }).click();
	check('B.9 cancelling needs a second tap', calls('teams.cancel').filter(call => call.params.workspace).length === 0);
	await page.getByRole('button', { name: 'Toque de novo para confirmar' }).dblclick();
	await waitFor(() => calls('teams.cancel').filter(call => call.params.workspace).length >= 1, 'cancel reached the Hub');
	await delay(600);
	check('B.10 a double tap on the cancel confirmation cancels once', calls('teams.cancel').filter(call => call.params.workspace).length === 1, calls('teams.cancel').length);
	// a team that stopped can be deleted, with two taps
	// what can be done to a team is outside its conversation, behind the "⋮" of its card
	check('B.10b inside the team there is only the conversation: no delete button and no block of buttons above it', (await page.getByRole('button', { name: 'Excluir a equipe' }).count()) === 0 && (await page.locator('#view > .row button.secondary:not(.back), #view > button').count()) === 0);
	await shot('p12-conversa-da-equipe.png');
	await page.getByRole('button', { name: '← Equipes' }).click();
	await page.waitForSelector('article.card button.more');
	check('B.10c in the list a team offers no destructive button until its menu is opened', (await page.getByRole('button', { name: 'Excluir a equipe' }).count()) === 0);
	await page.locator('article.card button.more').last().click();
	await shot('p13-menu-da-equipe.png');
	await waitFor(async () => (await page.getByRole('button', { name: 'Excluir a equipe' }).count()) === 1, 'delete is offered for a stopped team', 15000);
	const teamsBefore = hub.teams.length;
	await page.getByRole('button', { name: 'Excluir a equipe' }).click();
	const tappedOnce = calls('teams.delete').length;
	await page.getByRole('button', { name: 'Toque de novo para confirmar' }).click();
	await waitFor(() => calls('teams.delete').length === 1, 'delete reached the Hub');
	await waitFor(async () => (await page.getByRole('button', { name: 'Nova equipe' }).count()) === 1, 'the screen goes back to the list by itself', 15000);
	check('B.11 a stopped team is deleted with two taps and the screen returns to the list', tappedOnce === 0 && hub.teams.length === teamsBefore - 1);
	await waitFor(async () => /cancelada/.test(await page.locator('#view').innerText()), 'cancelled state shown');
	await shot('p12-equipe-cancelada.png');

	// ============ failures: the catalog hiccups, the gateway restarts, the answer of an agent is followed live ============
	await page.locator('.tabs button', { hasText: 'Comparação' }).click();
	await page.locator('.tabs button', { hasText: 'Comparação' }).click();
	await page.reload();
	await page.waitForSelector('.tabs button');
	await page.locator('.tabs button', { hasText: 'Comparação' }).click();
	await page.locator('.tabs button', { hasText: 'Comparação' }).click();
	hub.catalogFailures = 3;
	const readsBefore = hub.catalogReads;
	await page.getByRole('button', { name: 'Nova comparação' }).click();
	await page.waitForSelector('fieldset.agent');
	await page.waitForFunction(() => /Tentando de novo/.test(document.querySelector('fieldset.agent').textContent), null, { timeout: 15000 });
	await shot('p16-catalogo-tentando-de-novo.png');
	check('F.1 when the catalog fails the form says it is trying again instead of showing empty selectors', true);
	await delay(1500);
	check('F.2 a failing catalog is not asked for in a loop: a few reads, not a storm', hub.catalogReads - readsBefore <= 4, hub.catalogReads - readsBefore);
	await page.waitForFunction(() => { const select = document.querySelector('fieldset.agent').querySelectorAll('select')[1]; return select && /Muse Spark/.test(select.textContent); }, null, { timeout: 20000 });
	check('F.3 the models appear by themselves once the computer answers', (await page.locator('fieldset.agent').first().locator('select').nth(1).inputValue()) !== '');
	await page.locator('.form textarea').fill('Comparação para seguir ao vivo.');
	await page.getByRole('button', { name: 'Confirmar e iniciar' }).click();
	await page.waitForSelector('article.card');
	await page.getByRole('button', { name: 'Ver ao vivo' }).first().click();
	await page.waitForFunction(() => /Agente · ao vivo/i.test(document.body.innerText) && /resposta parcial/.test(document.body.innerText), null, { timeout: 15000 });
	const partial = (await page.locator('.bubble.agent .text').innerText()).trim();
	await shot('p17-resposta-ao-vivo.png');
	await page.waitForFunction(() => /Resposta final do agente/.test(document.body.innerText), null, { timeout: 20000 });
	const finalView = (await page.locator('#view').innerText()).replace(/\s+/g, ' ');
	check('F.4 the answer of an agent is followed live and ends on the final text, without reloading', /resposta parcial/.test(partial) && /Resposta final do agente/.test(finalView) && /tokens de entrada/.test(finalView), { partial: partial.slice(0, 50), usageShown: /tokens de entrada/.test(finalView) });
	await shot('p18-resposta-final.png');
	check('F.5 the response screen needs no sideways scroll', await noSideScroll());
	await page.getByRole('button', { name: /Voltar/ }).click();

	// the gateway restarts while the detail is open and an answer is on its way: the phone recovers, nothing is created again
	const creates = calls('comparisons.create').length;
	await gateway.stop();
	await delay(800);
	gateway = makeGateway();
	await gateway.start();
	await waitFor(async () => (await page.locator('article.card').count()) >= 2 && !/Sem conexão|Não foi possível/.test(await page.locator('#view').innerText()), 'the detail is still shown after the gateway restart', 20000);
	await page.getByRole('button', { name: 'Atualizar' }).click();
	await delay(1500);
	check('F.6 after the gateway restarts the same screen keeps working, with no duplicated cards', (await page.locator('article.card').count()) === 2 && calls('comparisons.create').length === creates);
	const sameId = sentRequests.find(item => item.url === '/api/comparisons');
	const replay = await fetch(base + '/api/comparisons', { method: 'POST', headers: { authorization: 'Bearer ' + await page.evaluate(() => localStorage.getItem('singularity.remote.token')), 'content-type': 'application/json', 'x-request-id': sameId.id }, body: sameId.body });
	const replayJson = await replay.json();
	check('F.7 repeating an earlier send after the restart is answered as already registered, and nothing starts', replayJson.duplicate === true && calls('comparisons.create').length === creates, replayJson.state);
	await page.reload();
	await page.waitForSelector('.tabs button');
	check('F.8 reopening the page after the restart goes straight back in (the device stays authorised)', (await page.locator('.tabs button').count()) === 6);
	await context.setOffline(true); await delay(1500); await context.setOffline(false); await delay(3500);
	check('F.9 losing the network for a moment and getting it back leaves the screen usable', (await page.locator('.tabs button').count()) === 6 && !(await page.locator('.pending').count()));

	// ============ a refusal from the computer, then another workspace: the old refusal does not stay over the new form ============
	const second = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-ma-ws2-')));
	const added2 = await admin('/admin/workspaces/add', { path: second });
	await page.reload();
	await page.waitForSelector('.tabs button');
	await page.locator('.tabs button', { hasText: 'Comparação' }).click();
	await page.locator('.tabs button', { hasText: 'Comparação' }).click();
	await page.getByRole('button', { name: 'Nova comparação' }).click();
	await page.waitForSelector('fieldset.agent');
	await page.locator('.form textarea').fill('RECUSAR esta tarefa');
	await page.getByRole('button', { name: 'Confirmar e iniciar' }).click();
	await page.waitForSelector('.pending.failed');
	check('G.1 a start that the computer refuses says so, that nothing was started, and offers to try again or to drop it', /Nada foi iniciado/.test(await page.locator('.pending').innerText()) && (await page.getByRole('button', { name: 'Descartar' }).count()) === 1);
	await shot('p19-envio-recusado.png');
	await page.locator('.form select').first().selectOption(added2.workspace.id);
	await page.waitForFunction(() => !document.querySelector('.pending'), null, { timeout: 5000 });
	check('G.2 choosing another workspace in the form hides the refusal that belonged to the first one', (await page.locator('.pending').count()) === 0);
	await page.locator('.form select').first().selectOption({ index: 0 });
	await page.waitForSelector('.pending.failed');
	await page.getByRole('button', { name: 'Descartar' }).click();
	await page.waitForFunction(() => !document.querySelector('.pending'), null, { timeout: 5000 });
	check('G.3 dropping a refused send clears it, and it does not come back after reloading the page', await (async () => { await page.reload(); await page.waitForSelector('.tabs button'); return !(await page.evaluate(() => localStorage.getItem('singularity.remote.pending'))); })());

	// ============ layout: 360 and 320 px, keyboard open, light theme ============
	await page.locator('.tabs button', { hasText: 'Equipe' }).click();
	await page.locator('.tabs button', { hasText: 'Equipe' }).click();
	const widths = {};
	for (const [width, height] of [[393, 873], [360, 780], [320, 640]]) {
		await page.setViewportSize({ width, height });
		for (const tab of ['Comparação', 'Equipe', 'Sessões', 'Início']) {
			await page.locator('.tabs button', { hasText: tab }).click();
			await delay(400);
			widths[`${tab}@${width}`] = await noSideScroll();
		}
		await page.locator('.tabs button', { hasText: 'Equipe' }).click();
		await page.getByRole('button', { name: 'Nova equipe' }).click();
		await page.waitForSelector('fieldset.agent');
		await page.locator('.form textarea').focus();
		await page.setViewportSize({ width, height: Math.round(height * 0.45) });
		await delay(300);
		widths[`form+teclado@${width}`] = await noSideScroll() && await page.locator('.form textarea').isVisible();
		await shot(`p13-equipe-form-${width}-teclado.png`);
		await page.setViewportSize({ width, height });
		await page.getByRole('button', { name: 'Fechar' }).click();
	}
	check('C.1 no screen scrolls sideways at 360 or 320 px, and the form stays usable with the Android keyboard open', Object.values(widths).every(Boolean), widths);
	await page.setViewportSize({ width: 320, height: 640 });
	await page.locator('.tabs button', { hasText: 'Comparação' }).click();
	await page.locator('.tabs button', { hasText: 'Comparação' }).click(); // a second tap on the open tab goes back to its list
	await page.getByRole('button', { name: 'Nova comparação' }).click();
	await page.waitForSelector('fieldset.agent');
	await shot('p14-comparacao-form-320.png');
	await page.emulateMedia({ colorScheme: 'light' });
	await shot('p15-comparacao-form-320-claro.png');
	check('C.2 the form is still within 320 px in the light theme', await noSideScroll());
	await page.emulateMedia({ colorScheme: 'dark' });
	const tapTargets = await page.evaluate(() => [...document.querySelectorAll('button, select')].filter(el => el.offsetParent !== null).every(el => el.getBoundingClientRect().height >= 40));
	check('C.3 every visible button and selector is at least 40 px tall for touch', tapTargets);

	// ============ forbidden surface ============
	const token = await page.evaluate(() => localStorage.getItem('singularity.remote.token'));
	const call = async (method, route, body) => { const r = await fetch(base + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-request-id': 'forbidden-' + Math.random().toString(16).slice(2, 12) }, body: body && JSON.stringify(body) }); return r.status; };
	const unauthorised = await call('POST', '/api/comparisons', { confirm: true, workspaceId: 'nao-autorizado', text: 'x', participants: [{ service: 'opencode', model: { providerID: 'opencode-go', modelID: 'muse-spark-1.3-contributor' } }, { service: 'opencode', model: { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' } }] });
	const forbidden = [await call('POST', '/api/solutions/apply', { confirm: true }), await call('POST', '/api/solutions/undo', { confirm: true }), await call('POST', '/api/rpc', { method: 'solutions.apply' }), await call('POST', '/api/teams/33333333-3333-4333-8333-333333333333/apply', { confirm: true, workspaceId: added.workspace.id })];
	check('C.4 an unauthorised workspace is refused, and apply, undo and a generic RPC do not exist', unauthorised === 403 && forbidden.every(status => status === 404), { unauthorised, forbidden });
	await browser.close();
}

main().catch(async error => { check('the multi-agent UI run completed', false, { error: error.message }); log(error.stack); try { await pageRef.screenshot({ path: path.join(outDir, 'failure.png') }); log('VIEW AT FAILURE:', (await pageRef.locator('#view').innerText()).replace(/\s+/g, ' ').slice(0, 400)); } catch { /* no page */ } }).finally(async () => {
	try { await browser?.close(); } catch { /* ignore */ }
	try { await gateway?.stop(); } catch { /* ignore */ }
	const ok = results.length > 0 && results.every(r => r.ok);
	fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ results, ok, finished: new Date().toISOString() }, null, 2));
	log(ok ? 'MULTI-AGENT UI CHECK PASSED' : 'MULTI-AGENT UI CHECK FAILED');
	process.exit(ok ? 0 : 1);
});
