import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { HubBridge, BridgeUnavailable } from '../remote/bridge';
import { RemoteGateway } from '../remote/gateway';
import { LedgerError, RequestLedger } from '../remote/ledger';

const SESSION = '11111111-1111-4111-8111-111111111111';
const tmp = (name: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `singularity-${name}-`));

describe('request ledger (persistent idempotency)', () => {
	it('binds an id to the instruction and the session, never keeps the text, and refuses another payload under the same id', () => {
		const dir = tmp('ledger');
		const ledger = new RequestLedger(dir); ledger.open();
		const first = ledger.begin('dev1', SESSION, 'req-00000001', 'escreva um poema secreto');
		assert.equal(first.kind, 'dispatch');
		ledger.confirm((first as unknown as { record: any }).record);
		assert.equal(ledger.begin('dev1', SESSION, 'req-00000001', 'escreva um poema secreto').kind, 'duplicate');
		assert.equal(ledger.begin('dev1', SESSION, 'req-00000001', 'outra instrução').kind, 'conflict');
		assert.equal(ledger.begin('dev1', '22222222-2222-4222-8222-222222222222', 'req-00000001', 'escreva um poema secreto').kind, 'dispatch', 'another session is another operation');
		assert.equal(ledger.begin('dev2', SESSION, 'req-00000001', 'escreva um poema secreto').kind, 'dispatch', 'another device is another operation');
		const onDisk = fs.readFileSync(path.join(dir, 'requests.json'), 'utf8');
		assert.doesNotMatch(onDisk, /poema|secreto/, 'the prompt is not stored');
		ledger.close();
	});

	it('writes "processing" to disk before anything is dispatched, and a restart turns it into unknown, never into a resend', () => {
		const dir = tmp('ledger');
		const one = new RequestLedger(dir); one.open();
		const decision = one.begin('dev1', SESSION, 'req-00000002', 'tarefa longa');
		assert.equal(decision.kind, 'dispatch');
		assert.match(fs.readFileSync(path.join(dir, 'requests.json'), 'utf8'), /"state":"processing"/, 'persisted before the Hub is asked');
		one.close(); // the gateway "dies" here, without confirming
		const two = new RequestLedger(dir); two.open();
		const again = two.begin('dev1', SESSION, 'req-00000002', 'tarefa longa');
		assert.equal(again.kind, 'unknown');
		assert.equal(two.counts().unknown, 1);
		two.close();
	});

	it('detects a simultaneous request with the same id, and allows a retry only after a failure that happened before sending', () => {
		const ledger = new RequestLedger(tmp('ledger')); ledger.open();
		const first = ledger.begin('dev1', SESSION, 'req-00000003', 'x');
		assert.equal(ledger.begin('dev1', SESSION, 'req-00000003', 'x').kind, 'in-progress');
		ledger.failedBeforeSend((first as unknown as { record: any }).record, 'hub off');
		const retry = ledger.begin('dev1', SESSION, 'req-00000003', 'x');
		assert.equal(retry.kind, 'dispatch');
		assert.equal((retry as unknown as { record: { attempts: number } }).record.attempts, 2);
		ledger.close();
	});

	it('lets the person settle an unknown request, either by allowing a retry with the same id or by discarding it', () => {
		const ledger = new RequestLedger(tmp('ledger')); ledger.open();
		const a = ledger.begin('dev1', SESSION, 'req-00000004', 'a') as unknown as { record: any };
		ledger.unknown(a.record, 'drop');
		assert.equal(ledger.begin('dev1', SESSION, 'req-00000004', 'a').kind, 'unknown');
		ledger.resolve(a.record, 'retry');
		assert.equal(ledger.begin('dev1', SESSION, 'req-00000004', 'a').kind, 'dispatch');
		const b = ledger.begin('dev1', SESSION, 'req-00000005', 'b') as unknown as { record: any };
		ledger.unknown(b.record, 'drop');
		ledger.resolve(b.record, 'discard');
		assert.equal(ledger.begin('dev1', SESSION, 'req-00000005', 'b').kind, 'duplicate');
		assert.throws(() => ledger.resolve(b.record, 'retry'), LedgerError, 'only an unknown request can be resolved');
		ledger.close();
	});

	it('keeps a second gateway from touching the same registry', () => {
		const dir = tmp('ledger');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'requests.lock'), JSON.stringify({ pid: process.ppid, at: Date.now() })); // another live process holds it
		assert.throws(() => new RequestLedger(dir).open(), /Outro gateway/);
		fs.rmSync(path.join(dir, 'requests.lock'));
		const first = new RequestLedger(dir); first.open(); first.close();
		const next = new RequestLedger(dir); next.open(); next.close();
	});

	it('blocks every send when the registry is corrupted, keeps the damaged file, and only a confirmed reset reopens it', () => {
		const dir = tmp('ledger');
		const seed = new RequestLedger(dir); seed.open(); seed.begin('dev1', SESSION, 'req-00000006', 'x'); seed.close();
		fs.writeFileSync(path.join(dir, 'requests.json'), '{"v":1,"salt":"short","records":[');
		const ledger = new RequestLedger(dir); ledger.open();
		assert.ok(ledger.blocked);
		assert.equal(ledger.begin('dev1', SESSION, 'req-00000007', 'y').kind, 'blocked');
		ledger.reset();
		assert.equal(ledger.blocked, undefined);
		assert.ok(fs.readdirSync(dir).some(name => name.startsWith('requests.json.corrupt-')), 'the damaged file is kept aside');
		assert.equal(ledger.begin('dev1', SESSION, 'req-00000007', 'y').kind, 'dispatch');
		ledger.close();
	});

	it('applies a bounded retention to settled requests and never drops an unresolved one', () => {
		let now = 1_000_000;
		const ledger = new RequestLedger(tmp('ledger'), { now: () => now, retentionMs: 1000 }); ledger.open();
		const done = ledger.begin('dev1', SESSION, 'req-00000008', 'a') as unknown as { record: any };
		ledger.confirm(done.record);
		const lost = ledger.begin('dev1', SESSION, 'req-00000009', 'b') as unknown as { record: any };
		ledger.unknown(lost.record, 'drop');
		now += 5000;
		ledger.begin('dev1', SESSION, 'req-00000010', 'c');
		assert.equal(ledger.get('dev1', SESSION, 'req-00000008'), undefined, 'the settled one expired');
		assert.ok(ledger.get('dev1', SESSION, 'req-00000009'), 'the unresolved one is kept');
		ledger.close();
	});
});

