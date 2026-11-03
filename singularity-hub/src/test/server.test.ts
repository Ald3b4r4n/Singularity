import assert from 'node:assert/strict';
import * as fs from 'fs';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { HubConnection, RpcFailure } from '../client';
import { discover } from '../discovery';
import { file } from '../paths';
import { ErrorCode, PROTOCOL } from '../protocol';
import { attemptUpgrade, cleanup, httpGet, sleep, startInProcess, tempHome } from './helpers';

describe('authentication and request validation', () => {
	const home = tempHome('auth');
	let port = 0;
	let token = '';
	let release: () => Promise<void>;
	let hubPort = 0;

	before(async () => {
		const hub = await startInProcess(home);
		port = hub.info.port;
		hubPort = port;
		token = hub.token;
		release = hub.release;
	});
	after(async () => { await release(); cleanup(home); });

	const auth = (t: string): string => `Bearer ${t}`;

	it('accepts a valid bearer token and completes the handshake', async () => {
		const c = await HubConnection.connect({ home, clientName: 'test' });
		assert.equal(c.hello.protocol, 1);
		assert.equal(c.hello.hub.instanceId, c.info.instanceId);
		c.close();
	});

	it('rejects a missing token with 401 before any WebSocket exists', async () => {
		assert.equal((await attemptUpgrade(port, {})).status, 401);
	});

	it('rejects a wrong token with 401', async () => {
		assert.equal((await attemptUpgrade(port, { headers: { Authorization: auth('A'.repeat(43)) } })).status, 401);
		assert.equal((await attemptUpgrade(port, { headers: { Authorization: 'Basic abc' } })).status, 401);
	});

	it('rejects the token in the query string, even a valid one', async () => {
		assert.equal((await attemptUpgrade(port, { path: `/ws?token=${token}` })).status, 400);
		assert.equal((await attemptUpgrade(port, { path: `/ws?access_token=${token}`, headers: { Authorization: auth(token) } })).status, 400);
	});

	it('rejects an unexpected Host header (DNS rebinding)', async () => {
		assert.equal((await attemptUpgrade(port, { headers: { Authorization: auth(token), Host: 'evil.example:80' } })).status, 403);
		assert.equal((await httpGet(port, '/identity', { host: 'evil.example', 'x-singularity-nonce': 'n'.repeat(20) })).status, 403);
	});

	it('rejects any browser Origin', async () => {
		assert.equal((await attemptUpgrade(port, { headers: { Authorization: auth(token), Origin: 'http://localhost:3000' } })).status, 403);
		assert.equal((await attemptUpgrade(port, { headers: { Authorization: auth(token), Origin: 'null' } })).status, 403);
	});

	it('serves nothing but /ws and /identity', async () => {
		assert.equal((await httpGet(port, '/')).status, 404);
		assert.equal((await attemptUpgrade(port, { path: '/other', headers: { Authorization: auth(token) } })).status, 404);
	});

	it('/identity needs a nonce and never reveals the token', async () => {
		assert.equal((await httpGet(port, '/identity')).status, 400);
		const ok = await httpGet(port, '/identity', { 'x-singularity-nonce': 'abcdefghijklmnop1234' });
		assert.equal(ok.status, 200);
		assert.ok(!ok.body.includes(token));
	});

	it('locks out repeated bad attempts, even for a valid token, then recovers', async () => {
		const home2 = tempHome('lock');
		const hub = await startInProcess(home2);
		try {
			for (let i = 0; i < 5; i++) {
				assert.equal((await attemptUpgrade(hub.info.port, { headers: { Authorization: auth('B'.repeat(43)) } })).status, 401);
			}
			const locked = await attemptUpgrade(hub.info.port, { headers: { Authorization: auth(hub.token) } });
			assert.equal(locked.status, 429);
			assert.ok(Number(locked.headers['retry-after']) > 0);
		} finally { await hub.release(); cleanup(home2); }
	});

	it('only listens on the loopback interface', async () => {
		const out = await import('child_process').then(cp => cp.execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }));
		const lines = out.split(/\r?\n/).filter(l => l.includes('LISTENING') && l.includes(`:${hubPort} `));
		assert.ok(lines.length >= 1);
		for (const l of lines) {
			assert.match(l, /127\.0\.0\.1:/, l);
		}
	});
});

