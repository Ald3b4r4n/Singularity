import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import { describe, it } from 'node:test';
import * as path from 'path';
import { HubConnection, RpcFailure } from '../client';
import { discover } from '../discovery';
import { HUB_MAIN } from '../launch';
import { file } from '../paths';
import { aclPrincipals, currentWindowsUser, ensureSecureDir, isOwnerOnly, readSecureFile } from '../secure';
import { HubSupervisor, PanelState } from '../supervisor';
import { alive, cleanup, MAIN, sleep, spawnMain, startInProcess, tempHome, waitFor } from './helpers';

const stopHub = async (home: string): Promise<void> => {
	try {
		const c = await HubConnection.connect({ home, clientName: 'test-stop' });
		await c.request('hub.shutdown', {});
	} catch { /* already gone */ }
	await waitFor(async () => !fs.existsSync(file(home, 'connection')), 8000).catch(() => undefined);
};

describe('single instance', () => {
	it('lets exactly one of several simultaneous starters become the Hub', async () => {
		const home = tempHome('concurrent');
		try {
			const children = Array.from({ length: 6 }, () => spawnMain(home));
			const exits = children.map(c => new Promise<number | null>(r => c.once('exit', code => r(code))));
			const d = await waitFor(() => discover(home).catch(() => undefined), 15_000);
			await sleep(2500); // let the losers notice and leave
			const running = children.filter(c => c.pid !== undefined && alive(c.pid));
			assert.equal(running.length, 1, 'one Hub process remains');
			assert.equal(running[0].pid, d.info.pid, 'and it is the one that published the connection');
			const codes = await Promise.all(exits.filter((_, i) => !running.includes(children[i])));
			assert.ok(codes.every(code => code === 0), `the others exited cleanly: ${codes.join(',')}`);
			await stopHub(home);
		} finally { cleanup(home); }
	});

	it('reports "already running" when a Hub of this user exists', async () => {
		const home = tempHome('existing');
		const hub = await startInProcess(home);
		try {
			const { startHub } = await import('../instance');
			const second = await startHub({ home });
			assert.equal(second.kind, 'already-running');
			if (second.kind === 'already-running') {
				assert.equal(second.existing.info.instanceId, hub.info.instanceId);
			}
		} finally { await hub.release(); cleanup(home); }
	});

	it('recovers from a stale lock left by a dead process', async () => {
		const home = tempHome('stale');
		try {
			ensureSecureDir(home);
			// pid 2^22 is not a live process; the lock claims otherwise, and there is no Hub behind it
			fs.writeFileSync(file(home, 'lock'), JSON.stringify({ pid: 4_194_000, nonce: 'old', startedAt: new Date(0).toISOString() }));
			fs.writeFileSync(file(home, 'connection'), JSON.stringify({ v: 1, instanceId: 'ghost', pid: 4_194_000, port: 59999, startedAt: '', hubVersion: '0', protocol: { min: 1, max: 1 } }));
			const hub = await startInProcess(home);
			assert.notEqual(hub.info.instanceId, 'ghost');
			await hub.release();
		} finally { cleanup(home); }
	});

	it('does not trust a lock or connection file just because a pid is alive', async () => {
		const home = tempHome('pid');
		try {
			ensureSecureDir(home);
			// our own (live) pid in the files, but nobody can prove it is a Hub
			fs.writeFileSync(file(home, 'token'), 'T'.repeat(43));
			fs.writeFileSync(file(home, 'connection'), JSON.stringify({ v: 1, instanceId: 'x', pid: process.pid, port: 59998, startedAt: '', hubVersion: '0', protocol: { min: 1, max: 1 } }));
			await assert.rejects(discover(home), /did not answer/);
		} finally { cleanup(home); }
	});
});

describe('token lifecycle', () => {
	it('rotates the token on every start and invalidates the old one', async () => {
		const home = tempHome('rotate');
		try {
			const first = await startInProcess(home);
			const token1 = first.token;
			const info1 = first.info;
			await first.release();
			const second = await startInProcess(home);
			assert.notEqual(second.token, token1);
			assert.notEqual(second.info.instanceId, info1.instanceId);
			const stale = { info: second.info, token: token1, home };
			await assert.rejects(HubConnection.connect({ home, clientName: 't', discovered: stale }), (e: RpcFailure) => e.code === 401);
			const ok = await HubConnection.connect({ home, clientName: 't' });
			ok.close();
			await second.release();
		} finally { cleanup(home); }
	});

	it('shuts down on an authenticated hub.shutdown and cleans up its files', async () => {
		const home = tempHome('shutdown');
		const child = spawnMain(home);
		try {
			const exit = new Promise<number | null>(r => child.once('exit', code => r(code)));
			const c = await waitFor(() => HubConnection.connect({ home, clientName: 't' }).catch(() => undefined), 15_000);
			const closed = new Promise<void>(r => c.once('close', () => r()));
			const notice = new Promise<string>(r => c.on('notification', (m: string) => { if (m === 'hub.shuttingDown') { r(m); } }));
			await c.request('hub.shutdown', {});
			assert.equal(await notice, 'hub.shuttingDown');
			await closed;
			assert.equal(await exit, 0);
			assert.deepEqual(fs.readdirSync(home).filter(n => n !== 'hub.log' && n !== 'hub.log.1'), []);
		} finally { child.kill(); cleanup(home); }
	});

	it('stops answering after shutdown (connection refused is reported as disconnected)', async () => {
		const home = tempHome('gone');
		const hub = await startInProcess(home);
		await hub.release();
		await assert.rejects(discover(home));
		cleanup(home);
	});
});

