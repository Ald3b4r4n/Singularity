import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionPolicies, EXTERNAL_COMMANDS, claudeLaunch, codexLaunch, implementerInstructions, openCodeConfig, openCodeRules, parsePolicy, redact, type ExecutionPolicy } from '../executionPolicy';
import { permissionArgs } from '../claude';
import { sandboxArgs } from '../codex';
import { ALLOWED_HUB_METHODS } from '../remote/bridge';
import { HubConnection, RpcFailure } from '../client';
import { startInProcess, tempHome, cleanup } from './helpers';

const restricted: ExecutionPolicy = { mode: 'restricted', external: false };
const development: ExecutionPolicy = { mode: 'development', external: false };
const developmentOut: ExecutionPolicy = { mode: 'development', external: true };
const autonomous: ExecutionPolicy = { mode: 'autonomous', external: false };
const autonomousOut: ExecutionPolicy = { mode: 'autonomous', external: true };
const denies = (rules: ReturnType<typeof openCodeRules>, action: string, resource = '*') => !!rules?.some(rule => rule.action === action && rule.resource === resource && rule.effect === 'deny');

describe('the execution policy of the implementer, per workspace', () => {
	it('a workspace that was never configured is restricted, and a choice survives a restart of the Hub', () => {
		const directory = mkdtempSync(join(tmpdir(), 'singularity-policy-')), file = join(directory, 'policies.json'), workspace = mkdtempSync(join(tmpdir(), 'singularity-policy-ws-'));
		const first = new ExecutionPolicies(file);
		assert.deepEqual(first.get(workspace), restricted);
		assert.equal(existsSync(file), false, 'reading never writes');
		const saved = first.set(workspace, 'development', true);
		assert.equal(saved.mode, 'development'); assert.equal(saved.external, true); assert.ok(Number.isFinite(saved.updatedAt));
		const again = new ExecutionPolicies(file);
		assert.equal(again.get(workspace).mode, 'development'); assert.equal(again.get(workspace).external, true);
		assert.equal(again.get(workspace.toUpperCase()).mode, 'development', 'the same folder, however it is spelled');
		assert.deepEqual(again.get(mkdtempSync(join(tmpdir(), 'singularity-policy-other-'))), restricted, 'another workspace is not affected');
		assert.throws(() => again.set(workspace, 'god-mode', false), /inválido/);
		assert.equal(again.set(workspace, 'restricted', true).external, false, 'restricted never carries the consent for external operations');
		assert.equal(new ExecutionPolicies(file).get(workspace).mode, 'restricted');
	});

	it('an unreadable or tampered file grants nothing', () => {
		const directory = mkdtempSync(join(tmpdir(), 'singularity-policy-bad-')), file = join(directory, 'policies.json'), workspace = directory;
		writeFileSync(file, '{ not json');
		assert.deepEqual(new ExecutionPolicies(file).get(workspace), restricted);
		writeFileSync(file, JSON.stringify({ [workspace.toLowerCase()]: { mode: 'autonomous' } }));
		assert.deepEqual(new ExecutionPolicies(file).get(workspace), restricted, 'a record without every field is not a policy');
		assert.equal(parsePolicy({ mode: 'autonomous', external: 'yes' }), undefined);
	});

	it('restricted keeps the earlier prohibition, in the words given to the agent and in what the harness is told', () => {
		assert.match(implementerInstructions(restricted), /Não execute comandos de shell, testes ou outras CLIs nesta etapa\./);
		assert.ok(denies(openCodeRules(restricted, 'implementer'), 'shell'), 'OpenCode is told to refuse the shell, not only asked');
		assert.deepEqual(claudeLaunch(restricted, 'implementer'), { permissionMode: 'acceptEdits' });
		assert.deepEqual(permissionArgs('acceptEdits', undefined), ['--permission-mode', 'acceptEdits']);
		assert.deepEqual(codexLaunch(restricted, 'implementer'), { sandbox: 'workspace-write' });
		assert.deepEqual(sandboxArgs('workspace-write', undefined, false), ['-s', 'workspace-write']);
	});

	it('development lets the implementer use the terminal inside its working copy, with what leaves the computer still closed', () => {
		const rules = openCodeRules(development, 'implementer')!;
		assert.ok(!denies(rules, 'shell'), 'the shell is not refused');
		assert.ok(denies(rules, 'external_directory'), 'files outside the working copy are refused by the harness');
		for (const command of ['git push', 'vercel', 'npm publish', 'gh']) { assert.ok(denies(rules, 'shell', command + '*'), command); }
		assert.ok(!openCodeRules(developmentOut, 'implementer')!.some(rule => rule.action === 'shell'), 'with the consent of the owner, publishing is not refused');
		assert.match(implementerInstructions(development), /Você pode usar o terminal neste worktree/); assert.doesNotMatch(implementerInstructions(development), /Não execute comandos de shell/);
		assert.match(implementerInstructions(development), /Não publique nem envie nada para fora/); assert.match(implementerInstructions(developmentOut), /autorizou operações externas/);
		const claude = claudeLaunch(development, 'implementer');
		assert.equal(claude.permissionMode, 'acceptEdits'); assert.deepEqual(claude.allowedTools, ['Bash']); assert.ok(claude.disallowedTools!.includes('Bash(git push:*)'));
		assert.deepEqual(permissionArgs('acceptEdits', { allowedTools: ['Bash'], disallowedTools: ['Bash(git push:*)', 'Bash(vercel:*)'] }), ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash', '--disallowedTools', 'Bash(git push:*),Bash(vercel:*)']);
		assert.equal(claudeLaunch(developmentOut, 'implementer').disallowedTools, undefined);
		assert.deepEqual(codexLaunch(development, 'implementer'), { sandbox: 'workspace-write', network: true });
		assert.deepEqual(sandboxArgs('workspace-write', { network: true }, false), ['-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true']);
	});

	it('autonomous uses the non-interactive mode each tool documents, and only when the policy says so', () => {
		const rules = openCodeRules(autonomous, 'implementer')!;
		assert.ok(!denies(rules, 'shell') && !denies(rules, 'external_directory'));
		assert.ok(denies(rules, 'shell', 'git push*'), 'publishing still needs its own consent');
		assert.deepEqual(openCodeRules(autonomousOut, 'implementer'), []);
		assert.equal(claudeLaunch(autonomous, 'implementer').permissionMode, 'bypassPermissions');
		assert.deepEqual(permissionArgs('acceptEdits', { bypass: true }), ['--permission-mode', 'bypassPermissions']);
		assert.deepEqual(codexLaunch(autonomous, 'implementer'), { sandbox: 'danger-full-access' });
		assert.deepEqual(sandboxArgs('workspace-write', { fullAccess: true }, false), ['-s', 'danger-full-access']);
		assert.deepEqual(sandboxArgs('workspace-write', { fullAccess: true }, true), ['-c', 'sandbox_mode="danger-full-access"']);
	});

	it('the reviewer and the tester never get a terminal or the right to edit, whatever the policy', () => {
		for (const policy of [restricted, development, developmentOut, autonomous, autonomousOut]) {
			for (const role of ['reviewer', 'tester'] as const) {
				const rules = openCodeRules(policy, role);
				assert.ok(denies(rules, 'shell') && denies(rules, 'edit'), policy.mode + ' ' + role);
				assert.deepEqual(claudeLaunch(policy, role), { permissionMode: 'plan' });
				assert.deepEqual(codexLaunch(policy, role), { sandbox: 'read-only' });
			}
		}
	});

	it('a comparison in a restricted workspace runs exactly as before', () => {
		assert.equal(openCodeRules(restricted, undefined), undefined, 'the configuration of OpenCode is not touched');
		assert.deepEqual(claudeLaunch(restricted, undefined), { permissionMode: 'acceptEdits' });
		assert.deepEqual(codexLaunch(restricted, undefined), { sandbox: 'workspace-write' });
	});

	it('the rules are added to an inline configuration that already exists, and an unreadable one stops the launch', () => {
		const merged = JSON.parse(openCodeConfig(JSON.stringify({ plugins: ['-*', 'opencode.*'], permissions: [{ action: 'read', resource: '*.pem', effect: 'deny' }] }), openCodeRules(restricted, 'implementer'))!);
		assert.deepEqual(merged.plugins, ['-*', 'opencode.*']);
		assert.deepEqual(merged.permissions, [{ action: 'read', resource: '*.pem', effect: 'deny' }, { action: 'shell', resource: '*', effect: 'deny' }], 'ours come last: the last rule wins');
		assert.equal(openCodeConfig('{"a":1}', undefined), '{"a":1}');
		assert.throws(() => openCodeConfig('not json', openCodeRules(development, 'implementer')), /não pôde ser lida/);
	});

	it('what looks like a credential is removed from a command and from what it printed', () => {
		const shown = redact('curl -H "Authorization: Bearer abcdef1234567890abcdef" https://example.test && export API_KEY=sk-abcdefghijklmnop1234 token=ghp_abcdefghijklmnopqrstuvwxyz0123');
		for (const secret of ['abcdef1234567890abcdef', 'sk-abcdefghijklmnop1234', 'ghp_abcdefghijklmnopqrstuvwxyz0123']) { assert.ok(!shown.includes(secret), secret); }
		assert.match(shown, /\[oculto\]/);
		assert.equal(redact('npm test -- --grep "soma de dois números" src/app/validar.js'), 'npm test -- --grep "soma de dois números" src/app/validar.js', 'an ordinary command is left as it is');
	});

	it('the list of external commands covers publishing by Git, by a host and by a package registry', () => {
		for (const command of ['git push', 'vercel', 'npm publish', 'gh ', 'docker push']) { assert.ok(EXTERNAL_COMMANDS.includes(command), command); }
	});
});

describe('the policy over the wire', { timeout: 60000 }, () => {
	it('only the owner changes it, with an explicit confirmation, and the gateway of the phone has no method that does', async () => {
		const home = tempHome('execution-policy'), hub = await startInProcess(home), client = await HubConnection.connect({ home, clientName: 'policy-fixture' });
		const workspace = mkdtempSync(join(tmpdir(), 'singularity-policy-rpc-'));
		try {
			assert.deepEqual(await client.request('policy.get', { workspace }), restricted);
			await assert.rejects(client.request('policy.set', { workspace, mode: 'autonomous', external: true }), (error: unknown) => error instanceof RpcFailure && /confirmação/.test(error.message));
			assert.deepEqual(await client.request('policy.get', { workspace }), restricted, 'nothing changed without the confirmation');
			await assert.rejects(client.request('policy.set', { workspace, mode: 'root', confirm: true }), (error: unknown) => error instanceof RpcFailure);
			const set = await client.request<ExecutionPolicy>('policy.set', { workspace, mode: 'development', external: false, confirm: true });
			assert.equal(set.mode, 'development');
			assert.ok(existsSync(join(home, 'execution-policies.json')), 'kept in the home of this Hub, not somewhere shared');
			assert.ok(!readFileSync(join(home, 'execution-policies.json'), 'utf8').includes('autonomous'));
			const ports = hub.server as unknown as { teams: { active: () => boolean } }, active = ports.teams.active;
			ports.teams.active = () => true;
			try { await assert.rejects(client.request('policy.set', { workspace, mode: 'autonomous', external: false, confirm: true }), (error: unknown) => error instanceof RpcFailure && /em andamento/.test(error.message)); }
			finally { ports.teams.active = active; }
			assert.equal((await client.request<ExecutionPolicy>('policy.get', { workspace })).mode, 'development', 'a working team keeps the policy it started with');
		} finally { client.close(); await hub.release(); cleanup(home); }
		assert.ok((ALLOWED_HUB_METHODS as readonly string[]).includes('policy.get'));
		assert.ok(!(ALLOWED_HUB_METHODS as readonly string[]).some(method => /^policy\.(set|write|update)/.test(method)), 'the phone can read the policy and nothing else');
		assert.ok(!(ALLOWED_HUB_METHODS as readonly string[]).some(method => /shell|exec|command|terminal/i.test(method)), 'and there is no method that runs a command');
	});
});
