import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { HubConnection, RpcFailure } from '../client';
import { ErrorCode } from '../protocol';
import { cleanup, startInProcess, tempHome } from './helpers';

// These requests are refused by the Hub itself, before any OpenCode process is started, so they need no OpenCode.
describe('catalog and model requests are validated by the Hub', () => {
	const home = tempHome('catalog');
	let release: () => Promise<void>;
	let c: HubConnection;

	before(async () => {
		const hub = await startInProcess(home);
		release = hub.release;
		c = await HubConnection.connect({ home, clientName: 'test' });
	});
	after(async () => { c.close(); await release(); cleanup(home); });

	const code = async (method: string, params: unknown): Promise<number | undefined> => {
		try { await c.request(method, params, 15000); return undefined; } catch (e) { return e instanceof RpcFailure ? e.code : -1; }
	};

	it('announces the new capabilities', () => {
		assert.ok(c.hello.capabilities.includes('catalog.v1'));
		assert.ok(c.hello.capabilities.includes('session.model.v1'));
	});

	it('catalog.get refuses a service without an adapter and malformed parameters', async () => {
		assert.equal(await code('catalog.get', { service: 'claude-code' }), ErrorCode.InvalidParams);
		assert.equal(await code('catalog.get', { service: 5 }), ErrorCode.InvalidParams);
		assert.equal(await code('catalog.get', { workspace: 5 }), ErrorCode.InvalidParams);
		assert.equal(await code('catalog.get', { workspace: 'x'.repeat(2000) }), ErrorCode.InvalidParams);
		assert.equal(await code('catalog.get', { refresh: 'yes' }), ErrorCode.InvalidParams);
	});

	it('catalog.get refuses a relative or missing workspace', async () => {
		assert.equal(await code('catalog.get', { workspace: 'relative/dir' }), -32006);
		assert.equal(await code('catalog.get', { workspace: 'C:\\this\\folder\\does\\not\\exist\\' + Date.now() }), -32006);
	});

	it('session.create refuses a malformed model before starting anything', async () => {
		for (const model of ['x', 5, [], {}, { providerID: 'a' }, { providerID: 'a', modelID: 'b', variant: 7 }, { providerID: 'a', modelID: 'b', variant: 'no space' }]) {
			assert.equal(await code('session.create', { workspace: 'C:\\', model }), -32006, JSON.stringify(model));
		}
	});

	it('session.setModel needs a known session and a well-formed model', async () => {
		assert.equal(await code('session.setModel', { id: 'unknown', model: { providerID: 'a', modelID: 'b' } }), ErrorCode.SessionNotFound);
		assert.equal(await code('session.setModel', { model: { providerID: 'a', modelID: 'b' } }), ErrorCode.InvalidParams);
		assert.equal(await code('session.setModel', 'nope'), ErrorCode.InvalidParams);
	});
});