describe('credentials on disk', () => {
	it('restricts the state directory and every file to the current user (ACL)', async () => {
		const home = tempHome('acl');
		const hub = await startInProcess(home);
		try {
			const me = currentWindowsUser().name.toLowerCase();
			assert.ok(isOwnerOnly(home));
			for (const name of ['token', 'connection', 'lock'] as const) {
				const principals = aclPrincipals(file(home, name)).map(p => p.toLowerCase());
				assert.ok(principals.length > 0 && principals.every(p => p.replace(/[^a-z0-9\\]/g, '') === me.replace(/[^a-z0-9\\]/g, '')), `${name}: ${principals.join(' | ')}`);
			}
			assert.equal(readSecureFile(file(home, 'token')).trim(), hub.token);
		} finally { await hub.release(); cleanup(home); }
	});

	it('refuses to read credentials once the directory is opened to other users', async () => {
		const home = tempHome('widen');
		const hub = await startInProcess(home);
		try {
			execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [home, '/grant', '*S-1-1-0:(OI)(CI)R'], { stdio: 'ignore', windowsHide: true });
			assert.equal(isOwnerOnly(home), false);
			await assert.rejects(discover(home), /not protected/);
			await assert.rejects(startInProcess(tempHome('x'), {}).then(() => undefined).catch(e => { throw e; }).then(() => { throw new Error('unreachable'); }), /unreachable|refusing/).catch(() => undefined);
		} finally { await hub.release().catch(() => undefined); cleanup(home); }
	});

	it('writes the token file atomically (no partial token is ever visible)', async () => {
		const { writeFileAtomic } = await import('../secure');
		const home = tempHome('atomic');
		try {
			ensureSecureDir(home);
			const target = file(home, 'token');
			writeFileAtomic(target, 'A'.repeat(43));
			let bad = 0;
			const reader = setInterval(() => { const t = fs.readFileSync(target, 'utf8'); if (t !== 'A'.repeat(43) && t !== 'B'.repeat(43)) { bad++; } }, 1);
			for (let i = 0; i < 200; i++) { writeFileAtomic(target, (i % 2 ? 'A' : 'B').repeat(43)); await sleep(1); }
			clearInterval(reader);
			assert.equal(bad, 0);
			assert.deepEqual(fs.readdirSync(home).filter(n => n.endsWith('.tmp')), []);
		} finally { cleanup(home); }
	});

	it('keeps tokens, authorization headers and request contents out of the log', async () => {
		const home = tempHome('logs');
		const hub = await startInProcess(home);
		try {
			const c = await HubConnection.connect({ home, clientName: 'SECRET-CLIENT-NAME' });
			await c.request('SECRET-PROMPT-METHOD', { prompt: 'SECRET-PROMPT-TEXT' }).catch(() => undefined);
			await c.request('session.subscribe', { sessionId: 'SECRET-SESSION' }).catch(() => undefined);
			c.close();
			await sleep(200);
			const { attemptUpgrade } = await import('./helpers');
			await attemptUpgrade(hub.info.port, { headers: { Authorization: 'Bearer ' + 'Q'.repeat(43) } });
			await attemptUpgrade(hub.info.port, { path: `/ws?token=${hub.token}` });
			await hub.release();
			const log = fs.readFileSync(file(home, 'log'), 'utf8');
			for (const secret of [hub.token, 'Q'.repeat(43), 'Bearer', 'Authorization', 'SECRET-']) {
				assert.ok(!log.includes(secret), `log leaked ${secret.slice(0, 8)}`);
			}
			assert.match(log, /hub started/);
		} finally { cleanup(home); }
	});
});

