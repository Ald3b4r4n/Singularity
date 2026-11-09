/**
 * Claude plan windows (5 hours and weekly), exactly as Claude Code's own `/usage` command reports them.
 *
 * Opt-in. The Hub runs the Claude Code that is installed on THIS computer with `-p "/usage"`: a local command, no model is
 * called, no tokens are spent, and Claude Code itself uses its own login. The Singularity never reads, copies, stores or sends any
 * credential, and nothing about it is in the repository or the installer: another person installing the IDE only sees their own
 * account, and only after turning it on.
 */
import { claudeUsageText } from './claude';
import { PlanWindow } from './usageReport';

export interface ClaudePlan { windows: PlanWindow[]; checkedAt: number }
export type ClaudePlanResult = { plan: ClaudePlan } | { unavailable: string };
export type UsageRunner = () => Promise<string | undefined>;

const LABELS: Array<[RegExp, string]> = [
	[/^current session/i, 'Limite de 5 horas'],
	[/^current week \(all models\)/i, 'Semanal · todos os modelos'],
	[/^current week \(sonnet/i, 'Semanal · Sonnet'],
	[/^current week \(opus/i, 'Semanal · Opus'],
	[/^current week/i, 'Semanal']
];

/** "Current session: 12% used · resets Nov 9, 6:59pm (America/Sao_Paulo)" → a window. Anything else is ignored. */
export function parseUsageText(text: string): PlanWindow[] {
	const windows: PlanWindow[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*(Current [^:]+?):\s*([\d.,]+)%\s*used(?:\s*[·•|-]\s*resets\s+(.+?))?\s*$/i.exec(line);
		if (!match) { continue; }
		const percent = Number(match[2].replace(',', '.'));
		if (!Number.isFinite(percent)) { continue; }
		const label = LABELS.find(([pattern]) => pattern.test(match[1]))?.[1] ?? match[1];
		windows.push({ label, usedPercent: Math.max(0, Math.min(100, Math.round(percent * 10) / 10)), ...(match[3] ? { resetsText: match[3].slice(0, 80) } : {}) });
	}
	return windows;
}

let cache: { at: number; result: ClaudePlanResult } | undefined;

export async function claudePlan(options: { now?: number; runner?: UsageRunner; fresh?: boolean } = {}): Promise<ClaudePlanResult> {
	const now = options.now ?? Date.now();
	if (!options.fresh && !options.runner && cache && now - cache.at < 60_000) { return cache.result; }
	const remember = (result: ClaudePlanResult): ClaudePlanResult => { if (!options.runner) { cache = { at: now, result }; } return result; };
	let text: string | undefined;
	try { text = await (options.runner ?? claudeUsageText)(); } catch { text = undefined; }
	if (text === undefined) { return { unavailable: 'O Claude Code não foi encontrado ou não respondeu neste computador.' }; }
	const windows = parseUsageText(text);
	if (!windows.length) { return remember({ unavailable: 'O Claude Code não informou limites de plano (entre com a conta do Claude no Claude Code para vê-los).' }); }
	return remember({ plan: { windows, checkedAt: now } });
}
