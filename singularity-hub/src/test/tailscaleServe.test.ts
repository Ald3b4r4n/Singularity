import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { HubBridge } from '../remote/bridge';
import { RemoteGateway } from '../remote/gateway';
import { disableServe, enableServe, Runner, serveConfig } from '../remote/tailscale';

/** One Tailscale for the whole computer, as it really is: a single Serve configuration that every gateway on the machine shares. */
function machine(initialTarget?: string) {
	const log: string[] = [];
	let web: Record<string, unknown> = initialTarget ? { 'pc.tailnet.ts.net:443': { Handlers: { '/': { Proxy: initialTarget } } } } : {};
	let funnel = false;
	const runner: Runner = async (_exe, args) => {
		log.push(args.join(' '));
		if (args[0] === 'status') { return { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'pc.tailnet.ts.net.' } }) }; }
		if (args.join(' ') === 'serve status --json') { return { code: 0, stdout: JSON.stringify(Object.keys(web).length ? { TCP: { 443: { HTTPS: true } }, Web: web, ...(funnel ? { AllowFunnel: { 'pc.tailnet.ts.net:443': true } } : {}) } : {}) }; }
		if (args[0] === 'serve' && args[1] === '--bg') { web = { 'pc.tailnet.ts.net:443': { Handlers: { '/': { Proxy: args[3] } } } }; return { code: 0, stdout: '' }; }
		if (args.join(' ') === 'serve --https=443 off') { web = {}; return { code: 0, stdout: '' }; }
		return { code: 1, stdout: '' };
	};
	return { runner, log, target: () => (Object.values(web)[0] as { Handlers: { '/': { Proxy: string } } } | undefined)?.Handlers['/'].Proxy, setFunnel: (value: boolean) => { funnel = value; } };
}
const env = (): NodeJS.ProcessEnv => ({ SINGULARITY_TAILSCALE: process.execPath });
class NoHub extends EventEmitter { connected = true; instanceId = 'x'; start(): void { /* */ } close(): void { /* */ } eventsAfter(): never[] { return []; } async sessions(): Promise<unknown[]> { return []; } async call(): Promise<unknown> { return {}; } }

describe('Tailscale Serve belongs to the gateway that published it', { timeout: 60000 }, () => {
	const stops: Array<() => Promise<void>> = [];
	after(async () => { for (const stop of stops) { await stop().catch(() => undefined); } });
	async function gateway(runner: Runner, directory = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-serve-'))) {
		const instance = new RemoteGateway({ directory, webDir: path.join(__dirname, '..', '..', 'web'), bridge: new NoHub() as unknown as HubBridge, env: env(), tailscaleRunner: runner });
		await instance.start(); stops.push(() => instance.stop());
		const token = fs.readFileSync(path.join(directory, 'admin.token'), 'utf8');
		const admin = async (route: string, body?: unknown) => (await fetch(`http://127.0.0.1:${instance.adminPort}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': token }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;
		return { instance, admin, directory };
	}

	it('reads what is published without changing it', async () => {
		const m = machine('http://127.0.0.1:51946');
		assert.deepEqual(await serveConfig(env(), m.runner), { known: true, configured: true, targets: ['http://127.0.0.1:51946'], funnel: false });
		assert.deepEqual(await serveConfig(env(), machine().runner), { known: true, configured: false, targets: [], funnel: false });
		assert.deepEqual(m.log, ['serve status --json']);
	});

	it('a gateway that never published does NOT turn off what another gateway is serving (this took the owner\'s publication down)', async () => {
		const m = machine('http://127.0.0.1:51946');
		const other = await gateway(m.runner);
		const result = await other.admin('/admin/tailscale/off', {});
		assert.equal(result.skipped, true);
		assert.equal(m.target(), 'http://127.0.0.1:51946', 'the owner\'s publication is intact');
		assert.ok(!m.log.includes('serve --https=443 off'), 'the off command was never run');
		assert.deepEqual(await disableServe(40000, env(), m.runner), { ok: true, skipped: true });
	});

	it('publishes the port the gateway listens on now, confirms it is tailnet only, and may turn its own publication off', async () => {
		const m = machine();
		const g = await gateway(m.runner);
		const before = await g.admin('/admin/tailscale');
		assert.equal(before.serve.configured, false); assert.equal(before.serve.pointsHere, false); assert.equal(before.gatewayPort, g.instance.publicPort);
		assert.equal((await fetch(`http://127.0.0.1:${g.instance.adminPort}/admin/tailscale/serve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': fs.readFileSync(path.join(g.directory, 'admin.token'), 'utf8') }, body: JSON.stringify({}) })).status, 400, 'no consent, no change');
		const published = await g.admin('/admin/tailscale/serve', { consent: true });
		assert.equal(published.ok, true); assert.equal(published.tailnetOnly, true); assert.equal(published.url, 'https://pc.tailnet.ts.net/');
		assert.equal(m.target(), `http://127.0.0.1:${g.instance.publicPort}`);
		const now = await g.admin('/admin/tailscale');
		assert.equal(now.serve.pointsHere, true); assert.equal(now.serve.funnel, false); assert.equal(now.serve.conflict, false);
		assert.equal((await g.admin('/admin/tailscale/off', {})).ok, true);
		assert.equal(m.target(), undefined);
	});

	it('after a restart on another port the old publication is seen as stale and is replaced only by an explicit reactivation', async () => {
		const m = machine();
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-serve-'));
		const first = await gateway(m.runner, directory);
		await first.admin('/admin/tailscale/serve', { consent: true });
		const oldPort = first.instance.publicPort;
		await first.instance.stop();
		assert.equal(m.target(), `http://127.0.0.1:${oldPort}`, 'stopping the process does not touch Tailscale');
		const second = await gateway(m.runner, directory);
		const state = await second.admin('/admin/tailscale');
		if (second.instance.publicPort !== oldPort) {
			assert.equal(state.serve.pointsHere, false); assert.equal(state.serve.stale, true); assert.equal(state.serve.conflict, false);
		}
		assert.equal(state.serve.previouslyPublished, true);
		assert.equal(m.target(), `http://127.0.0.1:${oldPort}`, 'reading the state changed nothing');
		const again = await second.admin('/admin/tailscale/serve', { consent: true });
		assert.equal(again.ok, true);
		assert.equal(m.target(), `http://127.0.0.1:${second.instance.publicPort}`, 'the current port, never a remembered one');
	});

	it('refuses to replace a publication that is not its own, unless that is asked for explicitly, and reports Funnel instead of touching it', async () => {
		const m = machine('http://127.0.0.1:8080');
		const g = await gateway(m.runner);
		const state = await g.admin('/admin/tailscale');
		assert.equal(state.serve.conflict, true);
		const refused = await g.admin('/admin/tailscale/serve', { consent: true });
		assert.equal(refused.ok, false); assert.equal(refused.conflict, true);
		assert.equal(m.target(), 'http://127.0.0.1:8080');
		m.setFunnel(true);
		assert.equal((await g.admin('/admin/tailscale')).serve.funnel, true);
		const replaced = await g.admin('/admin/tailscale/serve', { consent: true, replace: true });
		assert.equal(replaced.ok, true); assert.equal(replaced.tailnetOnly, false, 'Funnel is still on: it is reported, not hidden');
		assert.equal(m.log.some(command => /funnel|reset| down| up/.test(command)), false, 'no funnel, reset, down or up command is ever run');
		assert.deepEqual(await enableServe(80, env(), m.runner), { ok: false, reason: 'Tailscale indisponível.' });
	});
});
