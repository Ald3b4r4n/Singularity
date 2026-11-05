import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Solutions, safeSolutionPath } from '../solutions';
import { Comparison, Participant } from '../comparisons';

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), 'sing-solution-'));
	const workspace = join(directory, 'main');
	const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-C', workspace, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
	execFileSync('git', ['init', workspace], { stdio: 'ignore' });
	writeFileSync(join(workspace, 'sample.txt'), 'base\n');
	writeFileSync(join(workspace, 'removed.txt'), 'remove\n');
	writeFileSync(join(workspace, 'check.test.cjs'), "const assert=require('node:assert/strict');const fs=require('node:fs');require('node:test').test('solution',()=>assert.equal(fs.readFileSync('sample.txt','utf8'),'solution\\n'));\n");
	git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base');
	const source = join(directory, 'source'); git('worktree', 'add', '--detach', source, 'HEAD');
	const p: Participant = { id: randomUUID(), service: 'codex-cli', model: { providerID: 'codex-cli', modelID: 'test' }, workspace: source, status: 'done' };
	const comparison: Comparison = { id: randomUUID(), workspace, base: git('rev-parse', 'HEAD'), selected: p.id, participants: [p], prompt: 'synthetic', createdAt: Date.now() };
	const store = join(directory, 'solutions');
	const origin = async () => ({ comparison, participant: p });
	const solutions = new Solutions(store, origin);
	return { directory, workspace, source, comparison, p, solutions, git, store, origin };
}

test('preparation snapshots complete changes including large new files and binary data, verifies a Git patch and runs authorized tests', async () => {
	const f = fixture();
	writeFileSync(join(f.source, 'sample.txt'), 'solution\n');
	writeFileSync(join(f.source, 'large.txt'), 'x'.repeat(100000));
	writeFileSync(join(f.source, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
	execFileSync('git', ['-C', f.source, 'rm', 'removed.txt'], { stdio: 'ignore' });
	const record = await f.solutions.prepare(f.comparison.id, f.workspace, f.p.id);
	assert.equal(record.files.length, 4);
	assert.equal(record.integrity, true);
	assert.equal(record.validation.state, 'unavailable');
	assert(record.files.some(file => file.binary));
	assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), 'base\n');
	assert.equal(f.git('status', '--porcelain'), '');
	const result = await f.solutions.validate(record.id, f.workspace, { executable: process.execPath, args: ['--test'], approved: true });
	assert.equal(result.validation.state, 'passed', result.validation.output);
	assert.equal(result.validation.exitCode, 0);
	const review = await f.solutions.review(record.id, f.workspace) as { diff: string; counts: { added: number } };
	assert.match(review.diff, /GIT binary patch/); assert.equal(review.counts.added, 2);
	const reload = new Solutions(f.store, f.origin); await reload.recover();
	assert.equal(reload.list(f.workspace)[0].validation.state, 'passed');
});

test('dirty project, divergent HEAD, unauthorized commands, failed tests and dangerous paths are explicit failures', async () => {
	for (const path of ['../outside', '/absolute', '.git/config', 'a/.GIT/config', 'a\\b', 'file:ads', 'nul.txt', 'a./b']) { assert.throws(() => safeSolutionPath(path)); }
	const f = fixture(); writeFileSync(join(f.source, 'sample.txt'), 'solution\n');
	writeFileSync(join(f.workspace, 'sample.txt'), 'user edit');
	await assert.rejects(f.solutions.prepare(f.comparison.id, f.workspace, f.p.id), /preexistentes/);
	f.git('restore', 'sample.txt');
	const record = await f.solutions.prepare(f.comparison.id, f.workspace, f.p.id);
	await assert.rejects(f.solutions.validate(record.id, f.workspace, { executable: process.execPath, args: ['--test'] }), /Autorize/);
	const failed = await f.solutions.validate(record.id, f.workspace, { executable: process.execPath, args: ['-e', 'process.exit(7)'], approved: true });
	assert.equal(failed.validation.state, 'failed'); assert.equal(failed.validation.exitCode, 7);
	f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'diverge');
	await assert.rejects(f.solutions.prepare(f.comparison.id, f.workspace, f.p.id), /HEAD/);
});

test('links and case collisions cannot become application files', async () => {
	const f = fixture();
	mkdirSync(join(f.source, 'linked'));
	execFileSync('git', ['-C', f.source, 'config', 'core.symlinks', 'true']);
	const outside = join(f.directory, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'data.txt'), 'private');
	symlinkSync(outside, join(f.source, 'junction'), 'junction');
	await assert.rejects(f.solutions.prepare(f.comparison.id, f.workspace, f.p.id), /Links|tipo|Tipo/);
});

