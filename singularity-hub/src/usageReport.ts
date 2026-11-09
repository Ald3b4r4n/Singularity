/**
 * Token spend and plan windows for every service, read locally and read-only from what each tool already writes on this computer:
 * OpenCode's database, Claude Code's project logs and Codex CLI's session logs. Nothing is sent anywhere, no model is called, no
 * cost is estimated (a cost appears only when the tool itself reported one) and no prompt, path or file name leaves this module:
 * the result holds numbers, model names and window labels only.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Tokens { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number; messages: number; cost?: number }
export interface PlanWindow { label: string; usedPercent: number; resetsAt?: number; resetsText?: string }
export interface ServiceUsage {
	id: string;
	name: string;
	today: Tokens;
	week: Tokens;
	month: Tokens;
	models: Array<{ model: string; month: Tokens }>;
	plan?: { windows: PlanWindow[]; name?: string };
	note?: string;
}
export interface UsageReport { generatedAt: number; services: ServiceUsage[] }

const DAY = 86_400_000;
const empty = (): Tokens => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0 });
const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

function add(target: Tokens, part: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number; cost?: number }, messages = 1): void {
	target.input += part.input ?? 0; target.output += part.output ?? 0; target.reasoning += part.reasoning ?? 0;
	target.cacheRead += part.cacheRead ?? 0; target.cacheWrite += part.cacheWrite ?? 0;
	target.total = target.input + target.output + target.reasoning + target.cacheRead + target.cacheWrite;
	target.messages += messages;
	if (part.cost && part.cost > 0) { target.cost = (target.cost ?? 0) + part.cost; }
}

class Bucket {
	today = empty(); week = empty(); month = empty();
	models = new Map<string, Tokens>();
	constructor(readonly id: string, readonly name: string) { }
	record(at: number, model: string, part: Parameters<typeof add>[1], now: number, startOfDay: number, messages = 1): void {
		if (at < now - 30 * DAY) { return; }
		add(this.month, part, messages);
		if (at >= now - 7 * DAY) { add(this.week, part, messages); }
		if (at >= startOfDay) { add(this.today, part, messages); }
		add(this.models.get(model) ?? this.models.set(model, empty()).get(model)!, part, messages);
	}
	result(extra: { plan?: ServiceUsage['plan']; note?: string } = {}): ServiceUsage {
		const models = [...this.models.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 8).map(([model, month]) => ({ model, month }));
		return { id: this.id, name: this.name, today: this.today, week: this.week, month: this.month, models, ...extra };
	}
}

function* recentFiles(root: string, extension: string, since: number, limit = 4000): Generator<{ file: string; mtime: number; size: number }> {
	let seen = 0;
	const stack = [root];
	while (stack.length && seen < limit) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) { stack.push(full); continue; }
			if (!entry.name.endsWith(extension)) { continue; }
			try { const stat = fs.statSync(full); if (stat.mtimeMs >= since && stat.size < 400 * 1024 * 1024) { seen++; yield { file: full, mtime: stat.mtimeMs, size: stat.size }; } } catch { /* ignore */ }
		}
	}
}

function* lines(file: string): Generator<string> {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, 'r');
		const buffer = Buffer.alloc(1024 * 1024);
		let rest = '';
		for (;;) {
			const read = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (!read) { break; }
			const chunk = rest + buffer.toString('utf8', 0, read);
			const parts = chunk.split('\n');
			rest = parts.pop() ?? '';
			for (const part of parts) { if (part) { yield part; } }
		}
		if (rest) { yield rest; }
	} catch { /* unreadable: skipped */ } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

