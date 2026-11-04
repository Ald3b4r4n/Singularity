'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');

const dist = path.resolve(process.env.SINGULARITY_E2E_HUB_DIST || path.join(__dirname, '../../singularity-hub/dist'));
const { startHub } = require(path.join(dist, 'instance.js'));
const { HubConnection } = require(path.join(dist, 'client.js'));
const { once } = require('node:events');
const WebSocket = require(path.join(dist, '../node_modules/ws'));
const ui = require('./lib.cjs');
const exe = process.env.SINGULARITY_E2E_IDE;

async function webview(port, selector, expression) {
	for (const target of (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(item => item.type === 'iframe')) {
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		try {
			await once(socket, 'open');
			const reply = once(socket, 'message');
			socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
				expression: `(() => {
					const doc = document.querySelector('iframe#active-frame')?.contentDocument;
					if (doc?.querySelector(${JSON.stringify(selector)})) { return ${expression}; }
				})()`, returnByValue: true
			} }));
			const value = JSON.parse((await reply)[0]).result?.result?.value;
			if (value !== undefined) { return value; }
		} finally { socket.close(); }
	}
}

async function waitFor(check) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const value = await check().catch(() => undefined);
		if (value) { return value; }
		await delay(250);
	}
	throw new Error('Packaged IDE did not display the expected session history');
}

async function main() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'singularity-history-'));
	const home = path.join(root, 'hub');
	const workspaces = ['workspace-a', 'workspace-b'].map(name => path.join(root, name));
	await Promise.all(workspaces.map(workspace => fs.mkdir(workspace)));
	const modelID = process.env.SINGULARITY_E2E_OPENCODE_MODEL;
	assert(modelID, 'Select a real authorized OpenCode model.');
	const model = { providerID: 'opencode', modelID };
	let hub = await startHub({ home });
	let one, two;
	const windows = [];
	async function prompt(client, id, marker) {
		const text = 'Reply with exactly ' + marker + '. Do not use tools or read or modify files.';
		await client.request('session.prompt', { id, text });
		for (let i = 0; i < 180; i++) {
			const session = (await client.request('sessions.list')).find(item => item.id === id);
			assert.notEqual(session.status, 'failed', session.summary);
			if (session.status === 'done' && session.result?.includes(marker)) { return; }
			await delay(250);
		}
		throw new Error('Timed out waiting for ' + marker);
	}
	try {
		one = await HubConnection.connect({ home, clientName: 'history-first-window' });
		two = await HubConnection.connect({ home, clientName: 'history-second-window' });
		const sessions = [];
		for (const workspace of [workspaces[0], workspaces[1], workspaces[0]]) {
			sessions.push(await one.request('session.create', { workspace, model }, 60000));
		}
		const [a, b, c] = sessions;
		assert.equal(new Set([a.id, b.id, c.id]).size, 3);
		if (exe) {
			const basePort = 31000 + Math.floor(Math.random() * 8000);
			for (let index = 0; index < 2; index++) {
				const port = basePort + index;
				const profile = path.join(root, 'profile-' + index);
				ui.launch({ exe, profile, workspace: workspaces[index], port, env: { SINGULARITY_HUB_HOME: home },
					settings: { 'singularity.agents.hub.autoStart': false, 'singularity.update.checkAutomatically': false } });
				windows.push({ port, profile, cdp: await ui.cdp(port) });
			}
			for (const [index, expected] of [[0, [a.id, c.id]], [1, [b.id]]]) {
				await waitFor(() => webview(windows[index].port, '.nav-heading',
					`JSON.stringify([...doc.querySelectorAll('.session[data-id]')].map(card => card.dataset.id).sort()) === ${JSON.stringify(JSON.stringify(expected.sort()))}`));
			}
		}
		await prompt(one, a.id, 'ALPHA_273');
		await prompt(two, b.id, 'BRAVO_374');
		await prompt(one, c.id, 'CHARLIE_475');
		await prompt(two, a.id, 'DELTA_576');
		const params = { id: a.id, workspace: workspaces[0] };
		const turns = await two.request('session.history', params);
		assert.deepEqual(turns.map(turn => turn.result.trim()), ['ALPHA_273', 'DELTA_576']);
		await assert.rejects(two.request('session.history', { ...params, workspace: workspaces[1] }));
		await one.request('session.stop', { id: a.id }, 30000);
		const active = await two.request('sessions.list');
		assert(active.some(item => item.id === a.id && item.historical));
		assert(active.some(item => item.id === b.id && !item.historical));
		assert(active.some(item => item.id === c.id && !item.historical));
		one.close(); two.close(); one = two = undefined;
		await hub.release();
		hub = await startHub({ home });
		one = await HubConnection.connect({ home, clientName: 'history-restarted' });
		assert.deepEqual(await one.request('session.history', params), turns);
		assert((await one.request('sessions.list')).filter(item => item.historical).length === 3);
		if (exe) {
			const port = windows[0].port;
			const id = JSON.stringify(a.id);
			await waitFor(() => webview(port, '.nav-heading',
				`(() => { const link = [...doc.querySelectorAll('.session-link')].find(item => item.dataset.id === ${id}); link?.click(); return !!link; })()`));
			await waitFor(() => webview(port, '#composer',
				"doc.querySelectorAll('.history-turn').length === 2 && doc.querySelector('#send').disabled"));
			const shot = path.join(root, 'history-after-restart.png');
			await windows[0].cdp.screenshot(shot);
			console.log('Packaged IDE: ' + shot);
		}
		await assert.rejects(one.request('session.prompt', { id: a.id, text: 'unexpected' }));
		assert.deepEqual(await one.request('session.deleteHistory', params), { deleted: true });
		await assert.rejects(one.request('session.history', params));
		console.log('Three real sessions, two clients, four prompts, workspace isolation, persistent history after restart, and deletion passed.');
	} finally {
		one?.close(); two?.close();
		await hub.release();
		for (const window of windows) { window.cdp.close(); await ui.closeApp(window.profile); }
	}
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