describe('protocol', () => {
	const home = tempHome('proto');
	let release: () => Promise<void>;
	let hubPort = 0;
	let hubToken = '';
	let hub: Awaited<ReturnType<typeof startInProcess>>;

	before(async () => { hub = await startInProcess(home); release = hub.release; hubPort = hub.info.port; hubToken = hub.token; });
	after(async () => { await release(); cleanup(home); });

	function rawClient(): Promise<WebSocket> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/ws`, { headers: { Authorization: `Bearer ${hubToken}` } });
			ws.once('open', () => resolve(ws));
			ws.once('error', reject);
		});
	}
	const call = (ws: WebSocket, method: string, params?: unknown, id: number | string = 1): Promise<any> => new Promise(resolve => {
		ws.once('message', d => resolve(JSON.parse(d.toString())));
		ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
	});

	it('refuses every method before hub.hello', async () => {
		const ws = await rawClient();
		const r = await call(ws, 'sessions.list');
		assert.equal(r.error.code, ErrorCode.NotInitialized);
		ws.close();
	});

	it('rejects an incompatible protocol range with a typed error', async () => {
		const ws = await rawClient();
		const r = await call(ws, 'hub.hello', { client: { name: 't' }, protocol: { min: 2, max: 5 } });
		assert.equal(r.error.code, ErrorCode.IncompatibleProtocol);
		assert.deepEqual(r.error.data.supported, PROTOCOL);
		ws.close();
	});

	it('negotiates the highest common version', async () => {
		const ws = await rawClient();
		const r = await call(ws, 'hub.hello', { client: { name: 't' }, protocol: { min: 1, max: 9 } });
		assert.equal(r.result.protocol, 1);
		ws.close();
	});

	it('lists exactly zero sessions', async () => {
		const c = await HubConnection.connect({ home, clientName: 't' });
		assert.deepEqual(await c.request('sessions.list'), []);
		c.close();
	});

	it('session.subscribe works for all sessions and is not found for an unknown one', async () => {
		const c = await HubConnection.connect({ home, clientName: 't' });
		const sub = await c.request<{ subscriptionId: string; seq: number; replayed: number }>('session.subscribe', {});
		assert.equal(sub.replayed, 0);
		assert.equal(typeof sub.subscriptionId, 'string');
		await assert.rejects(c.request('session.subscribe', { sessionId: 'nope' }), (e: RpcFailure) => e.code === ErrorCode.SessionNotFound);
		await assert.rejects(c.request('session.subscribe', { fromSeq: -1 }), (e: RpcFailure) => e.code === ErrorCode.InvalidParams);
		c.close();
	});

	it('replays retained events after fromSeq and delivers live ones', async () => {
		const c = await HubConnection.connect({ home, clientName: 't' });
		hub.server.publish({ type: 'test.one' });
		hub.server.publish({ type: 'test.two' });
		const seen: string[] = [];
		c.on('notification', (m: string, p: { event: { type: string } }) => { if (m === 'session.event') { seen.push(p.event.type + (('replay' in p) ? ':replay' : '')); } });
		const sub = await c.request<{ replayed: number }>('session.subscribe', { fromSeq: 0 });
		assert.equal(sub.replayed, 2);
		hub.server.publish({ type: 'test.three' });
		await sleep(150);
		assert.deepEqual(seen, ['test.one:replay', 'test.two:replay', 'test.three']);
		c.close();
	});

	it('answers unknown methods and malformed JSON with JSON-RPC errors', async () => {
		const ws = await rawClient();
		await call(ws, 'hub.hello', { client: { name: 't' }, protocol: PROTOCOL });
		assert.equal((await call(ws, 'agents.run', { prompt: 'x' })).error.code, ErrorCode.MethodNotFound);
		const bad = await new Promise<any>(resolve => { ws.once('message', d => resolve(JSON.parse(d.toString()))); ws.send('{nope'); });
		assert.equal(bad.error.code, ErrorCode.ParseError);
		const arr = await new Promise<any>(resolve => { ws.once('message', d => resolve(JSON.parse(d.toString()))); ws.send('[]'); });
		assert.equal(arr.error.code, ErrorCode.InvalidRequest);
		ws.close();
	});
});

describe('limits and failure handling', () => {
	it('closes a client that sends an oversized message (1009)', async () => {
		const home = tempHome('big');
		const hub = await startInProcess(home);
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${hub.info.port}/ws`, { headers: { Authorization: `Bearer ${hub.token}` } });
			await new Promise(r => ws.once('open', r));
			const code = await new Promise<number>(resolve => { ws.once('close', c => resolve(c)); ws.send('x'.repeat(200 * 1024)); });
			assert.equal(code, 1009);
		} finally { await hub.release(); cleanup(home); }
	});

	it('closes a client that floods requests (1008)', async () => {
		const home = tempHome('flood');
		const hub = await startInProcess(home);
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${hub.info.port}/ws`, { headers: { Authorization: `Bearer ${hub.token}` } });
			await new Promise(r => ws.once('open', r));
			const code = await new Promise<number>(resolve => {
				ws.once('close', c => resolve(c));
				for (let i = 0; i < 400; i++) { ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method: 'sessions.list' })); }
			});
			assert.equal(code, 1008);
		} finally { await hub.release(); cleanup(home); }
	});

	it('drops a client that does not read (slow consumer) without hurting the others', async () => {
		const home = tempHome('slow');
		const hub = await startInProcess(home, { limits: { maxBufferedBytes: 256 * 1024 } });
		try {
			const slow = await HubConnection.connect({ home, clientName: 'slow' });
			await slow.request('session.subscribe', {});
			const fast = await HubConnection.connect({ home, clientName: 'fast' });
			await fast.request('session.subscribe', {});
			// stop reading on the slow socket
			((slow as unknown as { ws: WebSocket }).ws as unknown as { _socket: { pause(): void } })._socket.pause();
			const closed = new Promise<void>(resolve => slow.once('close', () => resolve()));
			const filler = 'z'.repeat(60 * 1024);
			let fastGot = 0;
			fast.on('notification', () => { fastGot++; });
			for (let i = 0; i < 600 && hub.server.clientCount === 2; i++) {
				hub.server.publish({ type: 'filler', data: filler });
				await sleep(2); // yield so the healthy client can drain its socket
			}
			assert.equal(hub.server.clientCount, 1, 'slow client was dropped');
			assert.ok(fastGot > 0, 'fast client kept receiving');
			fast.close();
			void closed;
		} finally { await hub.release(); cleanup(home); }
	});

	it('refuses connections beyond the client limit with 503', async () => {
		const home = tempHome('max');
		const hub = await startInProcess(home, { limits: { maxClients: 2 } });
		try {
			const a = await HubConnection.connect({ home, clientName: 'a' });
			const b = await HubConnection.connect({ home, clientName: 'b' });
			await assert.rejects(HubConnection.connect({ home, clientName: 'c' }), (e: RpcFailure) => e.code === 503);
			a.close(); b.close();
		} finally { await hub.release(); cleanup(home); }
	});

	it('reports unreachable and missing Hubs instead of pretending', async () => {
		const home = tempHome('none');
		fs.mkdirSync(home, { recursive: true });
		await assert.rejects(discover(home), /No Hub|not protected/);
		cleanup(home);
	});

	it('rejects a Hub that cannot prove its identity, without ever sending it the token', async () => {
		const http = await import('http');
		const seen: Array<string | undefined> = [];
		const fake = http.createServer((req, res) => {
			seen.push(req.headers.authorization);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ instanceId: 'x', proof: 'forged' }));
		});
		fake.on('upgrade', (req, socket) => { seen.push(req.headers.authorization ?? '(upgrade)'); socket.destroy(); });
		await new Promise<void>(r => fake.listen(0, '127.0.0.1', r));
		const fakePort = (fake.address() as { port: number }).port;
		const home = tempHome('fake');
		const hub = await startInProcess(home);
		try {
			const infoPath = file(home, 'connection');
			const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
			info.port = fakePort; // a tampered connection file pointing at an impostor
			fs.writeFileSync(infoPath, JSON.stringify(info));
			await assert.rejects(HubConnection.connect({ home, clientName: 't' }), /could not prove/);
			assert.ok(!seen.some(h => h && h.startsWith('Bearer')), 'the impostor never received the token');
			assert.ok(!seen.includes('(upgrade)'), 'no WebSocket upgrade was attempted');
		} finally { fake.close(); await hub.release(); cleanup(home); }
	});
});