function readOpenCode(now: number, startOfDay: number, home: string): ServiceUsage[] {
	const buckets = new Map<string, Bucket>();
	const bucketFor = (providerID: string): Bucket => {
		const id = providerID === 'opencode-go' ? 'opencode-go' : providerID === 'opencode' ? 'opencode-zen' : 'opencode-other';
		const name = id === 'opencode-go' ? 'OpenCode Go' : id === 'opencode-zen' ? 'OpenCode Zen' : 'OpenCode · outros provedores';
		return buckets.get(id) ?? buckets.set(id, new Bucket(id, name)).get(id)!;
	};
	buckets.set('opencode-go', new Bucket('opencode-go', 'OpenCode Go'));
	buckets.set('opencode-zen', new Bucket('opencode-zen', 'OpenCode Zen'));
	const db = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
	let note: string | undefined;
	if (!fs.existsSync(db)) { note = 'O OpenCode ainda não gravou uso neste computador.'; } else {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
			const database = new DatabaseSync(db, { readOnly: true });
			try {
				const rows = database.prepare(`select time_created as at,
					json_extract(data,'$.providerID') as provider, json_extract(data,'$.modelID') as model,
					json_extract(data,'$.cost') as cost, json_extract(data,'$.tokens.input') as input, json_extract(data,'$.tokens.output') as output,
					json_extract(data,'$.tokens.reasoning') as reasoning, json_extract(data,'$.tokens.cache.read') as cacheRead, json_extract(data,'$.tokens.cache.write') as cacheWrite
					from message where json_extract(data,'$.role') = 'assistant' and time_created >= ?`).all(now - 30 * DAY) as Array<Record<string, unknown>>;
				for (const row of rows) {
					const input = num(row.input), output = num(row.output), reasoning = num(row.reasoning), cacheRead = num(row.cacheRead), cacheWrite = num(row.cacheWrite);
					if (!input && !output && !reasoning && !cacheRead && !cacheWrite) { continue; }
					bucketFor(String(row.provider ?? '')).record(num(row.at), String(row.model ?? 'modelo'), { input, output, reasoning, cacheRead, cacheWrite, cost: num(row.cost) }, now, startOfDay);
				}
			} finally { database.close(); }
		} catch { note = 'Não foi possível ler o uso do OpenCode neste computador.'; }
	}
	const planNote = 'O OpenCode não grava o limite do plano neste computador; o saldo e a janela do plano ficam em opencode.ai.';
	return [...buckets.values()].filter(bucket => bucket.id !== 'opencode-other' || bucket.month.messages > 0)
		.map(bucket => bucket.result({ note: note ?? (bucket.id === 'opencode-other' ? undefined : planNote) }));
}

function readClaude(now: number, startOfDay: number, home: string): ServiceUsage {
	const bucket = new Bucket('claude-code', 'Claude Code');
	const root = path.join(home, '.claude', 'projects');
	const seen = new Set<string>();
	if (fs.existsSync(root)) {
		for (const { file } of recentFiles(root, '.jsonl', now - 30 * DAY)) {
			for (const line of lines(file)) {
				if (!line.includes('"usage"') || !line.includes('"assistant"')) { continue; }
				let entry: { type?: string; timestamp?: string; requestId?: string; message?: { id?: string; model?: string; usage?: Record<string, unknown> } };
				try { entry = JSON.parse(line); } catch { continue; }
				const message = entry.message;
				if (entry.type !== 'assistant' || !message?.usage || !message.model || message.model === '<synthetic>') { continue; }
				const key = (message.id ?? '') + ':' + (entry.requestId ?? '');
				if (key !== ':') { if (seen.has(key)) { continue; } seen.add(key); }
				const at = Date.parse(entry.timestamp ?? '');
				if (!Number.isFinite(at)) { continue; }
				const usage = message.usage;
				bucket.record(at, message.model, { input: num(usage.input_tokens), output: num(usage.output_tokens), cacheRead: num(usage.cache_read_input_tokens), cacheWrite: num(usage.cache_creation_input_tokens) }, now, startOfDay);
			}
		}
	}
	return bucket.result({ note: 'O Claude Code não grava neste computador o limite do plano (janela de 5 horas e semanal); veja com /usage dentro dele ou ative "Mostrar limites do plano Claude" em Uso e limites, na IDE. Os tokens abaixo vêm dos registros dele.' });
}