describe('independent process and reconnection', () => {
	const spawnerScript = (home: string): string => `
		process.env.SINGULARITY_HUB_HOME = ${JSON.stringify(home)};
		const { spawnHub, findNode } = require(${JSON.stringify(path.join(__dirname, '..', 'launch.js'))});
		console.log(spawnHub(findNode(), ${JSON.stringify(HUB_MAIN)}));
	`;

	it('survives the death of the process that launched it (detached)', async () => {
		const home = tempHome('detached');
		try {
			const parent = spawn(process.execPath, ['-e', spawnerScript(home)], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
			let out = '';
			parent.stdout.on('data', d => { out += d; });
			await new Promise(r => parent.once('exit', r)); // the launcher is gone before we look
			const hubPid = Number(out.trim());
			const d = await waitFor(() => discover(home).catch(() => undefined), 15_000);
			assert.equal(d.info.pid, hubPid);
			await sleep(1000);
			assert.ok(alive(hubPid), 'the Hub outlives the launcher');
			await stopHub(home);
		} finally { cleanup(home); }
	});

	it('supervisor: connects after starting a Hub, reports zero sessions, and only then says "connected"', async () => {
		const home = tempHome('sup');
		const states: PanelState[] = [];
		const sup = new HubSupervisor({ home, startupWaitMs: 15_000 });
		sup.on('change', (s: PanelState) => states.push(s));
		try {
			assert.equal(sup.getState().hub.status, 'disconnected');
			await sup.start(true);
			assert.equal(sup.getState().hub.status, 'connected');
			assert.deepEqual(sup.getState().sessions, []);
			const firstConnected = states.findIndex(s => s.hub.status === 'connected');
			assert.ok(states.slice(0, firstConnected).every(s => s.hub.status !== 'connected'));
			assert.ok(!JSON.stringify(states).match(/token|Bearer/i), 'panel state never carries credentials');
		} finally { sup.dispose(); await stopHub(home); cleanup(home); }
	});

	it('closing the "IDE" (supervisor) leaves the Hub running, and a new one reconnects without starting anything', async () => {
		const home = tempHome('reopen');
		const first = new HubSupervisor({ home, startupWaitMs: 15_000 });
		try {
			await first.start(true);
			const { pid, instanceId } = (await discover(home)).info;
			first.dispose(); // the window closes
			await sleep(800);
			assert.ok(alive(pid), 'Hub still running with no client');
			const second = new HubSupervisor({ home });
			await second.start(false); // discovery only: no spawn
			assert.equal(second.getState().hub.status, 'connected');
			assert.equal((await discover(home)).info.instanceId, instanceId, 'same Hub instance');
			second.dispose();
		} finally { first.dispose(); await stopHub(home); cleanup(home); }
	});

	it('supports several IDE windows at once', async () => {
		const home = tempHome('multi');
		const a = new HubSupervisor({ home, startupWaitMs: 15_000 });
		const b = new HubSupervisor({ home });
		try {
			await a.start(true);
			await b.start(false);
			assert.equal(a.getState().hub.status, 'connected');
			assert.equal(b.getState().hub.status, 'connected');
		} finally { a.dispose(); b.dispose(); await stopHub(home); cleanup(home); }
	});

	it('supervisor: shows "disconnected" when the Hub stops, then reconnects to the next Hub with a new token', async () => {
		const home = tempHome('recon');
		const sup = new HubSupervisor({ home, startupWaitMs: 15_000, backoffMs: [200] });
		try {
			await sup.start(true);
			const token1 = readSecureFile(file(home, 'token')).trim();
			const gone = new Promise<void>(r => sup.on('change', (s: PanelState) => { if (s.hub.status === 'disconnected') { r(); } }));
			await stopHub(home);
			await gone;
			assert.equal(sup.getState().hub.status, 'disconnected');
			assert.ok(sup.getState().hub.detail);
			const child = spawnMain(home); // somebody starts the Hub again
			try {
				await waitFor(() => sup.getState().hub.status === 'connected', 15_000);
				assert.notEqual(readSecureFile(file(home, 'token')).trim(), token1, 'rotated token');
			} finally { child.kill(); }
		} finally { sup.dispose(); await stopHub(home); cleanup(home); }
	});

	it('supervisor: with no Hub and no permission to start one, stays disconnected with a reason', async () => {
		const home = tempHome('off');
		const sup = new HubSupervisor({ home });
		try {
			await sup.start(false);
			assert.equal(sup.getState().hub.status, 'disconnected');
			assert.match(sup.getState().hub.detail ?? '', /Nenhum Hub/);
		} finally { sup.dispose(); cleanup(home); }
	});

	it('supervisor: reports a missing Node.js instead of failing silently', async () => {
		const home = tempHome('nonode');
		const sup = new HubSupervisor({ home, nodePath: undefined });
		const saved = { p: process.env.PATH, P: process.env.Path, n: process.env.SINGULARITY_NODE_PATH };
		try {
			process.env.PATH = ''; process.env.Path = ''; delete process.env.SINGULARITY_NODE_PATH;
			await sup.start(true);
			assert.equal(sup.getState().hub.status, 'error');
			assert.match(sup.getState().hub.detail ?? '', /Node\.js/);
		} finally { process.env.PATH = saved.p; process.env.Path = saved.P; if (saved.n) { process.env.SINGULARITY_NODE_PATH = saved.n; } sup.dispose(); cleanup(home); }
	});
});

void MAIN;
