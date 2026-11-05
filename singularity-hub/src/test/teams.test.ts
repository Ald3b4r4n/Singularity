import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Comparisons } from '../comparisons';
import { Solutions } from '../solutions';
import { Teams, parseFindings } from '../teams';
import { Session } from '../protocol';

async function until(check: () => boolean, timeout = 30000): Promise<void> { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) { throw new Error('Team transition timed out.'); } await new Promise(r => setTimeout(r, 20)); } }
function fixture(correct = false, neverFix = false) {
	const root = mkdtempSync(join(tmpdir(), 'sing-team-')), workspace = join(root, 'repo');
	execFileSync('git', ['init', workspace], { stdio: 'ignore' });
	writeFileSync(join(workspace, '.gitattributes'), '* -text\n'); writeFileSync(join(workspace, 'sum.cjs'), 'module.exports=(a,b)=>0;\n');
	writeFileSync(join(workspace, 'sum.test.cjs'), "require('node:test').test('sum',()=>require('node:assert/strict').equal(require('./sum.cjs')(2,3),5));\n");
	execFileSync('git', ['-C', workspace, 'add', '.']); execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
	const sessions: Session[] = [], prompts: string[] = [], profileSources: Array<string | undefined> = [];
	let team: Teams;
	const comparisons = new Comparisons(join(root, 'groups'), {
		create: async (directory, service, model, _role, profileWorkspace) => { profileSources.push(profileWorkspace); const s: Session = { id: randomUUID(), harness: service, model, workspace: directory, status: 'idle' }; sessions.push(s); return s; },
		list: () => sessions,
		stop: async id => { sessions.find(s => s.id === id)!.historical = true; },
		prompt: (id, text) => {
			prompts.push(text); const s = sessions.find(s => s.id === id)!; s.status = 'running';
			if (text.includes('LONG-RUN')) { return; }
			setTimeout(() => {
				if (text.startsWith('Papel: implementador')) { writeFileSync(join(s.workspace!, 'sum.cjs'), correct && (neverFix || !text.includes('Feedback verificável')) ? 'module.exports=(a,b)=>a-b;\n' : 'module.exports=(a,b)=>a+b;\n'); s.result = 'Implemented.'; }
				else { const bug = readFileSync(join(s.workspace!, 'sum.cjs'), 'utf8').includes('a-b'); s.result = JSON.stringify({ verdict: bug ? 'changes_requested' : 'approve', summary: bug ? 'Subtraction is wrong.' : 'Correct.', issues: bug ? [{ file: 'sum.cjs', line: 1, severity: 'high', message: 'Use addition.' }] : [], scenarios: ['2 + 3 = 5'] }); }
				s.status = 'done'; comparisons.onSession(s); team.onSession(s);
			}, 10);
		}
	}, () => {});
	const solutions = new Solutions(join(root, 'solutions'), (id, workspace, participant) => comparisons.solutionSource(id, workspace, participant));
	team = new Teams(join(root, 'teams'), comparisons, solutions, () => sessions, () => {});
	const participants = [0, 1, 2].map(() => ({ service: 'opencode', model: { providerID: 'opencode', modelID: 'fixture' } }));
	return { root, workspace, sessions, prompts, profileSources, comparisons, solutions, team, participants };
}