test('apply, exact undo and reapply preserve HEAD, index, binaries, additions, removals and independent worktrees', async () => {
	const f = fixture();
	writeFileSync(join(f.source, 'sample.txt'), 'solution\n');
	writeFileSync(join(f.source, 'binary.bin'), Buffer.from([0, 2, 255]));
	execFileSync('git', ['-C', f.source, 'rm', 'removed.txt'], { stdio: 'ignore' });
	const record = await f.solutions.prepare(f.comparison.id, f.workspace, f.p.id);
	const confirmed = { confirmed: true, patchHash: record.patchHash, allowUntested: true };
	await assert.rejects(f.solutions.apply(record.id, f.workspace, { ...confirmed, confirmed: false }), /confirme/);
	assert.equal((await f.solutions.apply(record.id, f.workspace, confirmed)).state, 'applied');
	assert.equal(f.git('rev-parse', 'HEAD'), record.base); assert.equal(f.git('diff', '--cached', '--name-only'), '');
	assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), 'solution\n');
	assert.deepEqual(readFileSync(join(f.workspace, 'binary.bin')), Buffer.from([0, 2, 255]));
	assert.equal((await f.solutions.apply(record.id, f.workspace, confirmed)).state, 'applied');
	await f.solutions.undo(record.id, f.workspace); assert.equal(f.git('status', '--porcelain'), '');
	assert.equal((await f.solutions.validate(record.id, f.workspace, { executable: process.execPath, args: ['--test'], approved: true })).validation.state, 'passed');
	assert.equal(readFileSync(join(f.source, 'sample.txt'), 'utf8'), 'solution\n');
	await f.solutions.apply(record.id, f.workspace, confirmed);
	writeFileSync(join(f.workspace, 'sample.txt'), 'user changed after apply\n');
	await assert.rejects(f.solutions.undo(record.id, f.workspace), /Conflito/);
	assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), 'user changed after apply\n');
});

test('partial application failure rolls back without reset and stale preparation refuses every write', async () => {
	const f = fixture(); writeFileSync(join(f.source, 'sample.txt'), 'solution\n'); writeFileSync(join(f.source, 'added.txt'), 'new');
	const solutions = new Solutions(f.store, f.origin, () => { throw new Error('Injected write failure.'); });
	const record = await solutions.prepare(f.comparison.id, f.workspace, f.p.id);
	await assert.rejects(solutions.apply(record.id, f.workspace, { confirmed: true, patchHash: record.patchHash, allowUntested: true }), /Injected/);
	assert.equal(f.git('status', '--porcelain'), '');
	assert.equal(solutions.list(f.workspace)[0].state, 'rolled-back');
	writeFileSync(join(f.source, 'sample.txt'), 'changed after review\n');
	await assert.rejects(solutions.apply(record.id, f.workspace, { confirmed: true, patchHash: record.patchHash, allowUntested: true }), /solução selecionada mudou/);
	assert.equal(f.git('status', '--porcelain'), '');
});

test('Hub-process interruption after a real write is recovered from the persistent journal without a second application', async () => {
	const f = fixture(); writeFileSync(join(f.source, 'sample.txt'), 'solution\n'); writeFileSync(join(f.source, 'added.txt'), 'new');
	const record = await f.solutions.prepare(f.comparison.id, f.workspace, f.p.id);
	const modulePath = join(__dirname, '..', 'solutions.js');
	const code = `const {Solutions}=require(process.argv[1]);const c=JSON.parse(process.argv[3]),p=JSON.parse(process.argv[4]);const s=new Solutions(process.argv[2],async()=>({comparison:c,participant:p}),()=>process.exit(91));(async()=>{await s.recover();await s.apply(process.argv[5],c.workspace,{confirmed:true,patchHash:process.argv[6],allowUntested:true});})().catch(e=>{console.error(e);process.exit(1)});`;
	try { execFileSync(process.execPath, ['-e', code, modulePath, f.store, JSON.stringify(f.comparison), JSON.stringify(f.p), record.id, record.patchHash], { stdio: 'pipe' }); assert.fail('child must exit during application'); }
	catch (error) { assert.equal((error as { status: number }).status, 91); }
	assert.notEqual(f.git('status', '--porcelain'), '');
	const recovered = new Solutions(f.store, f.origin); await recovered.recover();
	assert.equal(recovered.list(f.workspace)[0].state, 'rolled-back');
	assert.equal(f.git('status', '--porcelain'), '');
	assert.equal(f.git('rev-parse', 'HEAD'), record.base);
});

