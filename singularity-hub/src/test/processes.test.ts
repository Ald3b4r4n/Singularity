import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { classify, Context, shutdownInstance, InstanceRecord, ProcInfo, readInstances, registerInstance, terminate, unregisterInstance, windowsLister } from '../processes';

const HUB_CMD = 'D:\\App\\resources\\app\\singularity-hub\\runtime\\node.exe D:\\App\\resources\\app\\singularity-hub\\dist\\main.js';
const proc = (pid: number, created: number, extra: Partial<ProcInfo> = {}): ProcInfo => ({ pid, ppid: 1, name: 'node.exe', created, ...extra });
const hub = (pid: number, created: number): ProcInfo => proc(pid, created, { cmd: HUB_CMD });
const helper = (pid: number, ppid: number, created: number): ProcInfo => ({ pid, ppid, name: 'singularity-job.exe', path: 'D:\\App\\resources\\app\\singularity-hub\\dist\\singularity-job.exe', created });
const record = (pid: number, startedAtMs: number, home = 'C:\\homes\\iso'): InstanceRecord => ({ v: 1, pid, startedAtMs, home, instanceId: 'i' + pid, kind: 'isolated', script: 'main.js' });
const role = (snapshot: ReturnType<typeof classify>, pid: number) => snapshot.entries.find(entry => entry.pid === pid);

describe('process diagnosis', () => {
	it('recognizes the legitimate Hub by discovery and by creation time, and never offers it for termination', () => {
		const snapshot = classify([hub(100, 1_000_000)], { current: { pid: 100, startedAtMs: 1_001_000 } });
		assert.equal(role(snapshot, 100)?.role, 'current-hub');
		assert.equal(role(snapshot, 100)?.canTerminate, false);
	});

	it('keeps an active session and its agent: an agent owned by the running Hub is linked, not an orphan', () => {
		const snapshot = classify([hub(100, 1_000_000), helper(200, 100, 1_050_000)], { current: { pid: 100, startedAtMs: 1_000_500 }, owned: [{ pid: 200, sessionId: 'sess-1' }] });
		assert.equal(role(snapshot, 200)?.role, 'linked-agent');
		assert.deepEqual(role(snapshot, 200)?.sessions, ['sess-1']);
		assert.equal(role(snapshot, 200)?.canTerminate, false);
	});

	it('tells an in-use isolated Hub from an orphan, using the record and what its own home says', () => {
		const procs = [hub(100, 1_000_000), hub(300, 2_000_000), hub(400, 3_000_000)];
		const context: Context = {
			current: { pid: 100, startedAtMs: 1_000_100 }, records: [record(300, 2_000_300), record(400, 3_000_300, 'C:\\homes\\gone')],
			homeHub: home => home.endsWith('iso') ? { pid: 300, startedAtMs: 2_000_300 } : undefined
		};
		const snapshot = classify(procs, context);
		assert.equal(role(snapshot, 300)?.role, 'other-hub');
		assert.equal(role(snapshot, 300)?.canTerminate, false);
		assert.equal(role(snapshot, 400)?.role, 'orphan-hub');
		assert.equal(role(snapshot, 400)?.canTerminate, true);
	});

	it('preserves a Hub it cannot prove: no record, or a record whose creation time does not match (PID reused)', () => {
		const snapshot = classify([hub(100, 1_000_000), hub(500, 5_000_000), hub(600, 9_000_000)], { current: { pid: 100, startedAtMs: 1_000_100 }, records: [record(600, 6_000_000)] });
		for (const pid of [500, 600]) {
			assert.equal(role(snapshot, pid)?.role, 'unverified-hub');
			assert.equal(role(snapshot, pid)?.verified, false);
			assert.equal(role(snapshot, pid)?.canTerminate, false);
		}
	});

	it('never concludes a leftover from a missing registry: a Hub without proof is preserved, however idle it looks', () => {
		const snapshot = classify([hub(100, 1_000_000), hub(700, 2_000_000)], { current: { pid: 100, startedAtMs: 1_000_100 } });
		assert.equal(role(snapshot, 700)?.role, 'unverified-hub');
		assert.equal(role(snapshot, 700)?.canTerminate, false);
	});

	it('treats a registered Hub whose own home points to it but that stopped answering as an orphan, after two minutes', () => {
		const procs = [hub(100, 1_000_000), hub(800, 2_000_000)];
		const context = (now: number): Context => ({ now, current: { pid: 100, startedAtMs: 1_000_100 }, records: [record(800, 2_000_200)], homeHub: () => ({ pid: 800, startedAtMs: 2_000_200, answers: false }) });
		assert.equal(role(classify(procs, context(2_030_000)), 800)?.role, 'other-hub', 'still starting, perhaps: not yet');
		assert.equal(role(classify(procs, context(2_300_000)), 800)?.role, 'orphan-hub');
		assert.equal(role(classify(procs, context(2_300_000)), 800)?.canTerminate, true);
	});

	it('flags an agent whose creator is gone as orphan, but not one that runs under a live Hub, and ignores foreign processes', () => {
		const procs = [hub(100, 1_000_000), helper(210, 100, 1_100_000), helper(220, 9999, 1_200_000), proc(900, 1, { name: 'chrome.exe', cmd: 'chrome.exe' })];
		const snapshot = classify(procs, { current: { pid: 100, startedAtMs: 1_000_100 } });
		assert.equal(role(snapshot, 210)?.role, 'linked-agent');
		assert.equal(role(snapshot, 220)?.role, 'orphan-agent');
		assert.equal(role(snapshot, 900), undefined);
		assert.equal(snapshot.foreignIgnored, 1);
	});

	it('does not invent a link from a parent PID that was reused by a newer process', () => {
		const snapshot = classify([hub(100, 5_000_000), helper(230, 100, 1_000_000)], { current: { pid: 100, startedAtMs: 5_000_100 } });
		assert.equal(role(snapshot, 230)?.role, 'orphan-agent', 'the agent is older than the process that now holds its parent PID');
	});
});

