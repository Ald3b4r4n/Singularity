import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CatalogError, parseSelection, sanitizeCatalog, serviceList, validateSelection } from '../catalog';

// Shaped like the real OpenCode v2 answers, with fake secrets where the real ones carry secrets.
const SECRET = 'sk_FAKE_SECRET_KEY_DO_NOT_LEAK_0123456789';
const HEADER_SECRET = 'wrk_FAKE_ORG_HEADER_VALUE';
const rawProviders = { data: [
	{ id: 'vercel', integrationID: 'vercel', name: 'Vercel', activation: 'enabled', package: 'x', settings: { apiKey: SECRET, baseURL: 'https://example.invalid/v1' } },
	{ id: 'opencode', integrationID: 'opencode', name: 'Default / OpenCode', activation: 'enabled', settings: { baseURL: 'https://example.invalid' }, headers: { 'x-opencode-org-id': HEADER_SECRET } },
	{ id: 'off', name: 'Switched off', activation: 'disabled', settings: { apiKey: SECRET } },
	{ id: 'empty', name: 'No usable models', activation: 'enabled' },
] };
const model = (providerID: string, id: string, extra: Record<string, unknown> = {}) => ({
	id, modelID: id, providerID, type: 'chat', name: id.toUpperCase(), status: 'active', enabled: true,
	settings: { apiKey: SECRET }, headers: { h: HEADER_SECRET }, cost: [{ input: 1 }], limit: { context: 1 },
	variants: [{ id: 'low', settings: { reasoningEffort: 'low' } }, { id: 'high', settings: { reasoningEffort: 'high' } }], ...extra,
});
const rawModels = { data: [
	model('vercel', 'alpha'),
	model('vercel', 'beta', { variants: [] }),
	model('vercel', 'gone', { enabled: false }),
	model('vercel', 'old', { status: 'deprecated' }),
	model('opencode', 'free-one', { variants: [{ id: 'none' }, { id: 'minimal' }, { id: 'xhigh' }, { id: 'max' }] }),
	model('off', 'hidden-by-provider'),
	model('empty', 'ghost', { enabled: false }),
	model('unknown-provider', 'orphan'),
] };
const rawDefault = { data: { id: 'free-one', modelID: 'free-one', providerID: 'opencode', settings: { apiKey: SECRET } } };

describe('the catalog is built from an allow-list', () => {
	const result = sanitizeCatalog(rawProviders, rawModels, rawDefault);

	it('never carries a secret, a settings object or a header, anywhere', () => {
		const json = JSON.stringify(result);
		for (const forbidden of [SECRET, HEADER_SECRET, 'apiKey', 'settings', 'headers', 'baseURL', 'x-opencode-org-id', 'reasoningEffort']) {
			assert.equal(json.includes(forbidden), false, forbidden);
		}
	});

	it('exposes only id, name, models and effort ids', () => {
		assert.deepEqual(Object.keys(result.providers[0]).sort(), ['id', 'models', 'name']);
		assert.deepEqual(Object.keys(result.providers[0].models[0]).sort(), ['efforts', 'id', 'name']);
	});

	it('a field that appears upstream tomorrow cannot leak: unknown fields are dropped', () => {
		const withNew = sanitizeCatalog({ data: [{ id: 'p', name: 'P', activation: 'enabled', token: SECRET }] }, { data: [model('p', 'm', { accessToken: SECRET })] });
		assert.equal(JSON.stringify(withNew).includes(SECRET), false);
	});

	it('offers only providers that are not disabled and have at least one usable model', () => {
		assert.deepEqual(result.providers.map(p => p.id), ['opencode', 'vercel']);
	});

	it('offers only models that are enabled and active, and counts the rest', () => {
		const vercel = result.providers.find(p => p.id === 'vercel')!;
		assert.deepEqual(vercel.models.map(m => m.id), ['alpha', 'beta']);
		assert.equal(result.hiddenModels, 3); // gone, old and the model of the empty provider
	});

	it('effort levels are the model\'s own variants, in the order the service gives them', () => {
		assert.deepEqual(result.providers.find(p => p.id === 'vercel')!.models.find(m => m.id === 'alpha')!.efforts, ['low', 'high']);
		assert.deepEqual(result.providers.find(p => p.id === 'opencode')!.models[0].efforts, ['none', 'minimal', 'xhigh', 'max']);
	});

	it('a model without variants has no effort control', () => {
		assert.deepEqual(result.providers.find(p => p.id === 'vercel')!.models.find(m => m.id === 'beta')!.efforts, []);
	});

	it('keeps the default model only when it is really offered', () => {
		assert.deepEqual(result.default, { providerID: 'opencode', modelID: 'free-one' });
		assert.equal(sanitizeCatalog(rawProviders, rawModels, { data: { providerID: 'vercel', modelID: 'gone' } }).default, undefined);
	});

	it('ignores malformed effort ids and oversized or non-text values', () => {
		const odd = sanitizeCatalog({ data: [{ id: 'p', name: 'P', activation: 'enabled' }] },
			{ data: [model('p', 'm', { variants: [{ id: 'ok' }, { id: 'has space' }, { id: 'x'.repeat(40) }, { id: 5 }, null, { id: 'ok' }] })] });
		assert.deepEqual(odd.providers[0].models[0].efforts, ['ok']);
	});

	it('survives garbage input', () => {
		for (const bad of [undefined, null, 5, 'text', [], {}, { data: 'x' }, { data: [null, 1, 'a'] }]) {
			assert.deepEqual(sanitizeCatalog(bad, bad, bad).providers, []);
		}
	});
});

