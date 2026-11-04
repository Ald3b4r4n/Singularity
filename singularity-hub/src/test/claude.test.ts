import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { serviceList, validateSelection } from '../catalog';
import { claudeExecutable, claudeProviders, classifyFailure, parseClaudeHelp, parsePermissionMode } from '../claude';
import { currentWindowsUser } from '../secure';

// The part of `claude --help` the adapter reads, as printed by Claude Code 2.1.292.
const HELP = `
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.
  -n, --name <name>                     Set a display name for this session
`;

describe('Claude Code catalog (read from the installed CLI, never assumed)', () => {
	it('reads the documented model aliases and effort levels', () => {
		assert.deepEqual(parseClaudeHelp(HELP), { aliases: ['fable', 'opus', 'sonnet'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
	});

	it('offers nothing when the CLI documents nothing', () => {
		assert.deepEqual(parseClaudeHelp('usage: claude'), { aliases: [], efforts: [] });
		assert.deepEqual(parseClaudeHelp('--model <model>\n  Model for the session.'), { aliases: [], efforts: [] });
	});

	it('builds a provider whose models only offer the documented efforts', () => {
		const providers = claudeProviders({ executable: 'C:\\claude.exe', version: '2.1.292', loggedIn: true, ...parseClaudeHelp(HELP) });
		assert.equal(providers.length, 1);
		assert.deepEqual(providers[0].models.map(model => model.id), ['fable', 'opus', 'sonnet']);
		assert.equal(validateSelection(providers, { providerID: 'claude-code', modelID: 'sonnet', variant: 'xhigh' }).variant, 'xhigh');
		assert.throws(() => validateSelection(providers, { providerID: 'claude-code', modelID: 'sonnet', variant: 'turbo' }));
		assert.throws(() => validateSelection(providers, { providerID: 'claude-code', modelID: 'gpt-5' }));
		assert.throws(() => validateSelection(providers, { providerID: 'opencode', modelID: 'sonnet' }));
	});

	it('lists Claude Code as available, unavailable or planned according to the machine', () => {
		const state = (claude?: { ok: boolean; reason?: string }) => serviceList({ ok: true }, claude).find(service => service.id === 'claude-code');
		assert.equal(state({ ok: true })?.status, 'available');
		assert.deepEqual(state({ ok: false, reason: 'Entre no Claude Code CLI.' }), { id: 'claude-code', name: 'Claude Code', status: 'unavailable', reason: 'Entre no Claude Code CLI.' });
		assert.equal(state()?.status, 'planned');
		assert.equal(serviceList({ ok: true }, { ok: true }).find(service => service.id === 'codex-cli')?.status, 'planned');
	});
});

describe('Claude Code permissions', () => {
	it('accepts only modes that keep the user in control', () => {
		assert.equal(parsePermissionMode(undefined), undefined);
		assert.equal(parsePermissionMode(''), undefined);
		for (const mode of ['default', 'plan', 'acceptEdits', 'dontAsk']) { assert.equal(parsePermissionMode(mode), mode); }
		for (const mode of ['bypassPermissions', 'auto', 'manual', 'BYPASSPERMISSIONS', '--dangerously-skip-permissions', 5, {}]) {
			assert.throws(() => parsePermissionMode(mode), String(mode));
		}
	});
});

describe('Claude Code failure classification (shapes captured from the real CLI)', () => {
	it('uses the label the CLI puts on the failed assistant turn', () => {
		assert.equal(classifyFailure({ subtype: 'success' }, '', false, 'authentication_failed'), 'authentication');
		assert.equal(classifyFailure({ subtype: 'success' }, '', false, 'model_not_found'), 'model');
		assert.equal(classifyFailure({ subtype: 'success' }, '', false, 'rate_limit'), 'usage-limit');
	});

	it('recognises the three cases without the label', () => {
		assert.equal(classifyFailure({ result: 'Not logged in · Please run /login' }), 'authentication');
		assert.equal(classifyFailure({ api_error_status: 401 }), 'authentication');
		assert.equal(classifyFailure({ result: 'Fable 5.1 requires usage credits. Switch to another model.' }, '', true), 'usage-limit');
		assert.equal(classifyFailure({ api_error_status: 429 }), 'usage-limit');
		assert.equal(classifyFailure({ result: "There's an issue with the selected model (x). It may not exist or you may not have access to it." }), 'model');
		assert.equal(classifyFailure(undefined, '[claude-code:unrecognized_model] {"model":"x"}'.replace('unrecognized_model', 'unknown model')), 'model');
	});

	it('does not guess: anything else is "other"', () => {
		assert.equal(classifyFailure({ result: 'Something exploded' }), 'other');
		assert.equal(classifyFailure(undefined, ''), 'other');
		assert.equal(classifyFailure({ subtype: 'error_max_turns' }, 'turns'), 'other');
	});
});

describe('Claude Code discovery', () => {
	it('never accepts a relative or non-exe override, and finds nothing on an empty PATH', () => {
		assert.equal(claudeExecutable({ SINGULARITY_CLAUDE_CODE: 'claude.exe', PATH: '' }), undefined);
		assert.equal(claudeExecutable({ SINGULARITY_CLAUDE_CODE: 'C:\\x\\claude.cmd', PATH: '' }), undefined);
		assert.equal(claudeExecutable({ PATH: 'relative\\dir' }), undefined);
	});
});

// The native helper's `run-cli` mode is what keeps Claude Code inside a Job Object.
describe('native helper run-cli', { skip: process.platform !== 'win32' }, () => {
	const helper = join(__dirname, '..', 'singularity-job.exe');
	const sid = () => currentWindowsUser().sid;
	const ping = (seconds: number) => ['C:\\Windows\\System32\\ping.exe', '-n', String(seconds), '127.0.0.1'];
	const pingCount = (): number => Number(spawnSync('powershell.exe', ['-NoProfile', '-Command', "(Get-Process ping -ErrorAction SilentlyContinue | Measure-Object).Count"], { encoding: 'utf8' }).stdout.trim()) || 0;

	it('gives the command its stdio, and quotes arguments with spaces and quotes unchanged', async () => {
		const control = randomBytes(32).toString('hex');
		const child = spawn(helper, ['run-cli', String(process.pid), randomUUID(), sid(), process.env.TEMP ?? 'C:\\', 'C:\\Windows\\System32\\cmd.exe', '/d', '/c', 'echo', 'a b "c"'],
			{ env: { ...process.env, SINGULARITY_JOB_CONTROL: control }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		let out = '';
		child.stdout.on('data', chunk => { out += chunk; });
		const [code] = await once(child, 'close');
		assert.equal(code, 0);
		assert.match(out, /^ready\r?\n/);
		assert.match(out, /a b/);
	});

	it('refuses to run without the job control capability or with a bad parent pid', async () => {
		const noControl = spawnSync(helper, ['run-cli', String(process.pid), randomUUID(), sid(), process.env.TEMP ?? 'C:\\', ...ping(1)], { env: { ...process.env, SINGULARITY_JOB_CONTROL: '' }, windowsHide: true, timeout: 10000 });
		assert.equal(noControl.status, 2);
		const badPid = spawnSync(helper, ['run-cli', 'abc', randomUUID(), sid(), process.env.TEMP ?? 'C:\\', ...ping(1)], { env: { ...process.env, SINGULARITY_JOB_CONTROL: randomBytes(32).toString('hex') }, windowsHide: true, timeout: 10000 });
		assert.equal(badPid.status, 2);
	});

	it('ends the whole job when its parent (the Hub) dies, and not before', async () => {
		const before = pingCount();
		const hub = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
		const child = spawn(helper, ['run-cli', String(hub.pid), randomUUID(), sid(), process.env.TEMP ?? 'C:\\', ...ping(120)],
			{ env: { ...process.env, SINGULARITY_JOB_CONTROL: randomBytes(32).toString('hex') }, detached: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		await new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
		await new Promise(resolve => setTimeout(resolve, 1500));
		assert.equal(child.exitCode, null, 'the job must keep running while the parent is alive');
		assert.ok(pingCount() > before);
		const closed = once(child, 'close');
		hub.kill();
		await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('the helper did not end the job')), 15000))]);
		assert.equal(pingCount(), before);
	});
});
