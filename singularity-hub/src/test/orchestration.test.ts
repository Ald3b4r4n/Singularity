import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { ALLOWED_HUB_METHODS, BridgeUnavailable, HubBridge } from '../remote/bridge';
import { RemoteGateway } from '../remote/gateway';
import { parseComparison, parseTeam } from '../remote/orchestration';

const tmp = (name: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `singularity-${name}-`));
const MUSE = { service: 'opencode', model: { providerID: 'opencode-go', modelID: 'muse-spark-1.3-contributor' } };
const FLASH = { service: 'opencode', model: { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash', variant: 'high' } };
const CLAUDE = { service: 'claude-code', model: { providerID: 'claude-code', modelID: 'sonnet' } };

/** A Hub that keeps comparisons and teams the way the real one reports them, and can be made to fail. */
class FakeHub extends EventEmitter {
	connected = true; instanceId = 'fake';
	calls: Array<{ method: string; params: any }> = [];
	comparisons: any[] = []; teams: any[] = [];
	mode: 'ok' | 'down' | 'lost' | 'lost-and-created' = 'ok';
	constructor(private readonly workspace: string) { super(); }
	start(): void { /* connected */ } close(): void { /* nothing */ } eventsAfter(): never[] { return []; }
	async sessions(): Promise<unknown[]> { return []; }
	async call(method: string, params?: any): Promise<unknown> {
		this.calls.push({ method, params });
		if (method === 'catalog.get') {
			return params.service === 'claude-code'
				? { services: [{ id: 'claude-code', status: 'available' }], providers: [{ id: 'claude-code', models: [{ id: 'sonnet', efforts: ['low', 'high'] }] }] }
				: { services: [{ id: 'opencode', status: 'available' }], providers: [{ id: 'opencode-go', models: [{ id: 'muse-spark-1.3-contributor', efforts: [] }, { id: 'deepseek-v4.1-flash', efforts: ['low', 'high'] }] }] };
		}
		if (method === 'comparisons.list') { return this.comparisons; }
		if (method === 'teams.list') { return this.teams; }
		if (method === 'comparisons.create' || method === 'teams.start') {
			if (this.mode === 'down') { throw new BridgeUnavailable(); }
			const record = method === 'comparisons.create'
				? { id: '11111111-1111-4111-8111-1111111111' + String(this.comparisons.length).padStart(2, '0'), workspace: this.workspace, prompt: params.text, createdAt: Date.now(), participants: params.participants.map((p: any, i: number) => ({ id: 'part-' + i, service: p.service, model: p.model, status: 'running' })) }
				: { id: '22222222-2222-4222-8222-2222222222' + String(this.teams.length).padStart(2, '0'), workspace: this.workspace, task: params.text, createdAt: Date.now(), state: 'running', maxCorrections: params.maxCorrections, roles: params.participants, steps: [], versions: [] };
			if (this.mode === 'lost') { throw new Error('connection closed'); }
			(method === 'comparisons.create' ? this.comparisons : this.teams).push(record);
			if (this.mode === 'lost-and-created') { throw new Error('connection closed'); }
			return record;
		}
		return { ok: true };
	}
}

describe('Remote 2.0 orchestration through the gateway', { timeout: 180000 }, () => {
	const directory = tmp('orch');
	const workspace = fs.realpathSync.native(tmp('orch-ws'));
	const outsider = fs.realpathSync.native(tmp('orch-out'));
	const runner = path.join(workspace, 'test-runner.cmd');
	fs.writeFileSync(runner, '@echo ok\r\n');
	const cleanups: Array<() => Promise<void>> = [];
	after(async () => { for (const cleanup of cleanups) { await cleanup().catch(() => undefined); } });

	async function make(hub: FakeHub) {
		const gateway = new RemoteGateway({ directory, webDir: path.join(__dirname, '..', '..', 'web'), bridge: hub as unknown as HubBridge });
		await gateway.start();
		cleanups.push(() => gateway.stop());
		const url = `http://127.0.0.1:${gateway.publicPort}`;
		const adminUrl = `http://127.0.0.1:${gateway.adminPort}`;
		const adminToken = fs.readFileSync(path.join(directory, 'admin.token'), 'utf8');
		const admin = async (route: string, body?: unknown) => { const r = await fetch(adminUrl + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': adminToken }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json() as any }; };
		const added = await admin('/admin/workspaces/add', { path: workspace });
		const workspaceId = added.json.workspace.id as string;
		let token = fs.existsSync(path.join(directory, 'device-token')) ? fs.readFileSync(path.join(directory, 'device-token'), 'utf8') : '';
		if (!token) {
			const started = await admin('/admin/pairing/start', {});
			const claim = await (await fetch(url + '/api/pair/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: started.json.code, deviceName: 'Teste' }) })).json() as any;
			await admin('/admin/pairing/decide', { id: (await admin('/admin/state')).json.pending[0].id, approve: true });
			token = (await (await fetch(url + '/api/pair/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claimId: claim.claimId, claimSecret: claim.claimSecret }) })).json() as any).token;
			fs.writeFileSync(path.join(directory, 'device-token'), token);
		}
		const api = async (method: string, route: string, body?: unknown, rid?: string) => {
			const r = await fetch(url + route, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(rid ? { 'x-request-id': rid } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
			let json: any; try { json = await r.json(); } catch { json = {}; }
			return { status: r.status, json };
		};
		return { gateway, admin, api, workspaceId };
	}

	it('keeps the closed API: the new operations are allowed, applying/undoing/cleanup and generic RPC are not', () => {
		for (const method of ['comparisons.create', 'comparisons.cancel', 'comparisons.select', 'teams.start', 'teams.cancel', 'teams.resume', 'teams.delete', 'teams.instruct', 'teams.validate', 'teams.choose']) { assert.ok((ALLOWED_HUB_METHODS as readonly string[]).includes(method), method); }
		for (const method of ['solutions.apply', 'solutions.undo', 'solutions.prepare', 'comparisons.cleanup', 'hub.shutdown', 'processes.terminate', 'session.stop']) { assert.ok(!(ALLOWED_HUB_METHODS as readonly string[]).includes(method), method); }
	});

	it('validates what the phone sends: counts, distinct agents, limits and the correction cycles', () => {
		const ok = { workspaceId: 'w', text: 'faça', participants: [MUSE, FLASH] };
		assert.equal(parseComparison(ok).participants.length, 2);
		assert.throws(() => parseComparison({ ...ok, participants: [MUSE] }), /dois ou três/);
		assert.throws(() => parseComparison({ ...ok, participants: [MUSE, MUSE] }), /distintos/);
		assert.throws(() => parseComparison({ ...ok, participants: [MUSE, FLASH, CLAUDE, CLAUDE] }), /dois ou três/);
		assert.throws(() => parseComparison({ ...ok, text: 'x'.repeat(16001) }), /até 16000/);
		const team = { workspaceId: 'w', text: 'faça', roles: { implementer: MUSE, reviewer: FLASH, tester: MUSE }, maxCorrections: 2 };
		assert.equal(parseTeam(team).roles.length, 3);
		assert.throws(() => parseTeam({ ...team, maxCorrections: 3 }), /0 a 2/);
		assert.throws(() => parseTeam({ ...team, roles: { implementer: MUSE, reviewer: FLASH } }), /provedor/);
		assert.throws(() => parseTeam({ ...team, text: 'x'.repeat(7001) }), /até 7000/);
		assert.throws(() => parseComparison({ ...ok, participants: [MUSE, { service: 'bash', model: { providerID: 'x', modelID: 'y' } }] }), /provedor/);
	});

	it('starts a comparison only after confirmation and a request id, with real catalog choices, in an authorised workspace', async () => {
		const hub = new FakeHub(workspace);
		const { api, workspaceId } = await make(hub);
		const body = { workspaceId, text: 'implemente a função', participants: [MUSE, FLASH], confirm: true };
		assert.equal((await api('POST', '/api/comparisons', { ...body, confirm: undefined }, 'cmp-0000001')).status, 400, 'no confirmation');
		assert.equal((await api('POST', '/api/comparisons', body)).status, 400, 'no request id');
		assert.equal((await api('POST', '/api/comparisons', { ...body, workspaceId: 'nao-autorizado' }, 'cmp-0000002')).status, 403, 'unauthorised workspace');
		assert.equal((await api('POST', '/api/comparisons', { ...body, participants: [MUSE, { ...FLASH, model: { ...FLASH.model, modelID: 'inventado' } }] }, 'cmp-0000003')).status, 422, 'a model the catalog does not offer');
		assert.equal((await api('POST', '/api/comparisons', { ...body, participants: [MUSE, { ...FLASH, model: { ...FLASH.model, variant: 'xhigh' } }] }, 'cmp-0000004')).status, 422, 'an effort the model does not have');
		assert.equal(hub.calls.filter(c => c.method === 'comparisons.create').length, 0, 'nothing was started by any refusal');
		const created = await api('POST', '/api/comparisons', body, 'cmp-0000005');
		assert.equal(created.status, 201);
		assert.equal(created.json.state, 'confirmed');
		const sent = hub.calls.find(c => c.method === 'comparisons.create')!.params;
		assert.equal(sent.workspace, workspace, 'the Hub gets the real path; the phone only ever had the opaque id');
		assert.deepEqual(sent.participants, [MUSE, FLASH]);
		assert.doesNotMatch(JSON.stringify(created.json), new RegExp(workspace.replace(/\\/g, '\\\\')), 'no path in the answer');
	});

	it('never starts the same comparison twice: double tap, repeated id, concurrent requests and a different payload under the same id', async () => {
		const hub = new FakeHub(workspace);
		const { api, workspaceId } = await make(hub);
		const body = { workspaceId, text: 'tarefa dupla', participants: [MUSE, FLASH], confirm: true };
		const [a, b] = await Promise.all([api('POST', '/api/comparisons', body, 'dup-00000001'), api('POST', '/api/comparisons', body, 'dup-00000001')]);
		assert.ok([a.status, b.status].includes(201), 'one of them started it');
		assert.equal(hub.calls.filter(c => c.method === 'comparisons.create').length, 1, 'concurrent identical requests created one comparison');
		const again = await api('POST', '/api/comparisons', body, 'dup-00000001');
		assert.equal(again.json.duplicate, true);
		assert.equal(again.json.ref, a.json.comparison?.id ?? b.json.comparison?.id, 'the repeat answers with the same comparison');
		const other = await api('POST', '/api/comparisons', { ...body, text: 'outra tarefa' }, 'dup-00000001');
		assert.equal(other.status, 409);
		assert.equal(hub.calls.filter(c => c.method === 'comparisons.create').length, 1);
	});

	it('survives a gateway restart and a lost connection: reconciled with the Hub list, or unknown, never repeated', async () => {
		const hub = new FakeHub(workspace);
		let g = await make(hub);
		hub.mode = 'lost-and-created';
		const lost = await g.api('POST', '/api/comparisons', { workspaceId: g.workspaceId, text: 'tarefa perdida', participants: [MUSE, FLASH], confirm: true }, 'lost-0000001');
		assert.equal(lost.json.state, 'reconciled', 'the Hub list shows it exists');
		assert.equal(hub.comparisons.filter(c => c.prompt === 'tarefa perdida').length, 1);
		hub.mode = 'lost';
		const unknown = await g.api('POST', '/api/comparisons', { workspaceId: g.workspaceId, text: 'tarefa sem prova', participants: [MUSE, FLASH], confirm: true }, 'lost-0000002');
		assert.equal(unknown.status, 409);
		assert.equal(unknown.json.state, 'unknown');
		await g.gateway.stop();
		hub.mode = 'ok';
		g = await make(hub);
		const retry = await g.api('POST', '/api/comparisons', { workspaceId: g.workspaceId, text: 'tarefa sem prova', participants: [MUSE, FLASH], confirm: true }, 'lost-0000002');
		assert.equal(retry.json.state, 'unknown', 'a restart does not turn "unknown" into a resend');
		assert.equal(hub.comparisons.filter(c => c.prompt === 'tarefa sem prova').length, 0);
		const operation = `/api/operations/comparison.create/${g.workspaceId}/lost-0000002`;
		assert.equal((await g.api('POST', operation, { action: 'retry' })).status, 400, 'a decision needs confirmation');
		assert.equal((await g.api('POST', operation, { action: 'retry', confirm: true })).status, 200);
		assert.equal((await g.api('POST', '/api/comparisons', { workspaceId: g.workspaceId, text: 'tarefa sem prova', participants: [MUSE, FLASH], confirm: true }, 'lost-0000002')).status, 201);
		assert.equal(hub.comparisons.filter(c => c.prompt === 'tarefa sem prova').length, 1);
	});

	it('starts a team with three independent roles, validates the cycles and keeps the Hub down case a known failure', async () => {
		const hub = new FakeHub(workspace);
		const { api, workspaceId } = await make(hub);
		const body = { workspaceId, text: 'construa o módulo', roles: { implementer: MUSE, reviewer: FLASH, tester: MUSE }, maxCorrections: 1, confirm: true };
		hub.mode = 'down';
		const down = await api('POST', '/api/teams', body, 'team-0000001');
		assert.equal(down.status, 503);
		assert.equal(hub.teams.length, 0);
		hub.mode = 'ok';
		const started = await api('POST', '/api/teams', body, 'team-0000001');
		assert.equal(started.status, 201, 'the same id is allowed again after a failure that happened before dispatch');
		const sent = hub.calls.find(c => c.method === 'teams.start')!.params;
		assert.deepEqual(sent.participants, [MUSE, FLASH, MUSE], 'implementer, reviewer, tester, in that order, each with its own model');
		assert.equal(sent.maxCorrections, 1);
		assert.equal((await api('POST', '/api/teams', { ...body, maxCorrections: 5 }, 'team-0000002')).status, 400);
		assert.equal((await api('POST', '/api/teams', { ...body, roles: { ...body.roles, reviewer: { ...FLASH, model: { ...FLASH.model, modelID: 'nao-existe' } } } }, 'team-0000003')).status, 422);
		const detail = await api('GET', `/api/teams/${started.json.team.id}?workspaceId=${workspaceId}`);
		assert.equal(detail.status, 200);
		assert.equal(detail.json.task, 'construa o módulo');
	});

	it('runs team and comparison controls only for an authorised workspace, with a request id, and never reaches apply/undo', async () => {
		const hub = new FakeHub(workspace);
		const { api, workspaceId } = await make(hub);
		const id = '33333333-3333-4333-8333-333333333333';
		assert.equal((await api('POST', `/api/teams/${id}/cancel`, { workspaceId, confirm: true })).status, 400, 'request id');
		assert.equal((await api('POST', `/api/teams/${id}/cancel`, { workspaceId: 'x', confirm: true }, 'ctl-00000001')).status, 403);
		assert.equal((await api('POST', `/api/teams/${id}/cancel`, { workspaceId }, 'ctl-00000002')).status, 400, 'confirmation');
		assert.equal((await api('POST', `/api/teams/${id}/cancel`, { workspaceId, confirm: true, role: 'reviewer' }, 'ctl-00000003')).status, 200);
		assert.equal((await api('POST', `/api/teams/${id}/resume`, { workspaceId, confirm: true }, 'ctl-00000004')).status, 200);
		assert.equal((await api('POST', `/api/teams/${id}/choose`, { workspaceId, confirm: true }, 'ctl-00000005')).status, 200);
		assert.equal((await api('POST', `/api/teams/${id}/instruct`, { workspaceId, confirm: true, text: '  ' }, 'ctl-0000000b')).status, 400, 'an empty instruction is refused before the Hub is asked');
		assert.equal((await api('POST', `/api/teams/${id}/instruct`, { workspaceId, confirm: true, text: 'Publique também.' }, 'ctl-0000000c')).status, 200);
		assert.deepEqual(hub.calls.filter(c => c.method === 'teams.instruct').map(c => (c.params as { text: string }).text), ['Publique também.']);
		assert.equal((await api('POST', `/api/comparisons/${id}/instruct`, { workspaceId, confirm: true, text: 'x' }, 'ctl-0000000d')).status, 404);
		assert.equal((await api('POST', `/api/teams/${id}/delete`, { workspaceId, confirm: true }, 'ctl-00000009')).status, 200, 'a team that is not working can be deleted');
		assert.equal((await api('POST', `/api/comparisons/${id}/delete`, { workspaceId, confirm: true }, 'ctl-0000000a')).status, 404, 'comparisons are not deleted from the phone');
		assert.equal((await api('POST', `/api/comparisons/${id}/cancel`, { workspaceId, confirm: true }, 'ctl-00000006')).status, 200);
		assert.equal((await api('POST', `/api/comparisons/${id}/select`, { workspaceId, confirm: true }, 'ctl-00000007')).status, 400, 'a participant is required');
		assert.equal((await api('POST', `/api/comparisons/${id}/select`, { workspaceId, confirm: true, participantId: 'part-1' }, 'ctl-00000008')).status, 200);
		for (const forbidden of ['apply', 'undo', 'cleanup', 'prepare', 'shutdown']) {
			assert.equal((await api('POST', `/api/comparisons/${id}/${forbidden}`, { workspaceId, confirm: true }, 'forb-' + forbidden.padEnd(8, '0'))).status, 404, forbidden);
			assert.equal((await api('POST', `/api/teams/${id}/${forbidden}`, { workspaceId, confirm: true }, 'forb-t' + forbidden.padEnd(7, '0'))).status, 404, forbidden);
		}
		assert.equal((await api('POST', '/api/solutions/apply', { confirm: true }, 'forb-solutions')).status, 404);
		const used = hub.calls.map(c => c.method);
		assert.ok(!used.some(m => /solutions\.|cleanup|shutdown|processes\./.test(m)), 'none of the forbidden operations reached the Hub');
	});

	it('runs independent validation only from a profile the owner registered on Windows; the phone cannot name a command', async () => {
		const hub = new FakeHub(workspace);
		const { api, admin, workspaceId } = await make(hub);
		const id = '44444444-4444-4444-8444-444444444444';
		assert.deepEqual((await api('GET', `/api/validation-profiles?workspaceId=${workspaceId}`)).json.profiles, [], 'none registered yet');
		const trial = await api('POST', `/api/teams/${id}/validate`, { workspaceId, confirm: true, profileId: 'qualquer', executable: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'calc'] }, 'val-00000001');
		assert.equal(trial.status, 403, 'an unknown profile id is refused, and the command fields are ignored');
		assert.equal(hub.calls.filter(c => c.method === 'teams.validate').length, 0);
		assert.equal((await admin('/admin/profiles/add', { workspaceId, label: 'Testes', executable: 'C:\\nao\\existe.exe', args: [], confirm: true })).status, 400, 'the executable must exist');
		assert.equal((await admin('/admin/profiles/add', { workspaceId, label: 'Testes', executable: runner, args: ['--rapido'] })).status, 400, 'registering needs confirmation');
		const added = await admin('/admin/profiles/add', { workspaceId, label: 'Testes do projeto', executable: runner, args: ['--rapido'], confirm: true });
		assert.equal(added.status, 200);
		const visible = await api('GET', `/api/validation-profiles?workspaceId=${workspaceId}`);
		assert.deepEqual(visible.json.profiles, [{ id: added.json.profile.id, label: 'Testes do projeto' }]);
		assert.doesNotMatch(JSON.stringify(visible.json), /rapido|test-runner|\.cmd/, 'the command never reaches the phone');
		const ok = await api('POST', `/api/teams/${id}/validate`, { workspaceId, confirm: true, profileId: added.json.profile.id }, 'val-00000002');
		assert.equal(ok.status, 200);
		const sent = hub.calls.find(c => c.method === 'teams.validate')!.params;
		assert.deepEqual(sent.command, { executable: runner, args: ['--rapido'], approved: true });
		assert.equal((await admin('/admin/profiles/remove', { id: added.json.profile.id })).json.ok, true);
		assert.equal((await api('POST', `/api/teams/${id}/validate`, { workspaceId, confirm: true, profileId: added.json.profile.id }, 'val-00000003')).status, 403);
		void outsider;
	});
});
