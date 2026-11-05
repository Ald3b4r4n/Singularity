import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Comparisons } from '../comparisons';
import { Session } from '../protocol';

function fixture() {
	const home = mkdtempSync(join(tmpdir(), 'sing-comparison-'));
	const workspace = join(home, 'repo');
	execFileSync('git', ['init', workspace], { stdio: 'ignore' });
	writeFileSync(join(workspace, 'sample.txt'), 'base\n');
	const git = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
	git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base');
	const sessions: Session[] = [];
	const prompts: string[] = [];
	const stop: string[] = [];
	const adapter = {
		create: async (directory: string, service: string) => {
			const session: Session = { id: randomUUID(), workspace: directory, harness: service, status: 'idle' };
			sessions.push(session); return session;
		},
		prompt: (id: string, text: string) => { prompts.push(text); sessions.find(s => s.id === id)!.status = 'running'; },
		stop: async (id: string) => { stop.push(id); sessions.find(s => s.id === id)!.historical = true; },
		list: () => sessions
	};
	const directory = join(home, 'comparisons');
	const coordinator = new Comparisons(directory, adapter, () => {});
	const input = { workspace, text: 'Read the file.', participants: ['claude-code', 'codex-cli'].map(service => ({ service, model: { providerID: service, modelID: 'test' } })) };
	return { home, workspace, git, sessions, prompts, stop, adapter, directory, coordinator, input };
}

test('comparison creates detached isolated trees at one base, sends once, cancels independently, protects modified worktrees and reloads', async () => {
	const f = fixture();
	const run = await f.coordinator.create(f.input);
	assert.equal(run.participants.length, 2);
	assert.deepEqual(f.prompts, [f.input.text, f.input.text]);
	assert.equal(f.git('status', '--porcelain'), '');
	for (const p of run.participants) {
		assert.equal(execFileSync('git', ['-C', p.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), run.base);
		assert.equal(p.status, 'running');
	}
	await f.coordinator.cancel(run.id, f.workspace, run.participants[0].id);
	assert.deepEqual(f.stop, [run.participants[0].sessionId]);
	assert.equal(f.sessions[1].status, 'running');
	f.sessions[1].status = 'done'; f.coordinator.onSession(f.sessions[1]);
	writeFileSync(join(run.participants[1].workspace, 'sample.txt'), 'changed\n');
	const inspection = await f.coordinator.inspect(run.id, f.workspace, run.participants[1].id) as { diff: string };
	assert.match(inspection.diff, /changed/);
	assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), 'base\n');
	f.coordinator.select(run.id, f.workspace, run.participants[1].id);
	await assert.rejects(f.coordinator.cleanup(run.id, f.workspace), /alterações/);
	assert.ok(existsSync(run.participants[1].workspace));
	const next = new Comparisons(f.directory, f.adapter, () => {});
	await next.recover();
	assert.equal(next.list(f.workspace)[0].selected, run.participants[1].id);
	assert.equal(f.prompts.length, 2);
	assert.equal(next.list(f.workspace)[0].participants[0].removed, true);
});

test('dirty origin, duplicate participants, wrong scope, and concurrent starts are refused', async () => {
	const f = fixture();
	writeFileSync(join(f.workspace, 'sample.txt'), 'dirty');
	await assert.rejects(f.coordinator.create(f.input), /alterações/);
	assert.equal(f.prompts.length, 0);
	f.git('restore', 'sample.txt');
	await assert.rejects(f.coordinator.create({ ...f.input, participants: [f.input.participants[0], f.input.participants[0]] }), /distintos/);
	const run = await f.coordinator.create(f.input);
	await assert.rejects(f.coordinator.create(f.input), /ativa/);
	await assert.rejects(f.coordinator.cancel(run.id, f.home), /workspace/);
});

test('restart marks absent CLI participants unrecoverable and never resends prompts or removes their trees', async () => {
	const f = fixture();
	const run = await f.coordinator.create(f.input);
	f.sessions.splice(0);
	const next = new Comparisons(f.directory, f.adapter, () => {});
	await next.recover();
	assert.ok(next.list(f.workspace)[0].participants.every(p => p.status === 'unrecoverable'));
	await assert.rejects(next.cleanup(run.id, f.workspace), /encerramento/);
	assert.equal(f.prompts.length, 2);
});

test('one unavailable provider prevents all inference and preserves prepared worktrees for inspection', async () => {
	const f = fixture();
	const coordinator = new Comparisons(f.directory, { ...f.adapter, create: async () => { throw new Error('unavailable'); } }, () => {});
	const run = await coordinator.create(f.input);
	assert.ok(run.participants.every(p => p.status === 'failed'));
	assert.equal(f.prompts.length, 0);
});

test('recovery follows the same live OpenCode session and three-agent configuration without inference', async () => {
	const f = fixture();
	const input = { ...f.input, participants: [...f.input.participants, { service: 'opencode', model: { providerID: 'opencode', modelID: 'test' } }] };
	const run = await f.coordinator.create(input);
	f.sessions[0].historical = true; f.sessions[1].historical = true;
	const next = new Comparisons(f.directory, f.adapter, () => {});
	await next.recover();
	const recovered = next.list(f.workspace)[0];
	assert.equal(recovered.base, run.base);
	assert.equal(recovered.participants[2].sessionId, run.participants[2].sessionId);
	assert.equal(recovered.participants[2].status, 'running');
	assert.equal(recovered.participants[0].status, 'unrecoverable');
	assert.equal(f.prompts.length, 3);
	await next.cancel(run.id, f.workspace, recovered.participants[2].id);
	assert.equal(next.list(f.workspace)[0].participants[2].status, 'cancelled');
});