function readCodex(now: number, startOfDay: number, home: string): ServiceUsage {
	const bucket = new Bucket('codex-cli', 'Codex CLI');
	const root = path.join(home, '.codex', 'sessions');
	let latest: { at: number; limits: Record<string, unknown> } | undefined;
	if (fs.existsSync(root)) {
		for (const { file } of recentFiles(root, '.jsonl', now - 30 * DAY)) {
			let model = 'modelo';
			let last: { at: number; usage: Record<string, unknown> } | undefined;
			for (const line of lines(file)) {
				const isTurn = line.includes('"turn_context"');
				if (!isTurn && !line.includes('"token_count"')) { continue; }
				let entry: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
				try { entry = JSON.parse(line); } catch { continue; }
				const payload = entry.payload;
				if (!payload) { continue; }
				if (isTurn && typeof payload.model === 'string') { model = payload.model; continue; }
				if (payload.type !== 'token_count') { continue; }
				const at = Date.parse(entry.timestamp ?? '');
				if (!Number.isFinite(at)) { continue; }
				const info = payload.info as { total_token_usage?: Record<string, unknown> } | null | undefined;
				if (info?.total_token_usage) { last = { at, usage: info.total_token_usage }; }
				const limits = payload.rate_limits as Record<string, unknown> | null | undefined;
				if (limits && (!latest || at > latest.at)) { latest = { at, limits }; }
			}
			if (last) {
				const u = last.usage;
				// the session total is cumulative; "input" already contains the cached part, so it is split to avoid counting it twice
				const cached = Math.min(num(u.cached_input_tokens), num(u.input_tokens));
				bucket.record(last.at, model, { input: num(u.input_tokens) - cached, output: num(u.output_tokens), reasoning: num(u.reasoning_output_tokens), cacheRead: cached, cacheWrite: num(u.cache_write_input_tokens) }, now, startOfDay);
			}
		}
	}
	const windows: PlanWindow[] = [];
	if (latest) {
		for (const key of ['primary', 'secondary'] as const) {
			const window = latest.limits[key] as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown } | null | undefined;
			if (!window || typeof window.used_percent !== 'number') { continue; }
			const minutes = num(window.window_minutes);
			const label = minutes === 300 ? 'Janela de 5 horas' : minutes === 10080 ? 'Janela semanal' : minutes ? `Janela de ${Math.round(minutes / 60)} h` : key === 'primary' ? 'Janela curta' : 'Janela longa';
			const resetsAt = num(window.resets_at);
			windows.push({ label, usedPercent: Math.max(0, Math.min(100, Math.round(window.used_percent * 10) / 10)), ...(resetsAt ? { resetsAt: resetsAt * 1000 } : {}) });
		}
	}
	return bucket.result({
		...(windows.length ? { plan: { windows, ...(typeof latest?.limits.plan_type === 'string' ? { name: latest.limits.plan_type } : {}) } } : {}),
		note: windows.length ? `Limites do plano conforme o último uso registrado pelo Codex (${new Date(latest!.at).toLocaleString('pt-BR')}); a porcentagem só se atualiza quando o Codex roda.` : 'O Codex ainda não registrou os limites do plano neste computador.'
	});
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What the OpenCode server answers for /api/experimental/usage/limits: OpenCode Go meters (rolling, weekly, monthly) and Zen budgets.
 * Only percentages, labels and reset times are kept; the Console link and workspace names are dropped.
 */
export function mapOpenCodeLimits(body: unknown): { go: PlanWindow[]; zen: PlanWindow[] } {
	const result = { go: [] as PlanWindow[], zen: [] as PlanWindow[] };
	const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
	if (!data) { return result; }
	if (isRecord(data.go)) {
		for (const [key, label] of [['rolling', 'Janela de 5 horas'], ['weekly', 'Semanal'], ['monthly', 'Mensal']] as const) {
			const meter = data.go[key];
			if (!isRecord(meter) || typeof meter.percent !== 'number' || !Number.isFinite(meter.percent)) { continue; }
			result.go.push({ label, usedPercent: Math.max(0, Math.min(100, Math.round(meter.percent * 10) / 10)), ...(typeof meter.resetsAt === 'number' && meter.resetsAt > 0 ? { resetsAt: meter.resetsAt } : {}) });
		}
	}
	for (const row of Array.isArray(data.budgets) ? data.budgets : []) {
		if (!isRecord(row) || typeof row.limit !== 'number' || typeof row.spent !== 'number' || row.limit <= 0) { continue; }
		const models = (Array.isArray(row.models) ? row.models : []).map(item => isRecord(item) && typeof item.name === 'string' ? item.name : undefined).filter((item): item is string => !!item).slice(0, 2);
		result.zen.push({ label: 'Orçamento' + (models.length ? ' · ' + models.join(', ') : ''), usedPercent: Math.max(0, Math.min(100, Math.round(row.spent / row.limit * 1000) / 10)), ...(typeof row.resetsAt === 'number' && row.resetsAt > 0 ? { resetsAt: row.resetsAt } : {}) });
	}
	return result;
}

let cache: { at: number; report: UsageReport } | undefined;

export function usageReport(options: { home?: string; now?: number; fresh?: boolean } = {}): UsageReport {
	const now = options.now ?? Date.now();
	if (!options.fresh && !options.home && cache && now - cache.at < 30_000) { return cache.report; }
	const home = options.home ?? os.homedir();
	const start = new Date(now); start.setHours(0, 0, 0, 0);
	const report: UsageReport = { generatedAt: now, services: [...readOpenCode(now, start.getTime(), home), readClaude(now, start.getTime(), home), readCodex(now, start.getTime(), home)] };
	if (!options.home) { cache = { at: now, report }; }
	return report;
}
