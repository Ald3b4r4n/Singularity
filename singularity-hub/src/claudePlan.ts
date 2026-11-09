/**
 * Claude plan windows (5 hours and weekly), as the Claude app and Claude Code's /usage show them.
 *
 * This is opt-in and local to the person who turns it on: it reads the Claude Code login that is already on THIS computer
 * (~/.claude/.credentials.json), asks Anthropic's own usage endpoint for that account's numbers and keeps only the percentages
 * and reset times. The token stays in memory for the one request, is sent only to api.anthropic.com over HTTPS, is never
 * written, logged or returned, and is never refreshed here (refreshing would rotate the login that Claude Code itself uses).
 * Nothing about it is in the repository or the installer: another person installing the IDE only ever sees their own account,
 * and only after they turn it on.
 */
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { PlanWindow } from './usageReport';

export interface ClaudePlan { windows: PlanWindow[]; name?: string; checkedAt: number }
export type ClaudePlanResult = { plan: ClaudePlan } | { unavailable: string };
export type UsageFetcher = (token: string) => Promise<{ status: number; body: string }>;

const ENDPOINT = { host: 'api.anthropic.com', path: '/api/oauth/usage' };

const fetchUsage: UsageFetcher = token => new Promise((resolve, reject) => {
	const request = https.request({ host: ENDPOINT.host, path: ENDPOINT.path, method: 'GET', timeout: 8000, headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json', 'User-Agent': 'singularity-ide' } }, response => {
		let body = '';
		response.setEncoding('utf8');
		response.on('data', chunk => { body += chunk; if (body.length > 65536) { request.destroy(new Error('too large')); } });
		response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
	});
	request.on('timeout', () => request.destroy(new Error('timeout')));
	request.on('error', reject);
	request.end();
});

const toPercent = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value * 10) / 10)) : undefined;

function windowOf(label: string, raw: unknown): PlanWindow | undefined {
	if (!raw || typeof raw !== 'object') { return undefined; }
	const item = raw as { utilization?: unknown; resets_at?: unknown };
	const usedPercent = toPercent(item.utilization);
	if (usedPercent === undefined) { return undefined; }
	const resets = typeof item.resets_at === 'string' ? Date.parse(item.resets_at) : NaN;
	return { label, usedPercent, ...(Number.isFinite(resets) ? { resetsAt: resets } : {}) };
}

let cache: { at: number; result: ClaudePlanResult } | undefined;

export async function claudePlan(options: { home?: string; now?: number; fetcher?: UsageFetcher; fresh?: boolean } = {}): Promise<ClaudePlanResult> {
	const now = options.now ?? Date.now();
	// the endpoint is rate limited: one real request per minute is plenty for a screen that is opened by hand
	if (!options.fresh && !options.fetcher && cache && now - cache.at < 60_000) { return cache.result; }
	const remember = (result: ClaudePlanResult): ClaudePlanResult => { if (!options.fetcher) { cache = { at: now, result }; } return result; };
	const file = path.join(options.home ?? os.homedir(), '.claude', '.credentials.json');
	let token: string | undefined;
	let subscription: string | undefined;
	try {
		const oauth = (JSON.parse(fs.readFileSync(file, 'utf8')) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown; subscriptionType?: unknown } }).claudeAiOauth;
		if (typeof oauth?.accessToken === 'string' && oauth.accessToken) {
			if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < now) { return remember({ unavailable: 'O login do Claude Code expirou. Abra o Claude Code uma vez para ele renovar e atualize esta tela.' }); }
			token = oauth.accessToken;
			subscription = typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : undefined;
		}
	} catch { /* no login on this computer */ }
	if (!token) { return remember({ unavailable: 'Não há login do Claude Code neste computador. Entre no Claude Code para ver os limites do plano.' }); }
	try {
		const response = await (options.fetcher ?? fetchUsage)(token);
		token = undefined;
		if (response.status === 401 || response.status === 403) { return remember({ unavailable: 'A Anthropic não aceitou o login do Claude Code. Abra o Claude Code para renová-lo.' }); }
		if (response.status === 429) { return { unavailable: 'A Anthropic pediu para esperar um pouco antes de consultar de novo.' }; }
		if (response.status !== 200) { return remember({ unavailable: 'Não foi possível ler os limites do plano agora.' }); }
		const data = JSON.parse(response.body) as Record<string, unknown>;
		const windows = [windowOf('Limite de 5 horas', data.five_hour), windowOf('Semanal · todos os modelos', data.seven_day), windowOf('Semanal · Sonnet', data.seven_day_sonnet), windowOf('Semanal · Opus', data.seven_day_opus)].filter((item): item is PlanWindow => !!item);
		if (!windows.length) { return remember({ unavailable: 'A Anthropic não informou limites para este plano.' }); }
		return remember({ plan: { windows, ...(subscription ? { name: subscription.charAt(0).toUpperCase() + subscription.slice(1) } : {}), checkedAt: now } });
	} catch {
		return { unavailable: 'Sem conexão com a Anthropic para ler os limites do plano.' };
	}
}