// ---------- the same guarantees through the real gateway, with a Hub that can be made to fail at the worst moment ----------
class FlakyBridge extends EventEmitter {
	connected = true;
	instanceId = 'fake';
	prompts: string[] = [];
	history: Array<{ prompt: string; at: number }> = [];
	mode: 'ok' | 'down' | 'refuse' | 'lost-after-dispatch' | 'lost-and-ran' | 'hang' = 'ok';
	release?: () => void;
	start(): void { /* connected */ }
	close(): void { /* nothing */ }
	eventsAfter(): never[] { return []; }
	async sessions(): Promise<unknown[]> { return [{ id: SESSION, harness: 'opencode', status: 'idle', workspace: this.workspace }]; }
	constructor(private readonly workspace: string) { super(); }
	async call(method: string, params?: { text?: string }): Promise<unknown> {
		if (method === 'session.history') { return this.history; }
		if (method !== 'session.prompt') { return {}; }
		if (this.mode === 'down') { throw new BridgeUnavailable(); }
		if (this.mode === 'refuse') { const { BridgeError } = await import('../remote/bridge'); throw new BridgeError('recusado'); }
		if (this.mode === 'hang') { await new Promise<void>(resolve => { this.release = resolve; }); throw new Error('connection closed'); }
		if (this.mode === 'lost-and-ran') { this.prompts.push(params!.text!); this.history.push({ prompt: params!.text!, at: Date.now() }); throw new Error('connection closed'); }
		if (this.mode === 'lost-after-dispatch') { throw new Error('connection closed'); }
		this.prompts.push(params!.text!);
		this.history.push({ prompt: params!.text!, at: Date.now() });
		return { accepted: true };
	}
}

