import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { HubBridge } from '../remote/bridge';
import { RemoteGateway } from '../remote/gateway';
import { Pairing } from '../remote/pairing';
import { fingerprintOf, hostAllowed, newPairingCode, normalizeCode, originAllowed } from '../remote/security';
import { RemoteStore } from '../remote/store';
import { disableServe, enableServe, Runner, tailscaleState } from '../remote/tailscale';

// ---------- a Hub that records what the gateway asks of it ----------
class FakeBridge extends EventEmitter {
	connected = true;
	instanceId = 'fake-hub';
	calls: Array<{ method: string; params: unknown }> = [];
	list: unknown[] = [];
	events: Array<{ seq: number; type: string; sessionId?: string; data?: unknown }> = [];
	start(): void { /* the fake is already connected */ }
	close(): void { /* nothing to close */ }
	eventsAfter(seq: number): Array<{ seq: number; type: string; sessionId?: string; data?: unknown }> { return this.events.filter(event => event.seq > seq); }
	async sessions(): Promise<unknown[]> { return this.list; }
	async call(method: string, params?: unknown): Promise<unknown> {
		this.calls.push({ method, params });
		if (method === 'catalog.get') { return { services: [{ id: 'opencode', name: 'OpenCode', status: 'available' }], service: 'opencode', providers: [] }; }
		if (method === 'comparisons.list') { return [{ id: 'cmp-12345', workspace: 'SECRET-PATH', prompt: 'p', createdAt: 1, participants: [{ id: 'part-1', service: 'opencode', status: 'done', workspace: 'SECRET-WORKTREE' }] }]; }
		if (method === 'teams.list') { return [{ id: 'team-12345', workspace: 'SECRET-PATH', state: 'running', phase: 'reviewer', command: { executable: 'x', args: [] }, steps: [] }]; }
		if (method === 'comparisons.inspect') { return { files: 'M a.txt', diff: '--- a\n+++ b\n', worktreePath: 'SECRET-WORKTREE' }; }
		if (method === 'session.create') { return { id: '11111111-1111-4111-8111-111111111111', harness: 'opencode', status: 'idle', workspace: (params as { workspace: string }).workspace }; }
		return { accepted: true, interrupted: true };
	}
}

const SESSION = '11111111-1111-4111-8111-111111111111';
let root: string;
let workspace: string;
let outside: string;
let gateway: RemoteGateway;
let bridge: FakeBridge;
let base: string;
let admin: string;
let adminToken: string;

