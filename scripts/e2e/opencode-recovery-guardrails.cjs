'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const dist = path.resolve(process.env.SINGULARITY_E2E_HUB_DIST || path.join(__dirname, '../../singularity-hub/dist'));
const { HubConnection } = require(path.join(dist, 'client.js'));
const { writeFileAtomic } = require(path.join(dist, 'secure.js'));
const helper = path.join(dist, 'singularity-job.exe');
const runtime = process.env.SINGULARITY_E2E_HUB_NODE || process.execPath;

async function main() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'singularity-recovery-guards-'));
	const home = path.join(root, 'hub');
	const workspace = path.join(root, 'workspace');
	const modelID = process.env.SINGULARITY_E2E_OPENCODE_MODEL;
	assert(modelID, 'Select a real authorized model for the recovery guardrail test.');
	await fs.mkdir(workspace);
	let child;
	let client;
	let session;
	let originalCiphertext;
	let originalPlaintext;
	let helperHidden = false;
	const hiddenHelper = helper + '.regression-hidden';
	const recordPath = () => path.join(home, 'recovery', session.id + '.dpapi');

	async function start() {
		child = spawn(runtime, [path.join(dist, 'main.js')], {
			env: { ...process.env, SINGULARITY_HUB_HOME: home }, windowsHide: true, stdio: 'ignore'
		});
		for (let attempt = 0; attempt < 100; attempt++) {
			if (child.exitCode !== null) { throw new Error('Hub exited during recovery guardrail test'); }
			try {
				client = await HubConnection.connect({ home, clientName: 'recovery-guardrails-e2e' });
				return;
			} catch { await delay(150); }
		}
		throw new Error('Hub did not become reachable');
	}

	async function shutdown() {
		const exited = child && child.exitCode === null ? once(child, 'exit') : undefined;
		if (client) {
			await client.request('hub.shutdown').catch(() => undefined);
			client.close();
			client = undefined;
		}
		await exited?.catch(() => undefined);
		child = undefined;
	}

	async function crash() {
		client?.close();
		client = undefined;
		const exited = once(child, 'exit');
		child.kill('SIGKILL');
		await exited;
		child = undefined;
	}

	async function expectUnrecoverable(stage) {
		await start();
		const sessions = await client.request('sessions.list');
		const recovered = sessions.find(item => item.id === session.id);
		assert.equal(recovered?.status, 'failed', stage);
		assert.equal(recovered?.recovery, 'unrecoverable', stage);
		assert(!sessions.some(item => item.id === session.id && !item.recovery), stage + ': duplicate active session');
		await assert.rejects(client.request('session.prompt', { id: session.id, text: 'must not execute' }), stage + ': prompt was accepted');
		await shutdown();
	}

	async function expectRecovered() {
		await start();
		const sessions = await client.request('sessions.list');
		assert(sessions.some(item => item.id === session.id && !item.recovery && !item.historical), 'original session was not recovered for cleanup or the next scenario');
	}

	async function hideHelper() {
		await fs.rename(helper, hiddenHelper);
		helperHidden = true;
	}

	async function restoreHelper() {
		if (helperHidden) {
			await fs.rename(hiddenHelper, helper);
			helperHidden = false;
		}
	}

	async function restoreRecord() {
		if (originalCiphertext && session) {
			writeFileAtomic(recordPath(), originalCiphertext.toString('base64'));
		}
	}

	try {
		await start();
		session = await client.request('session.create', { workspace, model: { providerID: 'opencode', modelID } }, 60000);
		originalCiphertext = Buffer.from(await fs.readFile(recordPath(), 'utf8'), 'base64');
		originalPlaintext = spawnSync(helper, ['unprotect-recovery'], { input: originalCiphertext, windowsHide: true, timeout: 5000 });
		assert.equal(originalPlaintext.status, 0);
		await crash();

		await hideHelper();
		await expectUnrecoverable('missing helper');
		await restoreHelper();
		await expectRecovered();
		await crash();

		const wrongCredential = JSON.parse(originalPlaintext.stdout.toString('utf8'));
		wrongCredential.authorization = 'Basic ' + Buffer.from('opencode:incorrect-regression-credential').toString('base64');
		const encryptedWrongCredential = spawnSync(helper, ['protect-recovery'], { input: Buffer.from(JSON.stringify(wrongCredential)), windowsHide: true, timeout: 5000 });
		assert.equal(encryptedWrongCredential.status, 0);
		writeFileAtomic(recordPath(), encryptedWrongCredential.stdout.toString('base64'));
		encryptedWrongCredential.stdout.fill(0);
		await expectUnrecoverable('incorrect credential');
		await restoreRecord();
		await expectRecovered();
		await crash();

		const tampered = Buffer.from(originalCiphertext);
		tampered[Math.floor(tampered.length / 2)] ^= 0x80;
		writeFileAtomic(recordPath(), tampered.toString('base64'));
		tampered.fill(0);
		await expectUnrecoverable('tampered recovery record');
		await restoreRecord();
		await expectRecovered();
		await client.request('session.stop', { id: session.id }, 30000);
		assert((await client.request('sessions.list')).some(item => item.id === session.id && item.historical));
		await shutdown();
		console.log(JSON.stringify({ missingHelper: 'rejected', incorrectCredential: 'rejected', tamperedRecord: 'rejected', duplicateExecution: false, originalJobStopped: true }, null, 2));
	} finally {
		client?.close();
		if (child && child.exitCode === null) { child.kill('SIGKILL'); }
		await restoreHelper().catch(() => undefined);
		await restoreRecord().catch(() => undefined);
		if (session) {
			try {
				await start();
				const active = (await client.request('sessions.list')).find(item => item.id === session.id && !item.historical && !item.recovery);
				if (active) { await client.request('session.stop', { id: session.id }, 30000); }
				await shutdown();
			} catch { /* Preserve the original test failure. */ }
		}
		originalPlaintext?.stdout?.fill(0);
		originalCiphertext?.fill(0);
		await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
	}
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
