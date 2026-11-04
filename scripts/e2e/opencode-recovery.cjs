'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const dist = path.resolve(process.env.SINGULARITY_E2E_HUB_DIST || path.join(__dirname, '../../singularity-hub/dist'));
const { HubConnection } = require(path.join(dist, 'client.js'));
const runtime = process.env.SINGULARITY_E2E_HUB_NODE || process.execPath;
const exe = process.env.SINGULARITY_E2E_IDE;
const ui = require('./lib.cjs');
const WebSocket = require(path.join(dist, '../node_modules/ws'));

async function visibleSession(port, id) {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
	for (const target of targets.filter(target => target.type === 'iframe')) {
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		try {
			await once(socket, 'open');
			const response = once(socket, 'message');
			socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
				expression: `document.querySelector('iframe#active-frame')?.contentDocument?.querySelector('.session')?.dataset.id === ${JSON.stringify(id)}`,
				returnByValue: true
			} }));
			if (JSON.parse((await response)[0]).result?.result?.value) { return true; }
		} finally { socket.close(); }
	}
	return false;
}

async function main() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'singularity-recovery-'));
	const home = path.join(root, 'hub');
	const workspace = path.join(root, 'workspace');
	await fs.mkdir(workspace);
	const modelID = process.env.SINGULARITY_E2E_OPENCODE_MODEL;
	assert(modelID, 'Select a real authorized model for the recovery test.');
	let child, client, workbench, debugPort;
	const profile = path.join(root, 'profile');
	async function start() {
		child = spawn(runtime, [path.join(dist, 'main.js')], {
			env: { ...process.env, SINGULARITY_HUB_HOME: home }, windowsHide: true, stdio: 'ignore'
		});
		for (let i = 0; i < 100; i++) {
			if (child.exitCode !== null) { throw new Error('Hub exited before recovery completed'); }
			try { return await HubConnection.connect({ home, clientName: 'crash-recovery-e2e' }); } catch { await delay(150); }
		}
		throw new Error('Hub did not become reachable');
	}
	try {
		client = await start();
		const firstHub = client.hello.hub.instanceId;
		if (exe) {
			debugPort = 21000 + Math.floor(Math.random() * 10000);
			ui.launch({ exe, profile, workspace, port: debugPort, env: { SINGULARITY_HUB_HOME: home }, settings: {
				'singularity.agents.hub.autoStart': false, 'singularity.update.checkAutomatically': false
			} });
			workbench = await ui.cdp(debugPort);
			for (let i = 0; i < 120 && !await workbench.evaluate("document.title.includes('Agentes')"); i++) { await delay(250); }
			assert(await workbench.evaluate("document.title.includes('Agentes')"), 'the packaged IDE did not open Agentes');
		}
		const session = await client.request('session.create', { workspace, model: { providerID: 'opencode', modelID } }, 60000);
		const task = 'Write a long numbered poem with 300 lines. Start immediately and do not use tools or touch files.';
		await client.request('session.prompt', { id: session.id, text: task });
		const end = Date.now() + 30000;
		let active;
		while (Date.now() < end) {
			[active] = await client.request('sessions.list');
			if (active?.status === 'running' && active.result) { break; }
			if (active?.status === 'failed') { throw new Error(active.summary); }
			await delay(100);
		}
		assert(active?.status === 'running' && active.result, 'OpenCode must stream real output before the crash');
		const before = once(child, 'exit');
		child.kill('SIGKILL');
		await before;
		client.close();
		client = await start();
		assert.notEqual(client.hello.hub.instanceId, firstHub);
		const sessions = await client.request('sessions.list');
		assert.equal(sessions.length, 1);
		assert.equal(sessions[0].id, session.id);
		assert.equal(sessions[0].status, 'running', sessions[0].summary);
		await client.request('session.subscribe', { sessionId: session.id });
		let resumed = false;
		client.on('notification', (method, data) => {
			if (method === 'session.event' && data.event?.data?.name === 'session.text.delta') { resumed = true; }
		});
		for (let i = 0; i < 100 && !resumed; i++) { await delay(100); }
		assert(resumed, 'no post-recovery SSE delta');
		if (workbench) {
			for (let i = 0; i < 20 && !await visibleSession(debugPort, session.id); i++) { await delay(250); }
			assert(await visibleSession(debugPort, session.id), 'the packaged IDE did not show the recovered session');
			const shot = path.join(root, 'packaged-recovery.png');
			await workbench.screenshot(shot);
			console.log('Packaged IDE: ' + shot);
		}
		const cancel = await client.request('session.interrupt', { id: session.id });
		assert(cancel.interrupted, 'recovered task was not interrupted');
		await client.request('session.stop', { id: session.id }, 30000);
		assert.deepEqual(await client.request('sessions.list'), []);

		console.log('Recovered original session after SIGKILL, resumed SSE, interrupted and confirmed an empty Job Object.');
	} finally {
		if (client) {
			await client.request('hub.shutdown').catch(() => undefined);
			client.close();
		}
		workbench?.close();
		if (exe) { await ui.closeApp(profile); }
	}
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
