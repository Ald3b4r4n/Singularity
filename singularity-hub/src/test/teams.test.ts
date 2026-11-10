import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Comparisons } from '../comparisons';
import { Solutions } from '../solutions';
import { Teams, parseFindings } from '../teams';
import { Session } from '../protocol';
import type { ExecutionPolicy } from '../executionPolicy';

async function until(check: () => boolean, timeout = 30000): Promise<void> { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) { throw new Error('Team transition timed out.'); } await new Promise(r => setTimeout(r, 20)); } }
function fixture(correct = false, neverFix = false, policy?: ExecutionPolicy, usesTerminal = false) {
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
				if (text.startsWith('Papel: implementador') && usesTerminal) {
					// what an agent with a terminal leaves behind: installed dependencies, a build folder the project ignores, and a commit of its own
					mkdirSync(join(s.workspace!, 'node_modules', 'dep'), { recursive: true }); writeFileSync(join(s.workspace!, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
					mkdirSync(join(s.workspace!, 'out'), { recursive: true }); writeFileSync(join(s.workspace!, 'out', 'bundle.js'), '// built\n'); writeFileSync(join(s.workspace!, '.gitignore'), 'out/\n');
					writeFileSync(join(s.workspace!, 'sum.cjs'), 'module.exports=(a,b)=>a+b;\n');
					execFileSync('git', ['-C', s.workspace!, 'add', 'sum.cjs']); execFileSync('git', ['-C', s.workspace!, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.invalid', 'commit', '-qm', 'work in progress']);
					writeFileSync(join(s.workspace!, 'notes.md'), 'Ran the tests: 1 passed.\n'); s.result = 'Implemented and tested.';
				}
				else if (text.startsWith('Papel: implementador')) { writeFileSync(join(s.workspace!, 'sum.cjs'), correct && (neverFix || !text.includes('Feedback verificável')) ? 'module.exports=(a,b)=>a-b;\n' : 'module.exports=(a,b)=>a+b;\n'); s.result = 'Implemented.'; }
				else { const bug = readFileSync(join(s.workspace!, 'sum.cjs'), 'utf8').includes('a-b'); s.result = JSON.stringify({ verdict: bug ? 'changes_requested' : 'approve', summary: bug ? 'Subtraction is wrong.' : 'Correct.', issues: bug ? [{ file: 'sum.cjs', line: 1, severity: 'high', message: 'Use addition.' }] : [], scenarios: ['2 + 3 = 5'] }); }
				s.status = 'done'; comparisons.onSession(s); team.onSession(s);
			}, 10);
		}
	}, () => {});
	const solutions = new Solutions(join(root, 'solutions'), (id, workspace, participant) => comparisons.solutionSource(id, workspace, participant));
	team = new Teams(join(root, 'teams'), comparisons, solutions, () => sessions, () => {}, policy ? () => ({ ...policy }) : undefined);
	const participants = [0, 1, 2].map(() => ({ service: 'opencode', model: { providerID: 'opencode', modelID: 'fixture' } }));
	return { root, workspace, sessions, prompts, profileSources, comparisons, solutions, team, participants };
}

