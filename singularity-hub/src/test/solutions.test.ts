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
