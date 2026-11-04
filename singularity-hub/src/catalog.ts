// Catalog of agent services, providers, models and effort levels, as the Singularity Hub offers it to the IDE.
//
// Two rules live here, away from any network code so they can be tested alone:
//   1. ALLOW-LIST. The OpenCode API returns objects that carry secrets (a provider has `settings.apiKey`, `headers`, ...).
//      Nothing is ever copied by "spreading" an upstream object: every field that reaches the IDE is built here from a
//      small set of typed fields. Unknown fields are dropped, so a field added upstream can never leak.
//   2. NO INVENTED CHOICES. The OpenCode API accepts any model and any variant without checking them. The Hub checks
//      the user's choice against the catalog it just read, so only a provider, a model and an effort level that exist
//      are ever sent.

export interface ServiceInfo {
	id: string;
	name: string;
	/** `available`: has a working adapter on this machine. `unavailable`: has an adapter, but it cannot run here.
	 *  `planned`: listed in the catalog of integrations; it cannot be selected or run yet. */
	status: 'available' | 'unavailable' | 'planned';
	reason?: string;
}

export interface CatalogModel {
	id: string;
	name: string;
	/** Effort levels this model offers (OpenCode "variants"). Empty: the model has no effort control. */
	efforts: string[];
}

export interface CatalogProvider {
	id: string;
	name: string;
	models: CatalogModel[];
}

export interface ModelSelection {
	providerID: string;
	modelID: string;
	variant?: string;
}

export interface CatalogResult {
	services: ServiceInfo[];
	service: string;
	providers: CatalogProvider[];
	default?: { providerID: string; modelID: string };
	/** Models read from the service but not offered (disabled or not active). */
	hiddenModels: number;
	unavailable?: string;
}

export class CatalogError extends Error { }

/** The integrations the Singularity knows about. Only the ones with an adapter can be run. */
export function serviceList(openCodeRunnable: { ok: boolean; reason?: string }, claudeCodeRunnable?: { ok: boolean; reason?: string }): ServiceInfo[] {
	return [
		openCodeRunnable.ok
			? { id: 'opencode', name: 'OpenCode', status: 'available' }
			: { id: 'opencode', name: 'OpenCode', status: 'unavailable', reason: openCodeRunnable.reason },
		!claudeCodeRunnable ? { id: 'claude-code', name: 'Claude Code', status: 'planned' }
			: claudeCodeRunnable.ok ? { id: 'claude-code', name: 'Claude Code', status: 'available' }
				: { id: 'claude-code', name: 'Claude Code', status: 'unavailable', reason: claudeCodeRunnable.reason },
		{ id: 'codex-cli', name: 'Codex CLI', status: 'planned' },
		{ id: 'gemini-cli', name: 'Gemini CLI', status: 'planned' },
	];
}

const MAX_PROVIDERS = 64;
const MAX_MODELS = 2000;
const MAX_EFFORTS = 12;
const EFFORT_ID = /^[A-Za-z0-9._-]{1,24}$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 160): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;

/** Reads the `{ data: [...] }` or `[...]` envelope the OpenCode API uses. */
function listOf(raw: unknown): unknown[] {
	const inner = isObject(raw) && 'data' in raw ? raw.data : raw;
	return Array.isArray(inner) ? inner : [];
}

/**
 * Builds the catalog from the raw OpenCode answers. Only providers that are not disabled and only models that are
 * enabled and active are offered; the rest are counted, not listed.
 */
export function sanitizeCatalog(rawProviders: unknown, rawModels: unknown, rawDefault?: unknown): { providers: CatalogProvider[]; default?: { providerID: string; modelID: string }; hiddenModels: number } {
	const providers = new Map<string, CatalogProvider>();
	for (const entry of listOf(rawProviders).slice(0, MAX_PROVIDERS)) {
		if (!isObject(entry)) { continue; }
		const id = text(entry.id);
		if (!id || entry.activation === 'disabled') { continue; }
		providers.set(id, { id, name: text(entry.name) ?? id, models: [] });
	}

	let hidden = 0;
	for (const entry of listOf(rawModels).slice(0, MAX_MODELS)) {
		if (!isObject(entry)) { continue; }
		const providerID = text(entry.providerID);
		const modelID = text(entry.modelID) ?? text(entry.id);
		const provider = providerID ? providers.get(providerID) : undefined;
		if (!provider || !modelID) { continue; }
		if (entry.enabled !== true || entry.status !== 'active') { hidden++; continue; }
		const efforts: string[] = [];
		if (Array.isArray(entry.variants)) {
			for (const variant of entry.variants.slice(0, MAX_EFFORTS)) {
				const variantId = isObject(variant) ? text(variant.id, 24) : undefined;
				if (variantId && EFFORT_ID.test(variantId) && !efforts.includes(variantId)) { efforts.push(variantId); }
			}
		}
		if (!provider.models.some(model => model.id === modelID)) {
			provider.models.push({ id: modelID, name: text(entry.name) ?? modelID, efforts });
		}
	}

	const result = [...providers.values()].filter(provider => provider.models.length > 0);
	for (const provider of result) {
		provider.models.sort((a, b) => a.name.localeCompare(b.name));
	}
	result.sort((a, b) => a.name.localeCompare(b.name));

	let defaultModel: { providerID: string; modelID: string } | undefined;
	const rawDefaultModel = isObject(rawDefault) && 'data' in rawDefault ? rawDefault.data : rawDefault;
	if (isObject(rawDefaultModel)) {
		const providerID = text(rawDefaultModel.providerID);
		const modelID = text(rawDefaultModel.modelID) ?? text(rawDefaultModel.id);
		if (providerID && modelID && result.some(provider => provider.id === providerID && provider.models.some(model => model.id === modelID))) {
			defaultModel = { providerID, modelID };
		}
	}
	return { providers: result, default: defaultModel, hiddenModels: hidden };
}

/** Parses the model chosen by the IDE. Returns undefined when it is absent; throws when it is present and malformed. */
export function parseSelection(value: unknown): ModelSelection | undefined {
	if (value === undefined || value === null) { return undefined; }
	if (!isObject(value)) { throw new CatalogError('A seleção de modelo é inválida.'); }
	const providerID = text(value.providerID);
	const modelID = text(value.modelID);
	const variant = value.variant === undefined || value.variant === '' ? undefined : text(value.variant, 24);
	if (!providerID || !modelID || (value.variant !== undefined && value.variant !== '' && (!variant || !EFFORT_ID.test(variant)))) {
		throw new CatalogError('A seleção de modelo é inválida.');
	}
	return { providerID, modelID, variant };
}

/** Checks the choice against the catalog: the provider, the model and the effort level must all exist. */
export function validateSelection(providers: CatalogProvider[], selection: ModelSelection): ModelSelection {
	const provider = providers.find(item => item.id === selection.providerID);
	if (!provider) { throw new CatalogError(`O provedor "${selection.providerID}" não está disponível neste serviço.`); }
	const model = provider.models.find(item => item.id === selection.modelID);
	if (!model) { throw new CatalogError(`O modelo "${selection.modelID}" não está disponível no provedor "${provider.name}".`); }
	if (selection.variant !== undefined && !model.efforts.includes(selection.variant)) {
		throw new CatalogError(model.efforts.length === 0
			? `O modelo "${model.name}" não oferece controle de esforço.`
			: `O modelo "${model.name}" não oferece o nível de esforço "${selection.variant}".`);
	}
	return { providerID: provider.id, modelID: model.id, variant: selection.variant };
}