test('team runs sequential roles with separate identical-model sessions, immutable snapshots and real independent tests', async () => {
	const f = fixture(); const run = await f.team.start({ workspace: f.workspace, text: 'Implement sum.', participants: f.participants });
	await until(() => f.team.list(run.workspace)[0].state === 'awaiting-validation');
	const assessed = f.team.list(run.workspace)[0]; assert.equal(assessed.steps.length, 3); assert.deepEqual(f.profileSources, Array(3).fill(realpathSync.native(f.workspace))); assert.equal(assessed.versions.length, 1);
	assert.equal(assessed.versions[0].review?.verdict, 'approve'); assert.equal(assessed.versions[0].testPlan?.verdict, 'approve');
	assert.equal(readFileSync(join(f.workspace, 'sum.cjs'), 'utf8'), 'module.exports=(a,b)=>0;\n');
	const completed = await f.team.validate(run.id, run.workspace, { executable: process.execPath, args: ['--test'], approved: true });
	assert.equal(completed.state, 'completed'); assert(Number.isFinite(completed.finishedAt)); assert.equal(completed.versions[0].validation?.exitCode, 0);
	f.team.choose(run.id, run.workspace); const prepared = await f.team.prepare(run.id, run.workspace) as { integrity: boolean };
	assert.equal(prepared.integrity, true); assert.equal(f.prompts.length, 3); assert(f.sessions.every(s => s.historical));
	const beforeRecovery = f.team.list(run.workspace)[0]; const recovered = new Teams(join(f.root, 'teams'), f.comparisons, f.solutions, () => f.sessions, () => {}); await recovered.recover();
	assert.equal(recovered.list(run.workspace)[0].finishedAt, completed.finishedAt); assert.equal(recovered.list(run.workspace)[0].updatedAt, beforeRecovery.updatedAt); assert.equal(f.prompts.length, 3);
});

test('review feedback corrects the actual defect, versions reports and invalidates the old review', async () => {
	const f = fixture(true); const run = await f.team.start({ workspace: f.workspace, text: 'Implement correct sum.', participants: f.participants });
	await until(() => f.team.list(run.workspace)[0].state === 'awaiting-validation');
	const result = f.team.list(run.workspace)[0]; assert.equal(result.cycle, 1); assert.equal(result.versions.length, 2);
	assert.equal(result.versions[0].stale, true); assert.equal(result.versions[0].review?.issues[0].file, 'sum.cjs');
	assert.equal(result.versions[1].review?.verdict, 'approve'); assert.notEqual(result.versions[0].tree, result.versions[1].tree);
	assert.equal(f.prompts.length, 5);
});

test('structured opinions cannot forge independent tests and malformed reports are rejected', () => {
	assert.throws(() => parseFindings('approved, trust me'), /JSON/);
	assert.throws(() => parseFindings('{"verdict":"approve","summary":"ok","issues":[{"file":"a","severity":"unknown","message":"x"}]}'), /inválido/);
	assert.equal(parseFindings('{"verdict":"approve","summary":"ok","issues":[{"file":"sum.cjs","severity":"high","message":"bad"}]}').verdict, 'changes_requested');
});

test('the two-correction limit ends truthfully and all idle helper contexts close', async () => {
	const f = fixture(true, true); const run = await f.team.start({ workspace: f.workspace, text: 'Implement sum.', participants: f.participants, maxCorrections: 2 });
	await until(() => f.team.list(run.workspace)[0].state === 'exhausted', 50000);
	const ended = f.team.list(run.workspace)[0]; assert.equal(ended.cycle, 2); assert.equal(ended.versions.length, 3); assert.equal(f.prompts.length, 6);
	assert(f.sessions.every(s => s.historical)); assert.throws(() => f.team.choose(run.id, run.workspace), /Conclua/);
});

test('recovered live steps require explicit resume and never resend the prompt; individual and general cancellation are independent', async () => {
	const f = fixture(); const run = await f.team.start({ workspace: f.workspace, text: 'LONG-RUN', participants: f.participants });
	const next = new Teams(join(f.root, 'teams'), f.comparisons, f.solutions, () => f.sessions, () => {}); await next.recover();
	assert.equal(next.list(run.workspace)[0].state, 'paused');
	await next.resume(run.id, run.workspace); assert.equal(f.prompts.length, 1);
	await next.cancel(run.id, run.workspace, 'implementer'); assert.equal(next.list(run.workspace)[0].state, 'paused');
	await assert.rejects(next.resume(run.id, run.workspace), /insegura/);
	await next.cancel(run.id, run.workspace); assert.equal(next.list(run.workspace)[0].state, 'cancelled'); assert(f.sessions.every(s => s.historical));
});