test('interrupted rollback resumes from verified preserved files and keeps unrelated user changes', async () => {
	const f = fixture(); writeFileSync(join(f.source, 'sample.txt'), 'solution\n');
	const record = await f.solutions.prepare(f.comparison.id, f.workspace, f.p.id);
	await f.solutions.apply(record.id, f.workspace, { confirmed: true, patchHash: record.patchHash, allowUntested: true });
	const code = `const {Solutions}=require(process.argv[1]);const c=JSON.parse(process.argv[3]),p=JSON.parse(process.argv[4]);const s=new Solutions(process.argv[2],async()=>({comparison:c,participant:p}));(async()=>{await s.recover();const fs=require('node:fs').promises,rename=fs.rename;fs.rename=async(a,b)=>{await rename(a,b);process.exit(92);};await s.undo(process.argv[5],c.workspace);})().catch(e=>{console.error(e);process.exit(1)});`;
	try { execFileSync(process.execPath, ['-e', code, join(__dirname, '..', 'solutions.js'), f.store, JSON.stringify(f.comparison), JSON.stringify(f.p), record.id], { stdio: 'pipe' }); assert.fail('child must exit during rollback'); }
	catch (error) { assert.equal((error as { status: number }).status, 92); }
	writeFileSync(join(f.workspace, 'user-note.txt'), 'preserved');
	const recovered = new Solutions(f.store, f.origin); await recovered.recover();
	assert.equal(recovered.list(f.workspace)[0].state, 'rolled-back');
	assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), 'base\n');
	assert.equal(readFileSync(join(f.workspace, 'user-note.txt'), 'utf8'), 'preserved');
});

test('preparation includes more files than the comparison preview limit', async () => {
	const f = fixture();
	for (let i = 0; i < 105; i++) { writeFileSync(join(f.source, `new-${i}.txt`), 'new'); }
	const record = await f.solutions.prepare(f.comparison.id, f.workspace, f.p.id);
	assert.equal(record.files.length, 105);
	assert.equal(f.git('status', '--porcelain'), '');
});

test('a staged index change, patch corruption and failed independent validation block application before mutation', async () => {
	const f = fixture(); writeFileSync(join(f.source, 'sample.txt'), 'solution\n');
	const record = await f.solutions.prepare(f.comparison.id, f.workspace, f.p.id);
	const confirmation = { confirmed: true, patchHash: record.patchHash, allowUntested: true };
	writeFileSync(join(f.workspace, 'user.txt'), 'preserve'); f.git('add', 'user.txt');
	await assert.rejects(f.solutions.apply(record.id, f.workspace, confirmation), /índice/);
	assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), 'base\n');
	assert.equal(readFileSync(join(f.workspace, 'user.txt'), 'utf8'), 'preserve');
	const g = fixture(); writeFileSync(join(g.source, 'sample.txt'), 'solution\n');
	const prepared = await g.solutions.prepare(g.comparison.id, g.workspace, g.p.id);
	await g.solutions.validate(prepared.id, g.workspace, { executable: process.execPath, args: ['-e', 'process.exit(3)'], approved: true });
	await assert.rejects(g.solutions.apply(prepared.id, g.workspace, { confirmed: true, patchHash: prepared.patchHash, allowUntested: true }), /validação independente/);
	writeFileSync(join(g.store, prepared.id, 'solution.patch'), 'corrupt');
	await assert.rejects(g.solutions.review(prepared.id, g.workspace), /patch preparado/);
	assert.equal(g.git('status', '--porcelain'), '');
});

test('explicit Windows file ACLs are rejected rather than replaced by inherited permissions', async () => {
	const f = fixture(); writeFileSync(join(f.source, 'sample.txt'), 'solution\n');
	const { currentWindowsUser } = await import('../secure');
	execFileSync(join(process.env.SystemRoot!, 'System32', 'icacls.exe'), [join(f.source, 'sample.txt'), '/grant:r', '*' + currentWindowsUser().sid + ':F'], { stdio: 'ignore' });
	await assert.rejects(f.solutions.prepare(f.comparison.id, f.workspace, f.p.id), /ACL específica/);
	assert.equal(f.git('status', '--porcelain'), '');
});

test('NTFS alternate streams are preserved by rejecting unsupported file metadata before application', async () => {
	const f = fixture(); writeFileSync(join(f.source, 'sample.txt'), 'solution\n');
	writeFileSync(join(f.workspace, 'sample.txt') + ':private', 'preserve metadata');
	await assert.rejects(f.solutions.prepare(f.comparison.id, f.workspace, f.p.id), /NTFS não suportados/);
	assert.equal(readFileSync(join(f.workspace, 'sample.txt') + ':private', 'utf8'), 'preserve metadata');
	assert.equal(readFileSync(join(f.workspace, 'sample.txt'), 'utf8'), 'base\n');
});
