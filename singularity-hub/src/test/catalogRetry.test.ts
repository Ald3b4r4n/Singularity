import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { HubBridge } from '../remote/bridge';
import { plain, RemoteGateway } from '../remote/gateway';

/** A Hub whose catalog read fails a set number of times, as it does while it starts or is busy with another read. */
class Hub extends EventEmitter {
	connected = true; instanceId = 'x'; failures = 0; reads = 0; created: unknown[] = [];
	constructor(private readonly workspace: string) { super(); }
	start(): void { /* */ } close(): void { /* */ } eventsAfter(): never[] { return []; } async sessions(): Promise<unknown[]> { return []; }
	async call(method: string, params?: { participants?: unknown[]; text?: string }): Promise<unknown> {
		if (method === 'catalog.get') {
			this.reads++;
			if (this.failures > 0) { this.failures--; throw new Error('A ativação dos plugins do OpenCode não terminou (HTTP 503).'); }
			return { services: [{ id: 'opencode', status: 'available' }], providers: [{ id: 'opencode-go', models: [{ id: 'muse-spark-1.3-contributor', efforts: [] }, { id: 'deepseek-v4.1-flash', efforts: ['low'] }] }] };
		}
		if (method === 'comparisons.create') { this.created.push(params); return { id: '11111111-1111-4111-8111-111111111111', workspace: this.workspace }; }
		return {};
	}
}

describe('transient catalog failures never reach the phone as an error or as an empty list', { timeout: 60000 }, () => {
	const stops: Array<() => Promise<void>> = [];
	after(async () => { for (const stop of stops) { await stop().catch(() => undefined); } });

	async function setup() {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-retry-'));
		const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-retry-ws-')));
		const hub = new Hub(workspace);
		const gateway = new RemoteGateway({ directory, webDir: path.join(__dirname, '..', '..', 'web'), bridge: hub as unknown as HubBridge, retryDelayMs: 10 });
		await gateway.start(); stops.push(() => gateway.stop());
		const adminToken = fs.readFileSync(path.join(directory, 'admin.token'), 'utf8');
		const admin = async (route: string, body?: unknown) => (await fetch(`http://127.0.0.1:${gateway.adminPort}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': adminToken }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;
		const workspaceId = (await admin('/admin/workspaces/add', { path: workspace })).workspace.id as string;
		const started = await admin('/admin/pairing/start', {});
		const claim = await (await fetch(`http://127.0.0.1:${gateway.publicPort}/api/pair/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: started.code, deviceName: 'Teste' }) })).json() as any;
		await admin('/admin/pairing/decide', { id: (await admin('/admin/state')).pending[0].id, approve: true });
		const token = (await (await fetch(`http://127.0.0.1:${gateway.publicPort}/api/pair/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claimId: claim.claimId, claimSecret: claim.claimSecret }) })).json() as any).token;
		const api = async (method: string, route: string, body?: unknown, rid?: string) => { const r = await fetch(`http://127.0.0.1:${gateway.publicPort}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(rid ? { 'x-request-id': rid } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json() as any }; };
		return { hub, api, workspaceId };
	}

	it('the model list of a form is read again once, and an answer comes back instead of a 502', async () => {
		const { hub, api, workspaceId } = await setup();
		hub.failures = 1;
		const read = await api('GET', `/api/catalog?workspaceId=${workspaceId}&service=opencode`);
		assert.equal(read.status, 200);
		assert.equal(read.json.providers[0].models.length, 2);
		assert.equal(hub.reads, 2);
		hub.failures = 10; hub.reads = 0;
		const hopeless = await api('GET', `/api/catalog?workspaceId=${workspaceId}&service=opencode`);
		assert.notEqual(hopeless.status, 200, 'a Hub that keeps failing is still an error: it is reported, not hidden');
		assert.equal(hub.reads, 2, 'and it was asked exactly twice, not in a loop');
	});

	it('starting a comparison checks the catalog with the same extra try, and starts it once', async () => {
		const { hub, api, workspaceId } = await setup();
		hub.failures = 1;
		const body = { confirm: true, workspaceId, text: 'tarefa', participants: [{ service: 'opencode', model: { providerID: 'opencode-go', modelID: 'muse-spark-1.3-contributor' } }, { service: 'opencode', model: { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' } }] };
		const created = await api('POST', '/api/comparisons', body, 'retry-00000001');
		assert.equal(created.status, 201);
		assert.equal(created.json.state, 'confirmed');
		assert.equal(hub.created.length, 1, 'the instruction to start went to the Hub once');
	});

	it('keeps the usage counters an agent reported (a token key is dropped, a token count is not) and still drops credentials', () => {
		const clean = plain({ participant: { id: 'p', workspace: 'C:\\secret' }, usage: { inputTokens: 1234, outputTokens: 321, cachedInputTokens: 5, costUsd: 0.5 }, token: 'sk-secret', accessToken: 'x', inputTokens_note: 'text' }) as any;
		assert.deepEqual(clean.usage, { inputTokens: 1234, outputTokens: 321, cachedInputTokens: 5, costUsd: 0.5 });
		assert.equal(clean.token, undefined); assert.equal(clean.accessToken, undefined); assert.equal(clean.participant.workspace, undefined);
		assert.equal(clean.inputTokens_note, undefined, 'only the exact counters are exempt');
	});
});
