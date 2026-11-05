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
		assert.ok(c.hello.capabilities.includes('claude-code.v1'));
		assert.ok(c.hello.capabilities.includes('codex-cli.v1'));
		assert.ok(c.hello.capabilities.includes('session.model.v1'));
	});

	it('catalog.get refuses a service without an adapter and malformed parameters', async () => {
		assert.equal(await code('catalog.get', { service: 'gemini-cli' }), ErrorCode.InvalidParams);
		assert.equal(await code('catalog.get', { service: 5 }), ErrorCode.InvalidParams);
		assert.equal(await code('catalog.get', { workspace: 5 }), ErrorCode.InvalidParams);
		assert.equal(await code('catalog.get', { workspace: 'x'.repeat(2000) }), ErrorCode.InvalidParams);
		assert.equal(await code('catalog.get', { refresh: 'yes' }), ErrorCode.InvalidParams);
	});

	it('catalog.get answers for Claude Code with its real state, never an invented one', async () => {
		const result = await c.request<{ service: string; services: Array<{ id: string; status: string }>; providers: unknown[]; unavailable?: string }>('catalog.get', { service: 'claude-code' }, 60000);
		assert.equal(result.service, 'claude-code');
		const entry = result.services.find(service => service.id === 'claude-code');
		assert.ok(entry && (entry.status === 'available' || entry.status === 'unavailable'));
		assert.equal(result.providers.length > 0, entry.status === 'available');
		assert.equal(result.services.find(service => service.id === 'gemini-cli')?.status, 'planned');
	});

	it('catalog.get answers for Codex CLI with its real state, never an invented one', async () => {
		const result = await c.request<{ service: string; services: Array<{ id: string; status: string }>; providers: unknown[] }>('catalog.get', { service: 'codex-cli' }, 60000);
		assert.equal(result.service, 'codex-cli');
		const entry = result.services.find(service => service.id === 'codex-cli');
		assert.ok(entry && (entry.status === 'available' || entry.status === 'unavailable'));
		assert.equal(result.providers.length > 0, entry.status === 'available');
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

	it('session.create for Claude Code refuses a permission bypass and unknown modes before starting anything', async () => {
		for (const permissionMode of ['bypassPermissions', 'auto', 'manual', 'anything', 5]) {
			assert.equal(await code('session.create', { workspace: 'C:\\', service: 'claude-code', permissionMode }), -32006, String(permissionMode));
		}
		for (const permissionMode of ['danger-full-access', 'bypassPermissions', 'acceptEdits', 'anything', 5]) {
			assert.equal(await code('session.create', { workspace: 'C:\\', service: 'codex-cli', permissionMode }), -32006, 'codex ' + String(permissionMode));
		}
	});

	it('session.setModel needs a known session and a well-formed model', async () => {
		assert.equal(await code('session.setModel', { id: 'unknown', model: { providerID: 'a', modelID: 'b' } }), ErrorCode.SessionNotFound);
		assert.equal(await code('session.setModel', { model: { providerID: 'a', modelID: 'b' } }), ErrorCode.InvalidParams);
		assert.equal(await code('session.setModel', 'nope'), ErrorCode.InvalidParams);
	});
	it('provider diagnosis and isolation refuse malformed or implicit profile choices before invoking a provider', async () => {
		assert.equal(await code('providers.diagnose', { id: 'opencode', workspace: 42 }), ErrorCode.InvalidParams);
		assert.equal(await code('providers.diagnose', { id: 'opencode', workspace: 'relative' }), ErrorCode.InvalidParams);
		assert.equal(await code('providers.diagnose', { id: 'claude-code' }), ErrorCode.InvalidParams);
		assert.equal(await code('providers.profile', { id: 'opencode', workspace: 'relative', profile: 'isolated', approved: false }), ErrorCode.InvalidParams);
		assert.equal(await code('providers.profile', { id: 'opencode', workspace: 'relative', profile: 'unknown', approved: true }), ErrorCode.InvalidParams);
	});

});
