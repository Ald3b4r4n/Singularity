/**
 * Remote 2.0: what the phone may ask for when it starts and steers multi-agent work. Validation only; the Hub stays the only
 * orchestrator and the engines (comparison, team, worktrees, snapshots, review) are not reimplemented here.
 *
 * The phone sends choices (provider, model, effort) and text. It never sends a path, an executable or a command line: the workspace
 * is an opaque id of one the owner authorised, and independent validation is a profile id the owner registered on Windows.
 */
import { HubBridge } from './bridge';
import { HttpError } from './errors';

export interface Choice { service: string; model: { providerID: string; modelID: string; variant?: string } }
export const TEAM_ROLES = ['implementer', 'reviewer', 'tester'] as const;
export type TeamRoleName = typeof TEAM_ROLES[number];

const SERVICES = ['opencode', 'claude-code', 'codex-cli'];
const ID = /^[A-Za-z0-9._\-/:]{1,160}$/;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseChoice(value: unknown): Choice {
	if (!record(value) || typeof value.service !== 'string' || !SERVICES.includes(value.service) || !record(value.model)) { throw new HttpError(400, 'Escolha um provedor e um modelo.'); }
	const { providerID, modelID, variant } = value.model;
	if (typeof providerID !== 'string' || typeof modelID !== 'string' || !ID.test(providerID) || !ID.test(modelID) || (variant !== undefined && (typeof variant !== 'string' || !/^[a-z0-9-]{1,24}$/i.test(variant)))) { throw new HttpError(400, 'Modelo inválido.'); }
	return { service: value.service, model: { providerID, modelID, ...(variant ? { variant } : {}) } };
}

export function parseComparison(body: Record<string, unknown>): { workspaceId: string; text: string; participants: Choice[] } {
	const text = typeof body.text === 'string' ? body.text.trim() : '';
	if (!text || text.length > 16000) { throw new HttpError(400, 'Escreva a tarefa (até 16000 caracteres).'); }
	if (typeof body.workspaceId !== 'string') { throw new HttpError(400, 'Escolha um workspace autorizado.'); }
	if (!Array.isArray(body.participants) || body.participants.length < 2 || body.participants.length > 3) { throw new HttpError(400, 'Escolha dois ou três agentes.'); }
	const participants = body.participants.map(parseChoice);
	if (new Set(participants.map(choice => JSON.stringify(canonical(choice)))).size !== participants.length) { throw new HttpError(400, 'Escolha agentes ou modelos distintos.'); }
	return { workspaceId: body.workspaceId, text, participants };
}

export function parseTeam(body: Record<string, unknown>): { workspaceId: string; text: string; roles: Choice[]; maxCorrections: number } {
	const text = typeof body.text === 'string' ? body.text.trim() : '';
	if (!text || text.length > 7000) { throw new HttpError(400, 'Escreva a tarefa da equipe (até 7000 caracteres).'); }
	if (typeof body.workspaceId !== 'string') { throw new HttpError(400, 'Escolha um workspace autorizado.'); }
	if (!record(body.roles)) { throw new HttpError(400, 'Escolha implementador, revisor e testador.'); }
	const roles = TEAM_ROLES.map(role => parseChoice((body.roles as Record<string, unknown>)[role]));
	const corrections = body.maxCorrections === undefined ? 2 : body.maxCorrections;
	if (typeof corrections !== 'number' || !Number.isInteger(corrections) || corrections < 0 || corrections > 2) { throw new HttpError(400, 'O máximo de ciclos de correção é de 0 a 2.'); }
	return { workspaceId: body.workspaceId, text, roles, maxCorrections: corrections };
}

/** Key order and nothing else decides equality, so the same request always has the same digest. */
export function canonical(value: unknown): unknown {
	if (Array.isArray(value)) { return value.map(canonical); }
	if (record(value)) { return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])); }
	return value;
}

/** The catalog is the truth: a model the Hub's catalog does not offer (or a service that is not available) is refused before anything starts. */
export async function verifyChoices(bridge: HubBridge, workspacePath: string, choices: Choice[]): Promise<void> {
	const catalogs = new Map<string, { services?: Array<{ id: string; status: string }>; providers?: Array<{ id: string; models: Array<{ id: string; efforts?: string[] }> }> }>();
	for (const choice of choices) {
		let catalog = catalogs.get(choice.service);
		if (!catalog) { const read = await bridge.call<NonNullable<ReturnType<typeof catalogs.get>>>('catalog.get', { workspace: workspacePath, service: choice.service }, 120000); catalogs.set(choice.service, read); catalog = read; }
		if (!catalog.services?.some(service => service.id === choice.service && service.status === 'available')) { throw new HttpError(422, 'Este provedor não está disponível neste computador.'); }
		const model = catalog.providers?.find(provider => provider.id === choice.model.providerID)?.models.find(item => item.id === choice.model.modelID);
		if (!model) { throw new HttpError(422, 'Este modelo não está no catálogo do provedor.'); }
		if (choice.model.variant && !(model.efforts ?? []).includes(choice.model.variant)) { throw new HttpError(422, 'Este esforço não existe para o modelo escolhido.'); }
	}
}