describe('graceful shutdown of a registered Hub', () => {
	const procs = [hub(100, 1_000_000), hub(800, 2_000_000), hub(900, 3_000_000)];
	const context = (): Context => ({ current: { pid: 100, startedAtMs: 1_000_100 }, records: [record(800, 2_000_200, 'C:\\homes\\a')], homeHub: () => ({ pid: 800, startedAtMs: 2_000_200, answers: true }) });
	let stopped = 0;
	const gone = new Set<number>();
	const lister = async () => procs.filter(p => !gone.has(p.pid));
	const connect = (sessions: number) => async () => ({ sessions, stop: async () => { stopped++; gone.add(800); } });

	it('only offers it for a registered Hub that answers, and recommends keeping it', () => {
		const entry = role(classify(procs, context()), 800)!;
		assert.equal(entry.role, 'other-hub');
		assert.equal(entry.canShutdown, true);
		assert.equal(entry.canTerminate, false);
		assert.equal(role(classify(procs, context()), 900)?.canShutdown, undefined, 'an unproven Hub is never offered');
	});

	it('refuses without confirmation, with sessions unless confirmed, for the wrong creation time and for an unproven Hub', async () => {
		const base = { pid: 800, created: 2_000_000 };
		assert.equal((await shutdownInstance({ ...base, confirm: false }, { lister, context, connect: connect(0) })).shutdown, false);
		assert.equal((await shutdownInstance({ ...base, created: 1, confirm: true }, { lister, context, connect: connect(0) })).shutdown, false);
		assert.equal((await shutdownInstance({ pid: 900, created: 3_000_000, confirm: true }, { lister, context, connect: connect(0) })).shutdown, false);
		const busy = await shutdownInstance({ ...base, confirm: true }, { lister, context, connect: connect(2) });
		assert.equal(busy.shutdown, false);
		assert.match((busy as { reason: string }).reason, /2 sessão/);
		assert.equal(stopped, 0, 'nothing was stopped by any refusal');
	});

	it('stops the Hub through its own shutdown once confirmed, and only then', async () => {
		const result = await shutdownInstance({ pid: 800, created: 2_000_000, confirm: true }, { lister, context, connect: connect(0) });
		assert.deepEqual(result, { shutdown: true });
		assert.equal(stopped, 1);
	});
});