describe('remote prompts through the gateway', { timeout: 120000 }, () => {
	const directory = tmp('gateway');
	const workspace = fs.realpathSync.native(tmp('gateway-ws'));
	const make = async (bridge: FlakyBridge): Promise<{ gateway: RemoteGateway; url: string; headers: Record<string, string> }> => {
		const gateway = new RemoteGateway({ directory, webDir: path.join(__dirname, '..', '..', 'web'), bridge: bridge as unknown as HubBridge });
		await gateway.start();
		const url = `http://127.0.0.1:${gateway.publicPort}`;
		const admin = `http://127.0.0.1:${gateway.adminPort}`;
		const token = fs.readFileSync(path.join(directory, 'admin.token'), 'utf8');
		const adminCall = async (route: string, body?: unknown) => (await fetch(admin + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': token }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;
		await adminCall('/admin/workspaces/add', { path: workspace });
		let device = (await adminCall('/admin/state')).devices[0];
		let deviceToken = fs.existsSync(path.join(directory, 'test-device-token')) ? fs.readFileSync(path.join(directory, 'test-device-token'), 'utf8') : '';
		if (!device || !deviceToken) {
			const started = await adminCall('/admin/pairing/start', {});
			const claim = await (await fetch(url + '/api/pair/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: started.code, deviceName: 'Teste' }) })).json() as any;
			const pending = (await adminCall('/admin/state')).pending;
			await adminCall('/admin/pairing/decide', { id: pending[0].id, approve: true });
			const done = await (await fetch(url + '/api/pair/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claimId: claim.claimId, claimSecret: claim.claimSecret }) })).json() as any;
			deviceToken = done.token;
			fs.writeFileSync(path.join(directory, 'test-device-token'), deviceToken);
		}
		return { gateway, url, headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' } };
	};
	const send = async (g: { url: string; headers: Record<string, string> }, id: string, text: string) => {
		const response = await fetch(`${g.url}/api/sessions/${SESSION}/prompt`, { method: 'POST', headers: { ...g.headers, 'x-request-id': id }, body: JSON.stringify({ confirm: true, text }) });
		return { status: response.status, json: await response.json() as any };
	};

	it('survives a gateway restart: the retry of a confirmed send is a duplicate and never reaches the agent twice', async () => {
		const bridge = new FlakyBridge(workspace);
		let g = await make(bridge);
		assert.equal((await send(g, 'req-restart-1', 'tarefa A')).json.state, 'confirmed');
		await g.gateway.stop();
		g = await make(bridge); // a new gateway process reads the same registry
		const retry = await send(g, 'req-restart-1', 'tarefa A');
		assert.equal(retry.json.duplicate, true);
		assert.equal(bridge.prompts.filter(text => text === 'tarefa A').length, 1);
		await g.gateway.stop();
	});

	it('drops before dispatch: the failure is known, nothing ran, and the same id can be tried again', async () => {
		const bridge = new FlakyBridge(workspace);
		const g = await make(bridge);
		bridge.mode = 'down';
		const first = await send(g, 'req-before-1', 'tarefa B');
		assert.equal(first.status, 503);
		assert.equal(bridge.prompts.length, 0);
		bridge.mode = 'ok';
		assert.equal((await send(g, 'req-before-1', 'tarefa B')).json.state, 'confirmed');
		assert.equal(bridge.prompts.length, 1);
		bridge.mode = 'refuse';
		assert.equal((await send(g, 'req-before-2', 'tarefa B2')).status, 422);
		await g.gateway.stop();
	});

	it('drops after dispatch and the Hub shows the instruction: reconciled from the Hub history, not sent again', async () => {
		const bridge = new FlakyBridge(workspace);
		const g = await make(bridge);
		bridge.mode = 'lost-and-ran';
		const first = await send(g, 'req-after-1', 'tarefa C');
		assert.equal(first.json.state, 'reconciled');
		bridge.mode = 'ok';
		const retry = await send(g, 'req-after-1', 'tarefa C');
		assert.equal(retry.json.duplicate, true);
		assert.equal(bridge.prompts.filter(text => text === 'tarefa C').length, 1);
		await g.gateway.stop();
	});

	it('drops after dispatch with no evidence either way: unknown, never resent on its own, resolved only by the person', async () => {
		const bridge = new FlakyBridge(workspace);
		const g = await make(bridge);
		bridge.mode = 'lost-after-dispatch';
		const first = await send(g, 'req-unknown-1', 'tarefa D');
		assert.equal(first.status, 409);
		assert.equal(first.json.state, 'unknown');
		bridge.mode = 'ok';
		const again = await send(g, 'req-unknown-1', 'tarefa D');
		assert.equal(again.json.state, 'unknown', 'a retry does not send it by itself');
		assert.equal(bridge.prompts.length, 0);
		const resolveUrl = `${g.url}/api/sessions/${SESSION}/requests/req-unknown-1`;
		assert.equal((await fetch(resolveUrl, { method: 'POST', headers: g.headers, body: JSON.stringify({ action: 'retry' }) })).status, 400, 'a resolution needs confirmation');
		assert.equal((await fetch(resolveUrl, { method: 'POST', headers: g.headers, body: JSON.stringify({ action: 'retry', confirm: true }) })).status, 200);
		assert.equal((await send(g, 'req-unknown-1', 'tarefa D')).json.state, 'confirmed');
		assert.equal(bridge.prompts.filter(text => text === 'tarefa D').length, 1);
		await g.gateway.stop();
	});

	it('a restart in the middle of a send leaves it unknown; with the Hub evidence it is reconciled, without it it waits', async () => {
		const bridge = new FlakyBridge(workspace);
		let g = await make(bridge);
		bridge.mode = 'hang';
		const pending = send(g, 'req-mid-1', 'tarefa E');
		await new Promise(resolve => setTimeout(resolve, 300));
		await g.gateway.stop(); // the gateway goes away while the Hub call is in flight
		bridge.release?.();
		await pending.catch(() => undefined);
		bridge.mode = 'ok';
		g = await make(bridge);
		const afterRestart = await send(g, 'req-mid-1', 'tarefa E');
		assert.equal(afterRestart.json.state, 'unknown');
		bridge.history.push({ prompt: 'tarefa E', at: Date.now() });
		assert.equal((await send(g, 'req-mid-1', 'tarefa E')).json.state, 'reconciled');
		await g.gateway.stop();
	});

	it('refuses the same id for another instruction, and a corrupted registry blocks sending until it is reset on purpose', async () => {
		const bridge = new FlakyBridge(workspace);
		let g = await make(bridge);
		assert.equal((await send(g, 'req-conflict-1', 'um')).json.state, 'confirmed');
		assert.equal((await send(g, 'req-conflict-1', 'dois')).status, 409);
		await g.gateway.stop();
		fs.writeFileSync(path.join(directory, 'requests.json'), 'not json');
		g = await make(bridge);
		const before = bridge.prompts.length;
		const blocked = await send(g, 'req-corrupt-1', 'tarefa F');
		assert.equal(blocked.status, 503);
		assert.equal(blocked.json.state, 'blocked');
		assert.equal(bridge.prompts.length, before, 'nothing was dispatched while the registry was unreadable');
		const admin = `http://127.0.0.1:${g.gateway.adminPort}`;
		const token = fs.readFileSync(path.join(directory, 'admin.token'), 'utf8');
		const reset = await fetch(admin + '/admin/requests/reset', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': token }, body: JSON.stringify({ confirm: true }) });
		assert.equal(reset.status, 200);
		assert.equal((await send(g, 'req-corrupt-1', 'tarefa F')).json.state, 'confirmed');
		await g.gateway.stop();
	});
});