test('team runs sequential roles with separate identical-model sessions, immutable snapshots and real independent tests', async () => {
	const f = fixture(); const run = await f.team.start({ workspace: f.workspace, text: 'Implement sum.', participants: f.participants });
	await until(() => f.team.list(run.workspace)[0].state === 'awaiting-validation');
	const assessed = f.team.list(run.workspace)[0]; assert.equal(assessed.steps.length, 3); assert.deepEqual(f.profileSources, Array(3).fill(realpathSync.native(f.workspace))); assert.equal(assessed.versions.length, 1);
	assert.equal(assessed.versions[0].review?.verdict, 'approve'); assert.equal(assessed.versions[0].testPlan?.verdict, 'approve');
	assert.match(f.prompts[0], /Não execute comandos de shell, testes ou outras CLIs nesta etapa\./, 'a workspace without a policy keeps the earlier prohibition'); assert.equal(assessed.policy?.mode, 'restricted');
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

test('a new instruction after a delivered version starts one more cycle on top of it, and a stopped team can be deleted', async () => {
	const f = fixture(); const run = await f.team.start({ workspace: f.workspace, text: 'Implement sum.', participants: f.participants, maxCorrections: 0 });
	await assert.rejects(f.team.instruct(run.id, run.workspace, 'Too early.'), /depois de entregar/);
	await until(() => f.team.list(run.workspace)[0].state === 'awaiting-validation');
	await assert.rejects(f.team.instruct(run.id, run.workspace, '   '), /nova instrução/);
	const before = f.prompts.length;
	await f.team.instruct(run.id, run.workspace, 'Also publish it.');
	await until(() => f.team.list(run.workspace)[0].state === 'awaiting-validation' && f.team.list(run.workspace)[0].versions.length === 2);
	const again = f.team.list(run.workspace)[0];
	assert.equal(again.cycle, 1); assert.equal(again.versions[0].stale, true); assert.equal(again.followUps?.[0].text, 'Also publish it.');
	assert.match(again.task, /Implement sum\.[\s\S]*Instrução adicional do usuário:\nAlso publish it\./);
	assert.match(f.prompts[before], /^Papel: implementador[\s\S]*Nova instrução do usuário[\s\S]*Also publish it\./);
	assert.ok(f.prompts.slice(before + 1).every(prompt => prompt.includes('Also publish it.')), 'the reviewer and the tester judge against the new instruction too');
	assert.equal(f.prompts.length, before + 3);
	assert.equal(readFileSync(join(f.workspace, 'sum.cjs'), 'utf8'), 'module.exports=(a,b)=>0;\n', 'the project itself is untouched');
	for (const extra of ['Second answer.', 'Third answer.']) { const count = f.team.list(run.workspace)[0].versions.length; await f.team.instruct(run.id, run.workspace, extra); await until(() => f.team.list(run.workspace)[0].state === 'awaiting-validation' && f.team.list(run.workspace)[0].versions.length === count + 1); }
	const long = f.team.list(run.workspace)[0]; assert.equal(long.versions.length, 4); assert.ok(long.steps.length > 9);
	const restarted = new Teams(join(f.root, 'teams'), f.comparisons, f.solutions, () => f.sessions, () => {}); await restarted.recover();
	assert.equal(restarted.list(run.workspace)[0]?.versions.length, 4, 'a team that was answered several times is still there after a restart');
	await f.team.delete(run.id, run.workspace);
	assert.equal(f.team.list(run.workspace).length, 0); assert.equal(f.team.active(), false);
	const recovered = new Teams(join(f.root, 'teams'), f.comparisons, f.solutions, () => f.sessions, () => {}); await recovered.recover();
	assert.equal(recovered.list(run.workspace).length, 0, 'a deleted team does not come back after a restart');
});

test('with the terminal allowed the implementer is told so and the others are not; what an install, a build or a commit leaves stays out of the solution', async () => {
	const f = fixture(false, false, { mode: 'development', external: false }, true); const run = await f.team.start({ workspace: f.workspace, text: 'Implement sum.', participants: f.participants });
	await until(() => f.team.list(run.workspace)[0].state === 'awaiting-validation');
	const assessed = f.team.list(run.workspace)[0];
	assert.equal(assessed.policy?.mode, 'development'); assert.equal(assessed.policy?.external, false);
	assert.match(f.prompts[0], /^Papel: implementador[\s\S]*Você pode usar o terminal neste worktree/); assert.doesNotMatch(f.prompts[0], /Não execute comandos de shell/);
	assert.match(f.prompts[0], /Não publique nem envie nada para fora/);
	for (const prompt of f.prompts.slice(1)) { assert.match(prompt, /^Papel: (revisor|testador)[\s\S]*Não altere arquivos e não execute comandos ou testes/, 'the reviewer and the tester keep their own restrictions'); }
	const solution = f.solutions.list(run.workspace).find(item => item.id === assessed.versions[0].solutionId)!;
	assert.deepEqual(solution.files.map(file => file.path).sort(), ['.gitignore', 'notes.md', 'sum.cjs'], 'the committed change and the new source files are in; node_modules and the ignored build folder are not');
	assert.equal(solution.integrity, true);
	// the independent validation is still the Hub running the authorised command on the snapshot, not the word of the agent
	const completed = await f.team.validate(run.id, run.workspace, { executable: process.execPath, args: ['--test'], approved: true });
	assert.equal(completed.state, 'completed'); assert.equal(completed.versions[0].validation?.exitCode, 0);
	assert.equal(readFileSync(join(f.workspace, 'sum.cjs'), 'utf8'), 'module.exports=(a,b)=>0;\n', 'the project itself is untouched');
	assert.equal(execFileSync('git', ['-C', f.workspace, 'status', '--porcelain']).toString().trim(), '', 'and its working tree is clean');
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
