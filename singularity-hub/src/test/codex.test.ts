import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { serviceList, validateSelection } from '../catalog';
import { classifyCodexFailure, codexExecutable, codexProviders, parseCodexModels, parseCodexPermissionMode } from '../codex';

// Trimmed from `codex debug models` (Codex CLI 0.166.0): the real entries also carry long internal instructions, which must never travel.
const CATALOG = {
	models: [
		{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', default_reasoning_level: 'low', visibility: 'list', priority: 1, base_instructions: 'SECRET-INTERNAL-PROMPT',
			supported_reasoning_levels: [{ effort: 'low', description: 'x' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }] },
		{ slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 5, supported_reasoning_levels: [{ effort: 'low' }] },
		{ slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', default_reasoning_level: 'medium', visibility: 'list', priority: 6, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'low' }] },
		{ slug: 'bad slug!', display_name: 'Bad', visibility: 'list', supported_reasoning_levels: [] },
		{ slug: 'gpt-6-terra', display_name: 'GPT-6-Terra', visibility: 'list', priority: 3, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'not a level' }, { effort: 7 }] },
		'not an object', null,
	]
};

const facts = () => ({ executable: 'C:\\codex.exe', version: '0.166.0', login: 'chatgpt' as const, models: parseCodexModels(CATALOG) });

describe('Codex CLI catalog (read from the installed CLI, never assumed)', () => {
	it("lists only visible models, in the CLI's own order, with the effort levels each one reports", () => {
		const models = parseCodexModels(CATALOG);
		assert.deepEqual(models.map(model => model.id), ['gpt-6.1-sol', 'gpt-6-terra', 'gpt-6-luna']);
		assert.deepEqual(models[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
		assert.equal(models[0].defaultEffort, 'low');
		assert.deepEqual(models[1].efforts, ['low'], 'malformed levels are dropped');
		assert.deepEqual(models[2].efforts, ['low', 'medium'], 'duplicates are dropped');
	});

	it('never copies anything but the allow-listed fields', () => {
		const everything = JSON.stringify([parseCodexModels(CATALOG), codexProviders(facts())]);
		assert.doesNotMatch(everything, /SECRET-INTERNAL-PROMPT|base_instructions|description/);
	});

	it('offers nothing when the catalog is unreadable', () => {
		for (const raw of [undefined, null, 5, 'x', [], {}, { models: 'x' }, { models: [] }]) { assert.deepEqual(parseCodexModels(raw), []); }
	});

	it('validates a choice against the reported models and levels only', () => {
		const providers = codexProviders(facts());
		assert.equal(validateSelection(providers, { providerID: 'codex-cli', modelID: 'gpt-6.1-sol', variant: 'ultra' }).variant, 'ultra');
		assert.throws(() => validateSelection(providers, { providerID: 'codex-cli', modelID: 'gpt-6-luna', variant: 'ultra' }));
		assert.throws(() => validateSelection(providers, { providerID: 'codex-cli', modelID: 'gpt-reserve' }));
		assert.throws(() => validateSelection(providers, { providerID: 'claude-code', modelID: 'gpt-6.1-sol' }));
	});

	it('lists Codex CLI as available, unavailable or planned according to the machine', () => {
		const state = (codex?: { ok: boolean; reason?: string }) => serviceList({ ok: true }, { ok: true }, codex).find(service => service.id === 'codex-cli');
		assert.equal(state({ ok: true })?.status, 'available');
		assert.deepEqual(state({ ok: false, reason: 'Entre no Codex CLI.' }), { id: 'codex-cli', name: 'Codex CLI', status: 'unavailable', reason: 'Entre no Codex CLI.' });
		assert.equal(state()?.status, 'planned');
		assert.equal(serviceList({ ok: true }, { ok: true }, { ok: true }).find(service => service.id === 'gemini-cli')?.status, 'planned');
	});
});

describe('Codex CLI permissions', () => {
	it('accepts only sandbox modes that keep the workspace boundary', () => {
		assert.equal(parseCodexPermissionMode(undefined), undefined);
		assert.equal(parseCodexPermissionMode(''), undefined);
		for (const mode of ['read-only', 'workspace-write']) { assert.equal(parseCodexPermissionMode(mode), mode); }
		for (const mode of ['danger-full-access', '--dangerously-bypass-approvals-and-sandbox', 'acceptEdits', 'READ-ONLY', 5, {}]) {
			assert.throws(() => parseCodexPermissionMode(mode));
		}
	});
});

describe('Codex CLI failure classification (shapes captured from the real CLI)', () => {
	it('recognises authentication, usage limit and model failures', () => {
		assert.equal(classifyCodexFailure('unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses'), 'authentication');
		assert.equal(classifyCodexFailure('Not logged in'), 'authentication');
		assert.equal(classifyCodexFailure("The 'x' model is not supported when using Codex with a ChatGPT account."), 'model');
		assert.equal(classifyCodexFailure('You have hit your usage limit. Try again later.'), 'usage-limit');
		assert.equal(classifyCodexFailure('unexpected status 429 Too Many Requests'), 'usage-limit');
	});

	it('does not guess: anything else is "other"', () => {
		assert.equal(classifyCodexFailure('Invalid response.create payload: Invalid value: turbo.'), 'other');
		assert.equal(classifyCodexFailure(undefined), 'other');
		assert.equal(classifyCodexFailure(undefined, ''), 'other');
	});
});

describe('Codex CLI discovery', () => {
	it('never accepts a relative or non-exe override, and finds nothing on an empty PATH', () => {
		assert.equal(codexExecutable({ SINGULARITY_CODEX_CLI: 'codex.exe', PATH: '' }), undefined);
		assert.equal(codexExecutable({ SINGULARITY_CODEX_CLI: 'C:\\x\\codex.cmd', PATH: '' }), undefined);
		assert.equal(codexExecutable({ PATH: 'relative\\dir' }), undefined);
	});
});
