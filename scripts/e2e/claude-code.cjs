'use strict';
// Real end-to-end test of the Claude Code adapter, through the Hub, on a synthetic workspace.
//
// It uses the CLI that is installed and logged in on this machine (no API key, no token read). Each model alias is exercised
// once with the smallest task; the controlled task, continuation, cancellation, restart and reopen use one model.
//
// Environment (all optional):
//   SINGULARITY_E2E_HUB_DIST    Hub build to test (default: ../../singularity-hub/dist)
//   SINGULARITY_E2E_CLAUDE_MODEL  alias for the main flow (default: sonnet)
//   SINGULARITY_E2E_CLAUDE_EFFORT effort for the main flow (default: low)
//   SINGULARITY_E2E_ALL_MODELS=1  also run one tiny task per alias and per effort level
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const dist = path.resolve(process.env.SINGULARITY_E2E_HUB_DIST || path.join(__dirname, '../../singularity-hub/dist'));
const { startHub } = require(path.join(dist, 'instance.js'));
const { HubConnection } = require(path.join(dist, 'client.js'));

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const claudeFor = id => { try { return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -like '*${id}*' } | Measure-Object).Count`], { encoding: 'utf8' }).trim()) || 0; } catch { return -1; } };

async function until(check, what, ms = 120000) {
	const end = Date.now() + ms;
	for (;;) {
		const value = await check();
		if (value) { return value; }
		if (Date.now() > end) { throw new Error('Timed out: ' + what); }
		await delay(100);
	}
}

async function main() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-claude-'));
	const home = path.join(root, 'hub');
	const workspace = path.join(root, 'workspace');
	fs.mkdirSync(workspace);
	fs.writeFileSync(path.join(workspace, 'notes.txt'), 'synthetic workspace\n');
	const alias = process.env.SINGULARITY_E2E_CLAUDE_MODEL || 'sonnet';
	const effort = process.env.SINGULARITY_E2E_CLAUDE_EFFORT || 'low';
	let hub = await startHub({ home });
	let client = await HubConnection.connect({ home, clientName: 'claude-code-e2e' });
	const events = [];
	const listen = c => c.on('notification', (method, data) => { if (method === 'session.event') { events.push(data.event); } });
	listen(client);
	const report = { checks: [] };
	const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok }); log(ok ? 'ok  ' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); assert(ok, name); };
	try {
		// ---------- detection, authentication, catalog ----------
		const catalog = await client.request('catalog.get', { service: 'claude-code', workspace }, 60000);
		const service = catalog.services.find(item => item.id === 'claude-code');
		check('1. Claude Code is detected, logged in and offered as available', service?.status === 'available', service);
		const models = catalog.providers[0]?.models ?? [];
		check('2. the catalog lists only what the CLI documents (aliases and effort levels)', models.length > 0 && models.every(m => m.efforts.length > 0), models.map(m => m.id + ':' + m.efforts.join('/')));
		const model = models.find(m => m.id === alias);
		assert(model, `the alias ${alias} is not in the catalog`);
		check('3. an alias or effort that is not in the catalog is refused', await client.request('session.create', { workspace, model: { providerID: 'claude-code', modelID: alias, variant: 'turbo' } }).then(() => false, () => true));
		check('3b. a permission bypass cannot be requested', await client.request('session.create', { workspace, model: { providerID: 'claude-code', modelID: alias }, permissionMode: 'bypassPermissions' }).then(() => false, () => true));

		// ---------- create, controlled task, streaming, model really used ----------
		const created = await client.request('session.create', { workspace, service: 'claude-code', model: { providerID: 'claude-code', modelID: alias, variant: effort }, permissionMode: 'acceptEdits' }, 60000);
		check('4. a session is created for the workspace with the chosen alias and effort', created.harness === 'claude-code' && created.status === 'idle' && created.model.variant === effort, { id: created.id.slice(0, 8), model: created.model });
		await client.request('session.subscribe', { sessionId: created.id });
		await client.request('session.prompt', { id: created.id, text: 'Create a file named hello.txt in the current directory containing exactly the text SINGULARITY-CLAUDE-OK (no trailing text). Then answer with the single word DONE.' });
		let sawPartial = false;
		let view;
		await until(async () => {
			[view] = (await client.request('sessions.list')).filter(s => s.id === created.id);
			if (view?.status === 'running' && view.result) { sawPartial = true; }
			if (view?.status === 'failed') { throw new Error('run failed: ' + view.summary); }
			return view?.status === 'done';
		}, 'the controlled task', 180000);
		check('5. real streaming: output was visible while the task was still running', sawPartial || events.some(e => e.data?.name === 'session.text.delta'), { deltas: events.filter(e => e.data?.name === 'session.text.delta').length });
		check('6. the controlled task changed the file in the workspace', fs.existsSync(path.join(workspace, 'hello.txt')) && fs.readFileSync(path.join(workspace, 'hello.txt'), 'utf8').trim() === 'SINGULARITY-CLAUDE-OK');
		check('7. the model really used is the one the CLI reported (a full model id, not the alias)', view.model.providerID === 'claude-code' && view.model.modelID !== alias && /claude/i.test(view.model.modelID), view.model);
		check('8. no Claude Code process is left after the task', await until(async () => claudeFor(created.id) === 0, 'claude process exit', 15000).then(() => true, () => false));

		// ---------- continue the same session ----------
		await client.request('session.prompt', { id: created.id, text: 'Which exact text did you write into hello.txt? Answer with only that text.' });
		await until(async () => { [view] = (await client.request('sessions.list')).filter(s => s.id === created.id); return view?.status === 'done' || view?.status === 'failed'; }, 'the continuation', 180000);
		check('9. the same session continues the same conversation (resume)', view.status === 'done' && /SINGULARITY-CLAUDE-OK/.test(view.result ?? ''), { status: view.status });
		check('9b. continuing did not create another session', (await client.request('sessions.list')).filter(s => !s.historical).length === 1);

		// ---------- cancel ----------
		await client.request('session.prompt', { id: created.id, text: 'Write a numbered poem with 200 lines, one line per number. Do not use tools.' });
		await until(async () => { [view] = (await client.request('sessions.list')).filter(s => s.id === created.id); return view?.status === 'running' && view.result; }, 'streaming before the cancel', 120000);
		const cancel = await client.request('session.interrupt', { id: created.id });
		await until(async () => { [view] = (await client.request('sessions.list')).filter(s => s.id === created.id); return view?.status === 'idle'; }, 'the cancelled session to be idle', 30000);
		check('10. one execution is cancelled and reported as interrupted', cancel.interrupted === true && /interrompida/i.test(view.summary ?? ''), { summary: view.summary });
		check('10b. the Job Object released the CLI process', await until(async () => claudeFor(created.id) === 0, 'claude process exit after cancel', 15000).then(() => true, () => false));

		// ---------- change the model alias/effort of the live session ----------
		const other = models.find(m => m.id !== alias);
		if (other) {
			const changed = await client.request('session.setModel', { id: created.id, model: { providerID: 'claude-code', modelID: other.id, variant: other.efforts[0] } });
			check('11. model and effort can be changed between tasks', changed.model.modelID === other.id && changed.model.variant === other.efforts[0], changed.model);
			await client.request('session.setModel', { id: created.id, model: { providerID: 'claude-code', modelID: alias, variant: effort } });
		}

		// ---------- end, restart the Hub (= closing the IDE), reopen, continue ----------
		await client.request('session.stop', { id: created.id }, 30000);
		check('12. ending the session archives it', (await client.request('sessions.list')).some(s => s.id === created.id && s.historical));
		client.close(); await hub.release();
		hub = await startHub({ home });
		client = await HubConnection.connect({ home, clientName: 'claude-code-e2e-2' });
		listen(client);
		const archived = (await client.request('sessions.list')).find(s => s.id === created.id);
		check('13. after the Hub restarts the session is still listed, archived, with its provider and workspace', archived?.historical === true && archived.harness === 'claude-code' && archived.resumable === true, { status: archived?.status });
		const turns = await client.request('session.history', { id: created.id, workspace });
		check('13b. the protected history keeps the turns', turns.length >= 3, { turns: turns.length });
		const reopened = await client.request('session.reopen', { id: created.id, workspace });
		check('14. reopening makes the session usable again without starting any execution', reopened.status === 'idle' && claudeFor(created.id) === 0);
		await client.request('session.prompt', { id: created.id, text: 'Which exact text is in hello.txt? Answer with only that text.' });
		await until(async () => { [view] = (await client.request('sessions.list')).filter(s => s.id === created.id); return view?.status === 'done' || view?.status === 'failed'; }, 'the resumed prompt', 180000);
		check('15. the reopened session resumes the original conversation', view.status === 'done' && /SINGULARITY-CLAUDE-OK/.test(view.result ?? ''), { status: view.status });

		// ---------- a failed run is reported with its reason and never retried silently ----------
		const unreachable = await client.request('session.create', { workspace, service: 'claude-code', model: { providerID: 'claude-code', modelID: alias } });
		await client.request('session.stop', { id: unreachable.id }, 30000);
		const neverRan = await client.request('session.reopen', { id: unreachable.id, workspace }).then(() => false, () => true);
		check('16. a session whose conversation never started cannot be "resumed" (no silent new execution)', neverRan && claudeFor(unreachable.id) === 0);

		// ---------- optional: every alias and effort once ----------
		if (process.env.SINGULARITY_E2E_ALL_MODELS === '1') {
			for (const m of models) {
				for (const level of m.efforts) {
					const s = await client.request('session.create', { workspace, service: 'claude-code', model: { providerID: 'claude-code', modelID: m.id, variant: level } }, 60000);
					await client.request('session.prompt', { id: s.id, text: 'Reply with the single word OK. Do not use tools.' });
					let v;
					await until(async () => { [v] = (await client.request('sessions.list')).filter(x => x.id === s.id); return v?.status === 'done' || v?.status === 'failed'; }, `${m.id}/${level}`, 180000);
					log(v.status === 'done' ? 'ok  ' : 'FAIL', `alias ${m.id} effort ${level}`, JSON.stringify({ used: v.model.modelID, status: v.status, failure: v.failure }));
					await client.request('session.stop', { id: s.id }, 30000);
				}
			}
		}
		console.log(JSON.stringify({ passed: report.checks.length, claudeVersion: (await client.request('sessions.list')).find(s => s.id === created.id)?.version }));
		console.log('Claude Code E2E PASSED');
	} finally {
		client.close();
		await hub.release().catch(() => undefined);
		fs.rmSync(root, { recursive: true, force: true });
	}
}

main().catch(error => { console.error('Claude Code E2E FAILED:', error.message); process.exitCode = 1; });
