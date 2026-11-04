'use strict';

// Real Windows smoke test. Uses the installed OpenCode provider and a new temporary workspace.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { isOwnerOnly } = require('../../singularity-hub/dist/secure.js');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { startHub } = require('../../singularity-hub/dist/instance.js');
const { HubConnection } = require('../../singularity-hub/dist/client.js');

async function main() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'singularity-opencode-e2e-'));
	const home = path.join(root, 'hub');
	const workspace = path.join(root, 'workspace');
	await fs.mkdir(workspace);
	const hub = await startHub({ home });
	assert.equal(hub.kind, 'started');
	let client;
	const events = [];
	const connect = async () => {
		const c = await HubConnection.connect({ home, clientName: 'singularity-opencode-smoke' });
		c.on('notification', (method, payload) => {
			if (method === 'session.event') {
				events.push(payload.event);
			}
		});
		return c;
	};
	try {
		client = await connect();
		await client.request('session.subscribe', {});
		const modelID = process.env.SINGULARITY_E2E_OPENCODE_MODEL;
		const model = modelID ? { providerID: 'opencode', modelID } : undefined;
		const created = await client.request('session.create', { workspace, model }, 45000);
		assert.equal(created.workspace.toLowerCase(), (await fs.realpath(workspace)).toLowerCase());
		assert.equal(created.harness, 'opencode');
		assert.match(created.version, /^v?2\./);
		const id = created.id;
		const recoveryDir = path.join(home, 'recovery');
		const recordPath = path.join(recoveryDir, id + '.dpapi');
		assert(isOwnerOnly(recoveryDir) && isOwnerOnly(recordPath), 'recovery record must be owner-only');
		const ciphertext = Buffer.from(await fs.readFile(recordPath, 'utf8'), 'base64');
		const helper = path.resolve(__dirname, '../../singularity-hub/dist/singularity-job.exe');
		const unprotect = input => spawnSync(helper, ['unprotect-recovery'], { input, windowsHide: true });
		const plain = unprotect(ciphertext);
		try {
			assert.equal(plain.status, 0);
			const record = JSON.parse(plain.stdout);
			assert.equal(record.sessionId, id);
			assert(record.authorization.startsWith('Basic ') && /^[a-f0-9]{64}$/.test(record.control), 'both recovery credentials are present');
			assert(!ciphertext.includes(record.authorization) && !ciphertext.includes(record.control), 'the record contains no plaintext credentials');
		} finally {
			plain.stdout?.fill(0);
		}
		ciphertext[Math.floor(ciphertext.length / 2)] ^= 0x80;
		assert.notEqual(unprotect(ciphertext).status, 0, 'modified DPAPI record must be rejected');
		await client.request('session.prompt', { id, text: 'Reply with exactly SINGULARITY_OK. Do not use tools or read or modify files.' });
		const start = Date.now();
		client.close();
		client = await connect();
		assert((await client.request('sessions.list')).some(session => session.id === id));
		await client.request('session.subscribe', { fromSeq: 0, sessionId: id });
		let terminal;
		while (!terminal && Date.now() - start < 90000) {
			const sessions = await client.request('sessions.list');
			terminal = sessions.find(s => s.id === id && ['done', 'failed'].includes(s.status));
			if (!terminal) { await sleep(250); }
		}
		assert(terminal, 'the OpenCode run did not reach a terminal state');
		const names = [...new Set(events.filter(e => e.sessionId === id && e.type === 'opencode.event').map(e => e.data.name))];
		assert(names.includes('session.execution.started'), 'execution did not stream a start event');
		if (terminal.status === 'done') {
			assert(terminal.result, 'OpenCode produced no assistant text');
		} else {
			assert(terminal.summary, 'OpenCode failure was not reported');
		}
		await client.request('session.prompt', { id, text: 'Write a long poem. Do not use tools or read or modify files.' });
		const cancel = await client.request('session.interrupt', { id }, 15000);
		await client.request('session.stop', { id }, 30000);
		assert(!(await client.request('sessions.list')).some(session => session.id === id && !session.historical));
		await assert.rejects(fs.stat(recordPath), { code: 'ENOENT' });
		console.log(JSON.stringify({ version: created.version, model: terminal.model, terminal: terminal.status, diagnostic: terminal.summary, events: names, interrupted: cancel.interrupted, reconnect: true, jobTreeEmpty: true }, null, 2));
	} finally {
		client?.close();
		await hub.release();
	}
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
