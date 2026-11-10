import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Comparison, Comparisons, Participant } from '../comparisons';
import { clearLineEndingCache, eolStyle, lineEndingArgs } from '../gitconfig';
import { Session } from '../protocol';
import { Solutions } from '../solutions';

// A Windows machine as Git for Windows leaves it: core.autocrlf=true in the person's global configuration. Working files are CRLF, blobs are LF.
const fakeHome = mkdtempSync(join(tmpdir(), 'sing-eol-home-'));
writeFileSync(join(fakeHome, '.gitconfig'), '[core]\n\tautocrlf = true\n');
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

const BINARY = Buffer.from([0, 13, 10, 1, 13, 10]);
const FILES: Record<string, string | Buffer> = {
	'sample.txt': 'base\nline two\n', 'other.txt': 'keep\nme\n', 'removed.txt': 'remove\n', 'keep.txt': 'rename me\n',
	'mixed.txt': 'one\r\ntwo\nthree\r\n', 'binary.bin': BINARY, '.gitattributes': '*.sh text eol=lf\n*.dat -text\n',
	'run.sh': '#!/bin/sh\necho hi\n', 'data.dat': 'a\r\nb\r\n'
};

function project() {
	const directory = mkdtempSync(join(tmpdir(), 'sing-eol-'));
	const workspace = join(directory, 'main');
	const exact = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-C', workspace, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
	const person = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
	execFileSync('git', ['init', '-q', workspace], { stdio: 'ignore' });
	for (const [name, content] of Object.entries(FILES)) { writeFileSync(join(workspace, name), content); }
	exact('add', '.'); exact('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'base');
	// check the project out again the way the person's Git does: text files become CRLF
	person(workspace, 'rm', '--cached', '-r', '-q', '.'); person(workspace, 'reset', '--hard', '-q');
	const source = join(directory, 'source');
	person(workspace, 'worktree', 'add', '-q', '--detach', source, 'HEAD');
	const p: Participant = { id: randomUUID(), service: 'codex-cli', model: { providerID: 'codex-cli', modelID: 'test' }, workspace: source, status: 'done' };
	const comparison: Comparison = { id: randomUUID(), workspace, base: exact('rev-parse', 'HEAD'), selected: p.id, participants: [p], prompt: 'synthetic', createdAt: Date.now() };
	const store = join(directory, 'solutions');
	const origin = async () => ({ comparison, participant: p });
	const bytes = (root: string): Record<string, string> => Object.fromEntries(readdirSync(root).filter(name => name !== '.git').sort().map(name => [name, readFileSync(join(root, name)).toString('hex')]));
	return { directory, workspace, source, comparison, p, store, origin, person, bytes, solutions: new Solutions(store, origin), status: () => person(workspace, 'status', '--porcelain').split('\n').filter(Boolean).sort() };
}
const confirm = (record: { patchHash: string }) => ({ confirmed: true, patchHash: record.patchHash, allowUntested: true });

describe('line endings on a Windows checkout (core.autocrlf=true)', { timeout: 300000 }, () => {
	before(() => { Object.assign(process.env, { HOME: fakeHome, USERPROFILE: fakeHome, XDG_CONFIG_HOME: join(fakeHome, 'xdg') }); clearLineEndingCache(); });
	after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } } clearLineEndingCache(); });

	it('reads the effective setting, and only that, without writing any configuration', async () => {
		const f = project();
		assert.deepEqual(await lineEndingArgs(f.workspace), ['-c', 'core.autocrlf=true']);
		assert.equal(readFileSync(join(fakeHome, '.gitconfig'), 'utf8'), '[core]\n\tautocrlf = true\n', 'the global configuration is untouched');
		assert.doesNotMatch(readFileSync(join(f.workspace, '.git', 'config'), 'utf8'), /autocrlf/, 'and nothing was written to the repository');
		assert.equal(eolStyle(Buffer.from('a\r\nb\r\n')), 'crlf'); assert.equal(eolStyle(Buffer.from('a\nb\n')), 'lf');
		assert.equal(eolStyle(Buffer.from('a\r\nb\n')), 'mixed'); assert.equal(eolStyle(Buffer.from('ab')), 'none'); assert.equal(eolStyle(BINARY), 'binary');
	});

	it('the fixture is a real CRLF checkout: text is CRLF, eol=lf and -text files and the binary keep their bytes, and it is clean', () => {
		const f = project();
		assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), 'base\r\nline two\r\n');
		assert.equal(readFileSync(join(f.workspace, 'run.sh'), 'utf8'), '#!/bin/sh\necho hi\n');
		assert.equal(readFileSync(join(f.workspace, 'data.dat'), 'utf8'), 'a\r\nb\r\n');
		assert.equal(readFileSync(join(f.workspace, 'mixed.txt'), 'utf8'), 'one\r\ntwo\nthree\r\n');
		assert.deepEqual(readFileSync(join(f.workspace, 'binary.bin')), BINARY);
		assert.deepEqual(f.status(), []);
		assert.deepEqual(f.bytes(f.source), f.bytes(f.workspace), 'the worktree holds the same bytes as the project');
	});

	it('comparison worktrees hold the same bytes as the project and are clean for every later check', async () => {
		const f = project();
		const sessions: Session[] = [];
		const adapter = { create: async (directory: string, service: string) => { const session: Session = { id: randomUUID(), workspace: directory, harness: service, status: 'idle' }; sessions.push(session); return session; }, prompt: () => { /* no agent */ }, stop: async () => { /* nothing */ }, list: () => sessions };
		const coordinator = new Comparisons(join(f.directory, 'comparisons'), adapter, () => { /* no events */ });
		const run = await coordinator.create({ workspace: f.workspace, text: 'Read.', participants: ['claude-code', 'codex-cli'].map(service => ({ service, model: { providerID: service, modelID: 'test' } })) });
		for (const participant of run.participants) {
			assert.deepEqual(f.bytes(participant.workspace), f.bytes(f.workspace), 'same bytes as the project');
			assert.equal(f.person(participant.workspace, 'status', '--porcelain'), '', 'clean');
		}
	});

	it('accepts a clean CRLF project, takes only the real changes, shows no line-ending noise and applies the exact bytes', async () => {
		const f = project();
		const original = f.bytes(f.workspace);
		writeFileSync(join(f.source, 'sample.txt'), 'solution\r\nline two\r\n');
		writeFileSync(join(f.source, 'new.txt'), 'brand new\r\n');
		f.person(f.source, 'rm', '-q', 'removed.txt');
		renameSync(join(f.source, 'keep.txt'), join(f.source, 'renamed.txt'));
		writeFileSync(join(f.source, 'mixed.txt'), 'one\r\ntwo\nthree\r\nfour\n');
		writeFileSync(join(f.source, 'binary.bin'), Buffer.from([0, 13, 10, 9, 13, 10]));
		writeFileSync(join(f.source, 'run.sh'), '#!/bin/sh\necho solution\n');
		const record = await f.solutions.prepare(f.comparison.id, f.workspace, f.p.id);
		assert.deepEqual(record.files.map(file => `${file.kind}:${file.path}`).sort(), ['added:new.txt', 'added:renamed.txt', 'modified:binary.bin', 'modified:mixed.txt', 'modified:run.sh', 'modified:sample.txt', 'removed:keep.txt', 'removed:removed.txt']);
		assert.equal(record.eolOnly, undefined);
		assert.ok(record.files.every(file => !file.eolChanged), 'no file changed its line-ending style');
		const review = await f.solutions.review(record.id, f.workspace) as { diff: string; renames: string };
		assert.match(review.diff, /-base\n\+solution\n/); assert.doesNotMatch(review.diff, /[-+]line two/, 'the unchanged line is not in the diff');
		assert.doesNotMatch(review.diff, /^[-+][^\n]*\r$/m, 'no added or removed line differs only by a carriage return');
		assert.match(review.diff, /\n one\r\n two\n three\r\n\+four\n/, 'a file that is mixed in the repository keeps its lines as they are: only the new line is a change');
		assert.match(review.renames, /R\d*\tkeep\.txt\trenamed\.txt/);
		assert.deepEqual(f.bytes(f.workspace), original, 'preparing changes nothing in the project');

		assert.equal((await f.solutions.apply(record.id, f.workspace, confirm(record))).state, 'applied');
		const applied = f.bytes(f.workspace), wanted = f.bytes(f.source);
		assert.deepEqual(applied, wanted, 'every file of the project now has exactly the bytes of the solution');
		assert.equal(readFileSync(join(f.workspace, 'other.txt'), 'utf8'), 'keep\r\nme\r\n', 'an untouched file keeps its CRLF bytes');
		assert.deepEqual(f.status(), [' D keep.txt', ' D removed.txt', ' M binary.bin', ' M mixed.txt', ' M run.sh', ' M sample.txt', '?? new.txt', '?? renamed.txt'].sort(), 'the person\'s Git sees only the real changes');

		await f.solutions.undo(record.id, f.workspace);
		assert.deepEqual(f.bytes(f.workspace), original, 'rollback restores every byte, including removals and the rename');
		assert.deepEqual(f.status(), []);
	});

	it('a file the solution only re-wrote with other line endings is not a change: it is left out, named, and the project keeps its bytes', async () => {
		const f = project();
		writeFileSync(join(f.source, 'other.txt'), 'keep\nme\n');
		writeFileSync(join(f.source, 'run.sh'), '#!/bin/sh\r\necho hi\r\n');
		await assert.rejects(f.solutions.prepare(f.comparison.id, f.workspace, f.p.id), /não contém alterações aplicáveis/, 'only conversions: there is no solution to apply');
		writeFileSync(join(f.source, 'sample.txt'), 'solution\r\nline two\r\n');
		const record = await f.solutions.prepare(f.comparison.id, f.workspace, f.p.id);
		assert.deepEqual(record.files.map(file => file.path), ['sample.txt']);
		assert.deepEqual([...(record.eolOnly ?? [])].sort(), ['other.txt', 'run.sh']);
		await f.solutions.apply(record.id, f.workspace, confirm(record));
		assert.equal(readFileSync(join(f.workspace, 'other.txt'), 'utf8'), 'keep\r\nme\r\n');
		assert.equal(readFileSync(join(f.workspace, 'run.sh'), 'utf8'), '#!/bin/sh\necho hi\n');
		assert.deepEqual(f.status(), [' M sample.txt']);
	});

	it('a real change that also switches the style is applied as written, never converted silently, and is flagged for the review', async () => {
		const f = project();
		const original = f.bytes(f.workspace);
		writeFileSync(join(f.source, 'sample.txt'), 'solution\nline two\n');
		writeFileSync(join(f.source, 'data.dat'), 'a\nb\n');
		const record = await f.solutions.prepare(f.comparison.id, f.workspace, f.p.id);
		assert.deepEqual(record.files.map(file => file.path).sort(), ['data.dat', 'sample.txt'], 'a -text file has no line endings to Git: its bytes changed, so it is a change');
		assert.deepEqual(record.files.find(file => file.path === 'sample.txt')!.eolChanged, { from: 'crlf', to: 'lf' });
		await f.solutions.apply(record.id, f.workspace, confirm(record));
		assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), 'solution\nline two\n', 'exactly what the solution wrote');
		await f.solutions.undo(record.id, f.workspace);
		assert.deepEqual(f.bytes(f.workspace), original);
	});

	it('still refuses a project that was really modified, and a destination that changed after the review', async () => {
		const f = project();
		writeFileSync(join(f.source, 'sample.txt'), 'solution\r\nline two\r\n');
		writeFileSync(join(f.workspace, 'other.txt'), 'keep\r\nme and my edit\r\n');
		await assert.rejects(f.solutions.prepare(f.comparison.id, f.workspace, f.p.id), /preexistentes/);
		f.person(f.workspace, 'checkout', '-q', '--', 'other.txt');
		writeFileSync(join(f.workspace, 'untracked.txt'), 'mine');
		await assert.rejects(f.solutions.prepare(f.comparison.id, f.workspace, f.p.id), /preexistentes/, 'an untracked file is a modification too');
		execFileSync('cmd.exe', ['/c', 'del', join(f.workspace, 'untracked.txt')], { stdio: 'ignore' });
		const record = await f.solutions.prepare(f.comparison.id, f.workspace, f.p.id);
		writeFileSync(join(f.workspace, 'sample.txt'), 'base\nline two\n');
		await assert.rejects(f.solutions.apply(record.id, f.workspace, confirm(record)), /preexistentes|destino mudou|mudou/, 'even a line-ending-only edit made by the person after the review is a concurrent change');
		assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), 'base\nline two\n', 'and it is not overwritten');
	});

	it('a failure in the middle of the application puts back every CRLF byte', async () => {
		const f = project();
		const original = f.bytes(f.workspace);
		writeFileSync(join(f.source, 'sample.txt'), 'solution\r\nline two\r\n'); writeFileSync(join(f.source, 'other.txt'), 'keep\r\nme too\r\n'); writeFileSync(join(f.source, 'added.txt'), 'new\r\n');
		const failing = new Solutions(f.store, f.origin, index => { if (index === 1) { throw new Error('Injected write failure.'); } });
		const record = await failing.prepare(f.comparison.id, f.workspace, f.p.id);
		await assert.rejects(failing.apply(record.id, f.workspace, confirm(record)), /Injected/);
		assert.equal(failing.list(f.workspace)[0].state, 'rolled-back');
		assert.deepEqual(f.bytes(f.workspace), original);
		assert.deepEqual(f.status(), []);
	});

	it('a Hub that dies during the application recovers the CRLF project byte for byte from its journal', async () => {
		const f = project();
		const original = f.bytes(f.workspace);
		writeFileSync(join(f.source, 'sample.txt'), 'solution\r\nline two\r\n'); writeFileSync(join(f.source, 'added.txt'), 'new\r\n');
		const record = await f.solutions.prepare(f.comparison.id, f.workspace, f.p.id);
		const code = `const {Solutions}=require(process.argv[1]);const c=JSON.parse(process.argv[3]),p=JSON.parse(process.argv[4]);const s=new Solutions(process.argv[2],async()=>({comparison:c,participant:p}),()=>process.exit(91));(async()=>{await s.recover();await s.apply(process.argv[5],c.workspace,{confirmed:true,patchHash:process.argv[6],allowUntested:true});})().catch(e=>{console.error(e);process.exit(1)});`;
		try { execFileSync(process.execPath, ['-e', code, join(__dirname, '..', 'solutions.js'), f.store, JSON.stringify(f.comparison), JSON.stringify(f.p), record.id, record.patchHash], { stdio: 'pipe' }); assert.fail('the child must exit during the application'); }
		catch (error) { assert.equal((error as { status: number }).status, 91); }
		assert.notDeepEqual(f.bytes(f.workspace), original, 'something was really written before the Hub died');
		const recovered = new Solutions(f.store, f.origin); await recovered.recover();
		assert.equal(recovered.list(f.workspace)[0].state, 'rolled-back');
		assert.deepEqual(f.bytes(f.workspace), original);
		assert.ok(!existsSync(join(f.workspace, 'added.txt')));
	});
});