describe('safe termination (real fixture processes)', { skip: process.platform !== 'win32' }, () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-procs-'));
	const registry = path.join(dir, 'instances');
	const children: ChildProcess[] = [];
	after(() => { for (const child of children) { try { child.kill(); } catch { /* gone */ } } });

	function fixture(kind: 'hub' | 'foreign'): ChildProcess {
		const script = kind === 'hub' ? path.join(dir, 'singularity-hub', 'dist', 'main.js') : path.join(dir, 'other', 'thing.js');
		fs.mkdirSync(path.dirname(script), { recursive: true });
		fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
		const child = spawn(process.execPath, [script], { stdio: 'ignore', windowsHide: true });
		children.push(child);
		return child;
	}
	const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
	const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

	it('terminates a proven orphan fixture, only after confirmation, and only that process', async () => {
		const orphan = fixture('hub');
		const bystander = fixture('foreign');
		await wait(1500);
		const table = await windowsLister();
		const mine = table.find(p => p.pid === orphan.pid)!;
		registerInstance({ pid: orphan.pid!, startedAtMs: mine.created, home: path.join(dir, 'gone-home'), instanceId: 'fixture', kind: 'isolated', script: 'main.js' }, registry);
		assert.equal(readInstances(registry).length, 1);
		const context = (): Context => ({ current: { pid: 1, startedAtMs: 0 }, records: readInstances(registry), homeHub: () => undefined });
		const deps = { lister: windowsLister, context };
		const found = classify(await windowsLister(), context()).entries.find(entry => entry.pid === orphan.pid)!;
		assert.equal(found.role, 'orphan-hub');
		assert.equal(found.canTerminate, true);

		const noConfirm = await terminate({ pid: orphan.pid!, created: mine.created, confirm: false }, deps);
		assert.equal(noConfirm.terminated, false);
		assert.ok(alive(orphan.pid!), 'nothing happens without confirmation');

		const done = await terminate({ pid: orphan.pid!, created: mine.created, confirm: true }, deps);
		assert.deepEqual(done, { terminated: true });
		assert.ok(!alive(orphan.pid!));
		assert.ok(alive(bystander.pid!), 'a process the Singularity does not own is untouched');
		unregisterInstance(orphan.pid!, registry);
	});

	it('refuses a foreign process, a reused PID and a Hub that is not proven, and leaves them all running', async () => {
		const foreign = fixture('foreign');
		const unproven = fixture('hub');
		const stale = fixture('hub');
		await wait(1500);
		const table = await windowsLister();
		const created = (pid: number) => table.find(p => p.pid === pid)!.created;
		// `stale` has a record, but written for a different creation time (as if the PID had been reused)
		registerInstance({ pid: stale.pid!, startedAtMs: created(stale.pid!) - 3_600_000, home: path.join(dir, 'x'), instanceId: 'stale', kind: 'isolated', script: 'main.js' }, registry);
		const deps = { lister: windowsLister, context: (): Context => ({ current: { pid: 1, startedAtMs: 0 }, records: readInstances(registry), homeHub: () => undefined }) };

		const foreignResult = await terminate({ pid: foreign.pid!, created: created(foreign.pid!), confirm: true }, deps);
		const unprovenResult = await terminate({ pid: unproven.pid!, created: created(unproven.pid!), confirm: true }, deps);
		const staleResult = await terminate({ pid: stale.pid!, created: created(stale.pid!), confirm: true }, deps);
		const wrongTime = await terminate({ pid: unproven.pid!, created: created(unproven.pid!) + 1, confirm: true }, deps);
		for (const result of [foreignResult, unprovenResult, staleResult, wrongTime]) { assert.equal(result.terminated, false); }
		assert.match((wrongTime as { reason: string }).reason, /horário de criação/);
		for (const child of [foreign, unproven, stale]) { assert.ok(alive(child.pid!), 'still running'); }
		assert.equal((await terminate({ pid: process.pid, created: 0, confirm: true }, deps)).terminated, false, 'it never touches its own process');
	});
});
