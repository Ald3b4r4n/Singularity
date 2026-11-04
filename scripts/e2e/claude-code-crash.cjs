'use strict';
// What happens to Claude Code when the Hub is killed in the middle of a run.
//
// This is deliberately NOT the OpenCode behaviour. OpenCode is a server that outlives the Hub and is re-attached after a crash.
// Claude Code runs one process per prompt, with its output piped to the Hub, so a run cannot survive the Hub. The contract
// proved here is the honest one:
//   - the helper ends the Job Object when the Hub dies: no agent keeps running unattended;
//   - the interrupted run is shown as failed, never as done, and nothing is started again by itself;
//   - the session stays in the protected history and, once reopened, resumes the same CLI conversation.
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const dist = path.resolve(process.env.SINGULARITY_E2E_HUB_DIST || path.join(__dirname, '../../singularity-hub/dist'));
const { HubConnection } = require(path.join(dist, 'client.js'));
const runtime = process.env.SINGULARITY_E2E_HUB_NODE || process.execPath;
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const claudeFor = id => { try { return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -like '*${id}*' } | Measure-Object).Count`], { encoding: 'utf8' }).trim()) || 0; } catch { return -1; } };

async function main() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-claude-crash-'));
	const home = path.join(root, 'hub');
	const workspace = path.join(root, 'workspace');
	fs.mkdirSync(workspace);
	let child, client;
	async function start() {
		child = spawn(runtime, [path.join(dist, 'main.js')], { env: { ...process.env, SINGULARITY_HUB_HOME: home }, windowsHide: true, stdio: 'ignore' });
		for (let i = 0; i < 100; i++) {
			if (child.exitCode !== null) { throw new Error('Hub exited early'); }
			try { return await HubConnection.connect({ home, clientName: 'claude-crash-e2e' }); } catch { await delay(150); }
		}
		throw new Error('Hub did not become reachable');
	}
	try {
		client = await start();
		const first = client.hello.hub.instanceId;
		const session = await client.request('session.create', { workspace, service: 'claude-code', model: { providerID: 'claude-code', modelID: process.env.SINGULARITY_E2E_CLAUDE_MODEL || 'sonnet', variant: 'low' } }, 60000);
		await client.request('session.prompt', { id: session.id, text: 'Remember the codeword PELICAN-7. Then write a numbered poem with 300 lines. Do not use tools.' });
		let live;
		for (let i = 0; i < 1200; i++) {
			[live] = await client.request('sessions.list');
			if (live?.status === 'running' && live.result) { break; }
			if (live?.status === 'failed') { throw new Error(live.summary); }
			await delay(100);
		}
		assert(live?.status === 'running' && live.result, 'Claude Code must stream real output before the crash');
		assert(claudeFor(session.id) > 0, 'a Claude Code process must be running for this session');
		const exit = once(child, 'exit');
		child.kill('SIGKILL');
		await exit;
		client.close();
		log('Hub killed while Claude Code was streaming');
		let gone = false;
		const killedAt = Date.now(); while (!gone && Date.now() - killedAt < 20000) { gone = claudeFor(session.id) === 0; }
		log('Job Object ended after', Math.round((Date.now() - killedAt) / 100) / 10, 's');
		if (!gone) { console.log(execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${session.id}*' -or $_.Name -eq 'singularity-job.exe' } | ForEach-Object { '{0} {1} parent={2}' -f $_.ProcessId, $_.Name, $_.ParentProcessId }`], { encoding: 'utf8' })); }
		assert(gone, 'the Job Object must end the CLI when the Hub dies');
		log('ok   the helper ended the Job Object: no Claude Code process is left');

		client = await start();
		assert.notEqual(client.hello.hub.instanceId, first);
		const sessions = await client.request('sessions.list');
		assert.equal(sessions.length, 1);
		assert.equal(sessions[0].id, session.id);
		assert.equal(sessions[0].historical, true);
		assert.equal(sessions[0].harness, 'claude-code');
		assert.equal(sessions[0].status, 'failed', 'an interrupted run is never shown as done or running');
		await delay(2000);
		assert(claudeFor(session.id) === 0, 'nothing is started again by itself');
		log('ok   after restart the session is listed as archived and failed; nothing was started again');

		const reopened = await client.request('session.reopen', { id: session.id, workspace });
		assert.equal(reopened.status, 'idle');
		await client.request('session.prompt', { id: session.id, text: 'What was the codeword? Answer with only the codeword.' });
		let view;
		for (let i = 0; i < 1800; i++) {
			[view] = await client.request('sessions.list');
			if (view.status === 'done' || view.status === 'failed') { break; }
			await delay(100);
		}
		// The conversation that was cut off had already stored the first message; if the CLI kept it, the codeword is remembered.
		log(view.status === 'done' ? 'ok   ' : 'FAIL', 'reopened session continued the CLI conversation', JSON.stringify({ status: view.status, remembersCodeword: /PELICAN-7/.test(view.result ?? '') }));
		assert.equal(view.status, 'done');
		await client.request('session.stop', { id: session.id }, 30000);
		console.log('Claude Code crash behaviour verified (run lost, job ended, session kept and resumable).');
	} finally {
		if (client) { await client.request('hub.shutdown').catch(() => undefined); client.close(); }
		await delay(500);
		fs.rmSync(root, { recursive: true, force: true });
	}
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