async function http(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; raw?: boolean } = {}): Promise<{ status: number; json: any; text: string }> {
	const response = await fetch(url, { method: init.method ?? 'GET', headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
	const text = await response.text();
	let json: any;
	try { json = JSON.parse(text); } catch { json = undefined; }
	return { status: response.status, json, text };
}
const adminCall = (route: string, body?: unknown) => http(admin + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-admin-token': adminToken }, body });

async function pair(name = 'POCO X8 Pro'): Promise<string> {
	const started = await adminCall('/admin/pairing/start', {});
	const claim = await http(base + '/api/pair/claim', { method: 'POST', body: { code: started.json.code, deviceName: name } });
	assert.equal(claim.status, 200);
	const pending = (await adminCall('/admin/state')).json.pending;
	assert.equal(pending.length, 1);
	assert.equal(pending[0].fingerprint, claim.json.fingerprint, 'the computer shows the same fingerprint as the phone');
	assert.equal((await adminCall('/admin/pairing/decide', { id: pending[0].id, approve: true })).json.ok, true);
	const done = await http(base + '/api/pair/poll', { method: 'POST', body: { claimId: claim.json.claimId, claimSecret: claim.json.claimSecret } });
	assert.equal(done.json.status, 'approved');
	return done.json.token;
}
const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

before(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-remote-'));
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-remote-ws-'));
	outside = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-remote-out-'));
	bridge = new FakeBridge();
	gateway = new RemoteGateway({ directory: path.join(root, 'remote'), webDir: path.join(__dirname, '..', '..', 'web'), bridge: bridge as unknown as HubBridge });
	await gateway.start();
	base = `http://127.0.0.1:${gateway.publicPort}`;
	admin = `http://127.0.0.1:${gateway.adminPort}`;
	adminToken = fs.readFileSync(path.join(root, 'remote', 'admin.token'), 'utf8');
	await adminCall('/admin/workspaces/add', { path: workspace });
});
after(async () => {
	await gateway.stop();
	for (const dir of [root, workspace, outside]) { fs.rmSync(dir, { recursive: true, force: true }); }
});

describe('remote access is off by default and private when on', () => {
	it('a gateway that was never started leaves no trace and no listener', () => {
		const idle = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-remote-idle-'));
		try {
			const store = new RemoteStore(path.join(idle, 'remote'));
			assert.deepEqual(store.devices(), []);
			assert.deepEqual(store.workspaces(), []);
			assert.equal(fs.existsSync(path.join(idle, 'remote', 'gateway.json')), false);
		} finally { fs.rmSync(idle, { recursive: true, force: true }); }
	});

	it('listens on the loopback interface only, on both ports', async () => {
		const connects = (host: string, port: number): Promise<boolean> => new Promise(resolve => {
			const socket = net.connect({ host, port, timeout: 1500 });
			socket.once('connect', () => { socket.destroy(); resolve(true); });
			socket.once('timeout', () => { socket.destroy(); resolve(false); });
			socket.once('error', () => resolve(false));
		});
		for (const port of [gateway.publicPort, gateway.adminPort]) {
			assert.equal(await connects('127.0.0.1', port), true);
			const others = Object.values(os.networkInterfaces()).flatMap(list => list ?? []).filter(item => item.family === 'IPv4' && !item.internal).map(item => item.address);
			for (const address of others) { assert.equal(await connects(address, port), false, `port ${port} must not answer on ${address}`); }
		}
	});

	it('refuses other Host names (DNS rebinding) and cross-site origins', async () => {
		const wrongHost = await new Promise<number>(resolve => {
			const req = require('node:http').request({ host: '127.0.0.1', port: gateway.publicPort, path: '/api/status', headers: { host: 'evil.example' } }, (res: import('node:http').IncomingMessage) => { res.resume(); resolve(res.statusCode ?? 0); });
			req.end();
		});
		assert.equal(wrongHost, 403);
		assert.equal((await http(base + '/api/status', { headers: { origin: 'https://evil.example' } })).status, 403);
		assert.equal(hostAllowed('127.0.0.1:5', 5, []), true);
		assert.equal(hostAllowed('pc.tailnet.ts.net', 5, ['pc.tailnet.ts.net']), true);
		assert.equal(hostAllowed('pc.tailnet.ts.net', 5, []), false);
		assert.equal(hostAllowed('127.0.0.1:6', 5, []), false);
		assert.equal(originAllowed('https://a.example', 'a.example'), true);
		assert.equal(originAllowed('https://b.example', 'a.example'), false);
	});

	it('serves the client with a strict content security policy and no third-party origin', async () => {
		const page = await fetch(base + '/');
		assert.equal(page.status, 200);
		const csp = page.headers.get('content-security-policy') ?? '';
		assert.match(csp, /default-src 'none'/);
		assert.doesNotMatch(csp, /https?:\/\//);
		assert.match(csp, /frame-ancestors 'none'/);
		const html = await page.text();
		assert.doesNotMatch(html, /https?:\/\/(?!localhost)/, 'the page loads nothing from outside');
		assert.equal((await fetch(base + '/../package.json')).status, 404);
		assert.equal((await http(base + '/server.js')).status, 404);
	});
});

describe('pairing', () => {
	it('pairs a device only after the computer approves, and hands the token over once', async () => {
		const started = await adminCall('/admin/pairing/start', {});
		const claim = await http(base + '/api/pair/claim', { method: 'POST', body: { code: started.json.code, deviceName: 'POCO' } });
		const before = await http(base + '/api/pair/poll', { method: 'POST', body: { claimId: claim.json.claimId, claimSecret: claim.json.claimSecret } });
		assert.equal(before.json.status, 'pending');
		assert.equal((await http(base + '/api/status')).status, 401, 'no token yet');
		const pending = (await adminCall('/admin/state')).json.pending;
		await adminCall('/admin/pairing/decide', { id: pending[0].id, approve: true });
		const approved = await http(base + '/api/pair/poll', { method: 'POST', body: { claimId: claim.json.claimId, claimSecret: claim.json.claimSecret } });
		assert.equal(approved.json.status, 'approved');
		assert.match(approved.json.token, /^[A-Za-z0-9_-]{40,}$/);
		const again = await http(base + '/api/pair/poll', { method: 'POST', body: { claimId: claim.json.claimId, claimSecret: claim.json.claimSecret } });
		assert.equal(again.json.status, 'expired', 'the token cannot be collected twice');
		assert.equal((await http(base + '/api/status', { headers: auth(approved.json.token) })).status, 200);
	});

	it('a denied pairing never produces a token', async () => {
		const started = await adminCall('/admin/pairing/start', {});
		const claim = await http(base + '/api/pair/claim', { method: 'POST', body: { code: started.json.code, deviceName: 'Intruso' } });
		const pending = (await adminCall('/admin/state')).json.pending;
		await adminCall('/admin/pairing/decide', { id: pending[0].id, approve: false });
		const result = await http(base + '/api/pair/poll', { method: 'POST', body: { claimId: claim.json.claimId, claimSecret: claim.json.claimSecret } });
		assert.equal(result.json.status, 'denied');
		assert.equal(result.json.token, undefined);
	});

	it('a code works once, and a wrong or reused code is refused', async () => {
		const started = await adminCall('/admin/pairing/start', {});
		const first = await http(base + '/api/pair/claim', { method: 'POST', body: { code: started.json.code, deviceName: 'A' } });
		assert.equal(first.status, 200);
		assert.equal((await http(base + '/api/pair/claim', { method: 'POST', body: { code: started.json.code, deviceName: 'B' } })).status, 403);
		const pending = (await adminCall('/admin/state')).json.pending;
		await adminCall('/admin/pairing/decide', { id: pending[0].id, approve: false });
	});

	it('an expired code is refused', () => {
		let now = 1_000_000;
		const pairing = new Pairing(() => ({ token: 't' }), () => now);
		const { code } = pairing.start();
		now += 2 * 60 * 1000 + 1;
		assert.equal(pairing.claim(code, 'late'), undefined);
		assert.equal(pairing.active(), undefined);
	});

	it('a claim that is not approved in time expires with its secret', () => {
		let now = 1_000_000;
		const pairing = new Pairing(() => ({ token: 'secret-token' }), () => now);
		const { code } = pairing.start();
		const claim = pairing.claim(code, 'phone')!;
		now += 3 * 60 * 1000 + 1;
		assert.equal(pairing.decide(claim.id, true), false);
		assert.equal(pairing.poll(claim.id, claim.secret).status, 'expired');
	});

	it('only the phone that holds the claim secret can collect the token', () => {
		const pairing = new Pairing(() => ({ token: 'secret-token' }));
		const { code } = pairing.start();
		const claim = pairing.claim(code, 'phone')!;
		pairing.decide(claim.id, true);
		assert.equal(pairing.poll(claim.id, 'x'.repeat(43)).status, 'expired');
		assert.equal(pairing.poll(claim.id, claim.secret).token, 'secret-token');
	});

	it('codes avoid look-alike characters and normalise what a person types', () => {
		for (let i = 0; i < 200; i++) { assert.match(newPairingCode(), /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/); }
		assert.equal(normalizeCode('abcd efgh'), 'ABCD-EFGH');
		assert.equal(normalizeCode('0OIL-1111'), undefined);
		assert.equal(normalizeCode(5), undefined);
		assert.match(fingerprintOf('x'), /^[0-9A-F]{4}-[0-9A-F]{4}$/);
	});
});

describe('the phone-facing API', () => {
	let token: string;
	before(async () => {
		// the lockout test above applies to pairing only; give it time to be irrelevant by pairing through a fresh gateway state
		await new Promise(resolve => setTimeout(resolve, 100));
	});

	it('refuses every route without a valid device token', async () => {
		for (const route of ['/api/status', '/api/sessions', '/api/comparisons', '/api/teams', '/api/events', '/api/catalog']) {
			assert.equal((await http(base + route)).status, 401, route);
			if (route === '/api/status' || route === '/api/sessions') { assert.equal((await http(base + route, { headers: auth('A'.repeat(43)) })).status, 401, route + ' with a made-up token'); }
		}
	});

	it('pairing, listing, prompting, interrupting and revoking work end to end', { timeout: 120000 }, async () => {
		// a fresh gateway so the earlier lockout does not apply
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-remote-e2e-'));
		const bridge2 = new FakeBridge();
		const gw = new RemoteGateway({ directory: path.join(dir, 'remote'), webDir: path.join(__dirname, '..', '..', 'web'), bridge: bridge2 as unknown as HubBridge });
		await gw.start();
		const url = `http://127.0.0.1:${gw.publicPort}`;
		const adm = `http://127.0.0.1:${gw.adminPort}`;
		const adminHeaders = { 'x-admin-token': fs.readFileSync(path.join(dir, 'remote', 'admin.token'), 'utf8') };
		try {
			const added = await http(adm + '/admin/workspaces/add', { method: 'POST', headers: adminHeaders, body: { path: workspace } });
			const workspaceId = added.json.workspace.id;
			const started = await http(adm + '/admin/pairing/start', { method: 'POST', headers: adminHeaders, body: {} });
			const claim = await http(url + '/api/pair/claim', { method: 'POST', body: { code: started.json.code.toLowerCase().replace('-', ' '), deviceName: 'POCO X8 Pro' } });
			const pending = (await http(adm + '/admin/state', { headers: adminHeaders })).json.pending;
			await http(adm + '/admin/pairing/decide', { method: 'POST', headers: adminHeaders, body: { id: pending[0].id, approve: true } });
			token = (await http(url + '/api/pair/poll', { method: 'POST', body: { claimId: claim.json.claimId, claimSecret: claim.json.claimSecret } })).json.token;
			const headers = auth(token);

			bridge2.list = [
				{ id: SESSION, harness: 'opencode', status: 'running', workspace: fs.realpathSync.native(workspace), result: 'partial', model: { providerID: 'p', modelID: 'm' }, secretField: 'must-not-leak' },
				{ id: '22222222-2222-4222-8222-222222222222', harness: 'opencode', status: 'idle', workspace: fs.realpathSync.native(outside) }
			];
			const status = await http(url + '/api/status', { headers });
			assert.equal(status.json.hub.connected, true);
			assert.deepEqual(status.json.workspaces.map((w: { name: string }) => w.name), [path.basename(fs.realpathSync.native(workspace))]);
			assert.doesNotMatch(status.text, new RegExp(workspace.replace(/\\/g, '\\\\').replace(/[.*+?^${}()|[\]]/g, '\\$&')), 'workspace paths are not sent to the phone');

			const sessions = await http(url + '/api/sessions', { headers });
			assert.equal(sessions.json.sessions.length, 1, 'a session of a workspace that was not authorized is invisible');
			assert.equal(sessions.json.sessions[0].id, SESSION);
			assert.equal(sessions.json.sessions[0].secretField, undefined, 'only allow-listed fields travel');

			// starting a session needs the explicit confirmation and an authorized workspace
			const body = { workspaceId, service: 'opencode', model: { providerID: 'p', modelID: 'm' } };
			assert.equal((await http(url + '/api/sessions', { method: 'POST', headers, body })).status, 400, 'no confirmation, no session');
			assert.equal((await http(url + '/api/sessions', { method: 'POST', headers, body: { ...body, confirm: true, workspaceId: 'forged' } })).status, 403);
			assert.equal((await http(url + '/api/sessions', { method: 'POST', headers, body: { ...body, confirm: true, service: 'bash' } })).status, 400);
			assert.equal((await http(url + '/api/sessions', { method: 'POST', headers, body: { ...body, confirm: true } })).status, 201);
			assert.equal(bridge2.calls.filter(c => c.method === 'session.create').length, 1);

			// prompting: confirmation and a request id are mandatory, and a retry never sends the prompt twice
			const prompt = (extra: Record<string, string> = {}, text = 'faça isso') => http(`${url}/api/sessions/${SESSION}/prompt`, { method: 'POST', headers: { ...headers, ...extra }, body: { text, confirm: true } });
			assert.equal((await prompt()).status, 400, 'no request id');
			assert.equal((await http(`${url}/api/sessions/${SESSION}/prompt`, { method: 'POST', headers: { ...headers, 'x-request-id': 'req-00000001' }, body: { text: 'x' } })).status, 400, 'no confirmation');
			assert.equal((await prompt({ 'x-request-id': 'req-00000001' })).status, 200);
			const retry = await prompt({ 'x-request-id': 'req-00000001' });
			assert.equal(retry.status, 200);
			assert.equal(retry.json.duplicate, true);
			assert.equal(bridge2.calls.filter(c => c.method === 'session.prompt').length, 1, 'the retry did not reach the agent');
			assert.equal((await http(`${url}/api/sessions/22222222-2222-4222-8222-222222222222/prompt`, { method: 'POST', headers: { ...headers, 'x-request-id': 'req-00000002' }, body: { text: 'x', confirm: true } })).status, 404, 'a session outside the authorized workspaces');

			assert.equal((await http(`${url}/api/sessions/${SESSION}/interrupt`, { method: 'POST', headers, body: { confirm: true } })).status, 200);
			assert.equal(bridge2.calls.filter(c => c.method === 'session.interrupt').length, 1);

			// read-only views never carry paths, commands or worktrees
			const comparisons = await http(url + '/api/comparisons', { headers });
			assert.equal(comparisons.json.comparisons.length, 1);
			assert.doesNotMatch(comparisons.text, /SECRET/);
			const teams = await http(url + '/api/teams', { headers });
			assert.doesNotMatch(teams.text, /SECRET|executable/);
			const diff = await http(`${url}/api/comparisons/cmp-12345/part-1/diff?workspaceId=${workspaceId}`, { headers });
			assert.match(diff.json.diff, /\+\+\+ b/);
			assert.doesNotMatch(diff.text, /SECRET/);

			// the allow-list: nothing else exists
			for (const [method, route] of [['POST', '/api/rpc'], ['GET', '/api/shell'], ['POST', '/api/hub/hub.shutdown'], ['GET', '/api/files'], ['DELETE', '/api/sessions'], ['POST', '/api/teams/apply'], ['POST', '/api/solutions/apply']] as const) {
				assert.equal((await http(url + route, { method, headers, body: method === 'POST' ? {} : undefined })).status, 404, `${method} ${route}`);
			}
			assert.equal(bridge2.calls.some(c => /shutdown|solutions\.apply|solutions\.undo|teams\.start|session\.stop|session\.deleteHistory/.test(c.method)), false);

			// the token is stored only as a hash
			const state = fs.readFileSync(path.join(dir, 'remote', 'remote-state.json'), 'utf8');
			assert.doesNotMatch(state, new RegExp(token));

			// revocation takes effect immediately
			const own = (await http(url + '/api/device', { headers })).json;
			assert.equal((await http(adm + '/admin/devices/revoke', { method: 'POST', headers: adminHeaders, body: { id: own.id } })).json.ok, true);
			assert.equal((await http(url + '/api/status', { headers })).status, 401);
		} finally {
			await gw.stop();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('streams events for authorized sessions only and replays what a reconnecting phone missed', { timeout: 60000 }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-remote-sse-'));
		const b = new FakeBridge();
		b.list = [{ id: SESSION, harness: 'opencode', status: 'running', workspace: fs.realpathSync.native(workspace) }];
		b.events = [{ seq: 1, type: 'claude.event', sessionId: SESSION, data: { name: 'session.started' } }, { seq: 2, type: 'opencode.event', sessionId: 'unknown-session', data: { name: 'leak' } }, { seq: 3, type: 'codex.event', sessionId: SESSION, data: { name: 'session.completed' } }];
		const gw = new RemoteGateway({ directory: path.join(dir, 'remote'), webDir: path.join(__dirname, '..', '..', 'web'), bridge: b as unknown as HubBridge });
		await gw.start();
		const adm = `http://127.0.0.1:${gw.adminPort}`;
		const adminHeaders = { 'x-admin-token': fs.readFileSync(path.join(dir, 'remote', 'admin.token'), 'utf8') };
		try {
			await http(adm + '/admin/workspaces/add', { method: 'POST', headers: adminHeaders, body: { path: workspace } });
			const t = gw.store.authorize('sse').token;
			const url = `http://127.0.0.1:${gw.publicPort}`;
			const controller = new AbortController();
			const response = await fetch(url + '/api/events?after=1', { headers: auth(t), signal: controller.signal });
			assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
			const reader = response.body!.getReader();
			let text = '';
			const decoder = new TextDecoder();
			for (let i = 0; i < 10 && !text.includes('"seq":3'); i++) { const { value } = await reader.read(); text += decoder.decode(value); }
			assert.match(text, /"seq":3/);
			assert.doesNotMatch(text, /"seq":1[,}]/, 'events up to the phone\'s last seq are not replayed');
			assert.doesNotMatch(text, /leak|unknown-session/, 'events of unauthorized sessions are dropped');
			// a live event arrives too
			b.emit('event', { seq: 4, type: 'claude.event', sessionId: SESSION, data: { name: 'session.text.delta' } });
			for (let i = 0; i < 10 && !text.includes('"seq":4'); i++) { const { value } = await reader.read(); text += decoder.decode(value); }
			assert.match(text, /session\.text\.delta/);
			controller.abort();
		} finally {
			await gw.stop();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('brute force', () => {
	it('locks pairing after repeated wrong codes, even for the right code, without affecting paired devices', { timeout: 60000 }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-remote-lock-'));
		const gw = new RemoteGateway({ directory: path.join(dir, 'remote'), webDir: path.join(__dirname, '..', '..', 'web'), bridge: new FakeBridge() as unknown as HubBridge });
		await gw.start();
		try {
			const url = `http://127.0.0.1:${gw.publicPort}`;
			const adminHeaders = { 'x-admin-token': fs.readFileSync(path.join(dir, 'remote', 'admin.token'), 'utf8') };
			const paired = gw.store.authorize('already paired').token;
			const started = await http(`http://127.0.0.1:${gw.adminPort}/admin/pairing/start`, { method: 'POST', headers: adminHeaders, body: {} });
			let last = 0;
			for (let i = 0; i < 7; i++) { last = (await http(url + '/api/pair/claim', { method: 'POST', body: { code: 'ZZZZ-ZZZZ', deviceName: 'guess' } })).status; }
			assert.equal(last, 429);
			assert.equal((await http(url + '/api/pair/claim', { method: 'POST', body: { code: started.json.code, deviceName: 'locked-out' } })).status, 429);
			for (let i = 0; i < 15; i++) { await http(url + '/api/status', { headers: auth('B'.repeat(43)) }); }
			assert.equal((await http(url + '/api/status', { headers: auth('B'.repeat(43)) })).status, 429, 'wrong tokens are throttled');
			assert.equal((await http(url + '/api/device', { headers: auth(paired) })).status, 200, 'a valid device is not locked out');
		} finally { await gw.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
	});
});

describe('the admin surface', () => {
	it('needs the secret, refuses browsers and unknown hosts', async () => {
		assert.equal((await http(admin + '/admin/state')).status, 401);
		assert.equal((await http(admin + '/admin/state', { headers: { 'x-admin-token': 'wrong' } })).status, 401);
		assert.equal((await http(admin + '/admin/state', { headers: { 'x-admin-token': adminToken, origin: 'https://evil.example' } })).status, 403);
		assert.equal((await http(base + '/admin/state', { headers: { 'x-admin-token': adminToken } })).status, 404, 'the admin routes do not exist on the phone-facing port');
	});

	it('is invisible to a phone token', async () => {
		const token = await pair('admin-probe');
		assert.equal((await http(admin + '/admin/state', { headers: auth(token) })).status, 401);
	});

	it('does not offer a workspace that does not exist', async () => {
		assert.equal((await adminCall('/admin/workspaces/add', { path: path.join(os.tmpdir(), 'singularity-no-such-folder-' + Date.now()) })).status, 500);
	});
});

describe('Tailscale Serve (optional, private, never public)', () => {
	const log: string[][] = [];
	const runner = (state: object, code = 0): Runner => async (_exe, args) => { log.push(args); return { code, stdout: JSON.stringify(state) }; };
	const env = (): NodeJS.ProcessEnv => ({ SINGULARITY_TAILSCALE: process.execPath });

	it('explains how to proceed when Tailscale is not installed, and installs nothing', async () => {
		const state = await tailscaleState({ SINGULARITY_TAILSCALE: path.join(os.tmpdir(), 'no-such-tailscale.exe') });
		assert.equal(state.installed, false);
		assert.match(state.reason ?? '', /tailscale\.com\/download/);
	});

	it('reads the private name only when it is connected to an account', async () => {
		assert.deepEqual(await tailscaleState(env(), runner({ BackendState: 'Running', Self: { DNSName: 'Pc.Tailnet.TS.net.' } })), { installed: true, loggedIn: true, dnsName: 'pc.tailnet.ts.net' });
		const out = await tailscaleState(env(), runner({ BackendState: 'NeedsLogin' }));
		assert.equal(out.loggedIn, false);
		assert.equal(out.dnsName, undefined);
	});

	it('only ever runs serve to the tailnet: no funnel, no other command', async () => {
		log.length = 0;
		await enableServe(5555, env(), runner({}));
		await disableServe(env(), runner({}));
		await tailscaleState(env(), runner({ BackendState: 'Running' }));
		assert.deepEqual(log[0], ['serve', '--bg', '--https=443', 'http://127.0.0.1:5555']);
		assert.deepEqual(log[1], ['serve', '--https=443', 'off']);
		assert.deepEqual(log[2], ['status', '--json']);
		assert.equal(log.flat().some(arg => /funnel/i.test(arg)), false);
		assert.equal((await enableServe(80, env(), runner({}))).ok, false, 'a privileged port is refused');
	});

	it('needs explicit consent through the admin API before touching the network configuration', async () => {
		const response = await adminCall('/admin/tailscale/serve', { consent: false });
		assert.equal(response.status, 400);
	});
});

describe('store', () => {
	it('keeps only token hashes, expires idle devices, and limits how many devices can be paired', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-remote-store-'));
		try {
			const store = new RemoteStore(path.join(dir, 'remote'));
			const { token, device } = store.authorize('A');
			assert.equal(store.identify(token)?.id, device.id);
			assert.equal(store.identify(token + 'x'), undefined);
			assert.doesNotMatch(fs.readFileSync(path.join(dir, 'remote', 'remote-state.json'), 'utf8'), new RegExp(token));
			assert.equal(new RemoteStore(path.join(dir, 'remote')).identify(token)?.id, device.id, 'survives a restart');
			store.revoke(device.id);
			assert.equal(store.identify(token), undefined);
			for (let i = 0; i < 8; i++) { store.authorize('d' + i); }
			assert.throws(() => store.authorize('one too many'), /Limite/);
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});
});

describe('bridge', () => {
	it('refuses any Hub method that is not on the list', async () => {
		const real = new HubBridge(path.join(root, 'no-hub'));
		for (const method of ['hub.shutdown', 'session.stop', 'solutions.apply', 'teams.start', 'providers.install', 'session.deleteHistory']) {
			await assert.rejects(real.call(method as never), /não permitido/i, method);
		}
		real.close();
	});
});