describe('line endings on an LF checkout (no autocrlf)', { timeout: 120000 }, () => {
	it('nothing changes for a project without the setting: LF bytes in, LF bytes out, exact rollback', async () => {
		const noConfig = mkdtempSync(join(tmpdir(), 'sing-eol-nohome-'));
		// the global setting says so explicitly: a machine-wide (system) autocrlf must not leak into this case
		writeFileSync(join(noConfig, '.gitconfig'), '[core]\n\tautocrlf = false\n');
		const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
		Object.assign(process.env, { HOME: noConfig, USERPROFILE: noConfig, XDG_CONFIG_HOME: join(noConfig, 'xdg') }); clearLineEndingCache();
		try {
			const f = project();
			assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), 'base\nline two\n', 'an LF checkout');
			const original = f.bytes(f.workspace);
			writeFileSync(join(f.source, 'sample.txt'), 'solution\nline two\n'); writeFileSync(join(f.source, 'new.txt'), 'new\n');
			const record = await f.solutions.prepare(f.comparison.id, f.workspace, f.p.id);
			assert.deepEqual(record.files.map(file => file.path).sort(), ['new.txt', 'sample.txt']); assert.equal(record.eolOnly, undefined);
			await f.solutions.apply(record.id, f.workspace, confirm(record));
			assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), 'solution\nline two\n');
			await f.solutions.undo(record.id, f.workspace);
			assert.deepEqual(f.bytes(f.workspace), original);
		} finally {
			for (const [key, value] of Object.entries(previous)) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } }
			clearLineEndingCache();
		}
	});
});
