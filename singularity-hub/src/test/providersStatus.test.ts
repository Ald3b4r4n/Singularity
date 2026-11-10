import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { HubBridge } from '../remote/bridge';
import { RemoteGateway } from '../remote/gateway';

/** A Hub whose catalog read fails on demand, as it does while it starts or is busy with another read. */
class MomentaryHub extends EventEmitter {
	connected = true; instanceId = 'x'; failures = 0; reads = 0;
	start(): void { /* */ } close(): void { /* */ } eventsAfter(): never[] { return []; } async sessions(): Promise<unknown[]> { return []; }
	async call(method: string): Promise<unknown> {
		if (method !== 'catalog.get') { return {}; }
		this.reads++;
		if (this.failures > 0) { this.failures--; throw new Error('A ativação dos plugins do OpenCode não terminou (HTTP 503).'); }
		return { services: [{ id: 'opencode', name: 'OpenCode', status: 'available' }, { id: 'claude-code', name: 'Claude Code', status: 'available' }] };
	}
}

describe('the phone never gets empty providers because one catalog read failed', { timeout: 60000 }, () => {
	const stops: Array<() => Promise<void>> = [];
	after(async () => { for (const stop of stops) { await stop().catch(() => undefined); } });

	it('tries once more, then shows the last good reading, and only says "unavailable" when there is none', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-providers-'));
		const hub = new MomentaryHub();
		const gateway = new RemoteGateway({ directory, webDir: path.join(__dirname, '..', '..', 'web'), bridge: hub as unknown as HubBridge });
		await gateway.start(); stops.push(() => gateway.stop());
		const adminToken = fs.readFileSync(path.join(directory, 'admin.token'), 'utf8');
		const admin = async (route: string, body?: unknown) => (await fetch(`http://127.0.0.1:${gateway.adminPort}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': adminToken }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;
		const started = await admin('/admin/pairing/start', {});
		const claim = await (await fetch(`http://127.0.0.1:${gateway.publicPort}/api/pair/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: started.code, deviceName: 'Teste' }) })).json() as any;
		await admin('/admin/pairing/decide', { id: (await admin('/admin/state')).pending[0].id, approve: true });
		const token = (await (await fetch(`http://127.0.0.1:${gateway.publicPort}/api/pair/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claimId: claim.claimId, claimSecret: claim.claimSecret }) })).json() as any).token;
		const status = async () => (await (await fetch(`http://127.0.0.1:${gateway.publicPort}/api/status`, { headers: { authorization: `Bearer ${token}` } })).json()) as any;

		hub.failures = 1; // the first read fails, the second works
		const retried = await status();
		assert.equal(retried.providersState, 'ok');
		assert.deepEqual(retried.providers.map((p: { id: string }) => p.id), ['opencode', 'claude-code']);
		assert.equal(hub.reads, 2, 'it asked again once');

		hub.failures = 10; // the Hub stops answering
		const stale = await status();
		assert.equal(stale.providersState, 'stale', 'the last good reading is shown, not an empty list');
		assert.equal(stale.providers.length, 2);
	});

	it('says "unavailable" (empty, honestly) only when nothing has ever been read', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-providers-'));
		const hub = new MomentaryHub(); hub.failures = 10;
		const gateway = new RemoteGateway({ directory, webDir: path.join(__dirname, '..', '..', 'web'), bridge: hub as unknown as HubBridge });
		await gateway.start(); stops.push(() => gateway.stop());
		const adminToken = fs.readFileSync(path.join(directory, 'admin.token'), 'utf8');
		const admin = async (route: string, body?: unknown) => (await fetch(`http://127.0.0.1:${gateway.adminPort}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': adminToken }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;
		const started = await admin('/admin/pairing/start', {});
		const claim = await (await fetch(`http://127.0.0.1:${gateway.publicPort}/api/pair/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: started.code, deviceName: 'Teste' }) })).json() as any;
		await admin('/admin/pairing/decide', { id: (await admin('/admin/state')).pending[0].id, approve: true });
		const token = (await (await fetch(`http://127.0.0.1:${gateway.publicPort}/api/pair/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claimId: claim.claimId, claimSecret: claim.claimSecret }) })).json() as any).token;
		const response = await (await fetch(`http://127.0.0.1:${gateway.publicPort}/api/status`, { headers: { authorization: `Bearer ${token}` } })).json() as any;
		assert.equal(response.providersState, 'unavailable');
		assert.deepEqual(response.providers, []);
	});
});