describe('a choice is validated against the catalog before anything is sent', () => {
	const { providers } = sanitizeCatalog(rawProviders, rawModels);

	it('accepts a real provider, model and effort', () => {
		assert.deepEqual(validateSelection(providers, { providerID: 'vercel', modelID: 'alpha', variant: 'high' }), { providerID: 'vercel', modelID: 'alpha', variant: 'high' });
		assert.deepEqual(validateSelection(providers, { providerID: 'vercel', modelID: 'alpha' }), { providerID: 'vercel', modelID: 'alpha', variant: undefined });
	});

	it('refuses an unknown provider or model (the OpenCode API would have accepted it)', () => {
		assert.throws(() => validateSelection(providers, { providerID: 'nope', modelID: 'alpha' }), CatalogError);
		assert.throws(() => validateSelection(providers, { providerID: 'vercel', modelID: 'nonexistent' }), CatalogError);
		assert.throws(() => validateSelection(providers, { providerID: 'vercel', modelID: 'gone' }), /não está disponível/);
	});

	it('refuses an effort level the model does not offer, and any effort on a model without variants', () => {
		assert.throws(() => validateSelection(providers, { providerID: 'vercel', modelID: 'alpha', variant: 'max' }), /não oferece o nível/);
		assert.throws(() => validateSelection(providers, { providerID: 'vercel', modelID: 'beta', variant: 'high' }), /não oferece controle de esforço/);
	});

	it('parses the wire format strictly', () => {
		assert.equal(parseSelection(undefined), undefined);
		assert.equal(parseSelection(null), undefined);
		assert.deepEqual(parseSelection({ providerID: 'a', modelID: 'b', variant: '' }), { providerID: 'a', modelID: 'b', variant: undefined });
		for (const bad of ['x', 5, [], {}, { providerID: 'a' }, { providerID: 'a', modelID: 'b', variant: 7 }, { providerID: 'a', modelID: 'b', variant: 'no space' }, { providerID: 'a'.repeat(300), modelID: 'b' }]) {
			assert.throws(() => parseSelection(bad), CatalogError, JSON.stringify(bad));
		}
	});
});

describe('the service list says honestly what can run', () => {
	it('only OpenCode can be run, and only when the adapter works here', () => {
		const ok = serviceList({ ok: true });
		assert.deepEqual(ok.map(s => [s.id, s.status]), [['opencode', 'available'], ['claude-code', 'planned'], ['codex-cli', 'planned'], ['gemini-cli', 'planned']]);
		const missing = serviceList({ ok: false, reason: 'OpenCode não encontrado.' });
		assert.equal(missing[0].status, 'unavailable');
		assert.equal(missing[0].reason, 'OpenCode não encontrado.');
		assert.equal(missing.filter(s => s.status === 'available').length, 0);
	});
});
