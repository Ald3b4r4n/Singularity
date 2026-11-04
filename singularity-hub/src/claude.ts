// Claude Code adapter: runs the real `claude` CLI headlessly (`--print --output-format stream-json`) and turns its structured
// events into Hub sessions. Nothing here reads the terminal, calls the Claude API, or touches the CLI's credential files.
//
// How it differs from the OpenCode adapter (and why):
//   * OpenCode is a long-lived local server; Claude Code has no server. Each prompt is one short-lived `claude -p` process, started
//     inside a Job Object by the native helper (`run-cli` mode). The conversation lives in the CLI's own session store, so the first
//     prompt uses `--session-id <uuid>` and the next ones `--resume <uuid>`.
//   * There is therefore nothing to "recover" after a Hub crash: the helper terminates the job when the Hub process ends, the run in
//     flight is lost (it is shown as interrupted), and the session is kept in the protected history. It can be reopened and continued
//     with `--resume`, which never starts a run by itself.
//   * Authentication is whatever the installed CLI already has. The Hub only asks `claude auth status --json` and keeps the boolean.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CatalogError, CatalogProvider, CatalogResult, ModelSelection, ServiceInfo, validateSelection } from './catalog';
import { SessionHistory, Turn } from './history';
import { HubEvent, ModelInfo, Session } from './protocol';
import { currentWindowsUser } from './secure';

const helper = join(__dirname, 'singularity-job.exe');
const outputLimit = 12000;
const maxSessions = 8;
const promptLimit = 16000;
const runTimeoutMs = 30 * 60 * 1000;
const factsTtlMs = 60_000;

export class ClaudeCodeError extends Error { }

/** Permission modes a session may ask for. `bypassPermissions`, `auto` and `manual` are never offered: the first two skip the
 *  user's approval, and `manual` needs an interactive host that a headless run does not have. */
export const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'dontAsk'] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];

export function parsePermissionMode(value: unknown): PermissionMode | undefined {
	if (value === undefined || value === null || value === '') { return undefined; }
	if (typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)) { return value as PermissionMode; }
	throw new CatalogError('O modo de permissão solicitado não é permitido.');
}

// ---------- discovery ----------

/** The native `claude.exe`. The npm shim `claude.cmd` only forwards to it, so it is resolved instead of being run through cmd.exe. */
export function claudeExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (process.platform !== 'win32' || !existsSync(helper)) { return undefined; }
	const explicit = env.SINGULARITY_CLAUDE_CODE;
	if (explicit && isAbsolute(explicit) && /\.exe$/i.test(explicit) && existsSync(explicit)) { return explicit; }
	for (const entry of (env.PATH ?? env.Path ?? '').split(delimiter)) {
		const directory = entry.replace(/^"|"$/g, '');
		if (!isAbsolute(directory)) { continue; }
		for (const candidate of [join(directory, 'claude.exe'), join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]) {
			if (existsSync(candidate)) { return candidate; }
		}
	}
	return undefined;
}

function capture(executable: string, args: string[], timeout = 15000): Promise<{ code: number; stdout: string }> {
	return new Promise(resolve => {
		execFile(executable, args, { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 1024 * 1024, cwd: dirname(executable) }, (error, stdout) => {
			resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? '') });
		});
	});
}

export interface ClaudeFacts {
	executable: string;
	version: string;
	aliases: string[];
	efforts: string[];
	loggedIn: boolean;
}

/** What `--help` documents for headless use. The alias list and the effort levels are read from the installed CLI, never assumed. */
export function parseClaudeHelp(help: string): { aliases: string[]; efforts: string[] } {
	const modelAt = help.search(/--model <model>/);
	const modelText = modelAt < 0 ? '' : help.slice(modelAt, modelAt + 600);
	const aliases = [...modelText.matchAll(/'([a-z][a-z0-9.-]{1,30})'/g)].map(match => match[1]).filter((alias, index, all) => all.indexOf(alias) === index);
	const effortAt = help.search(/--effort <level>/);
	const effortText = effortAt < 0 ? '' : help.slice(effortAt, effortAt + 300);
	const efforts = (/\(([a-z, ]+)\)/.exec(effortText)?.[1] ?? '').split(/\s*,\s*/).filter(level => /^[a-z]{2,12}$/.test(level));
	return { aliases, efforts };
}

let cachedFacts: { at: number; promise: Promise<ClaudeFacts | { reason: string }> } | undefined;

/** Version, documented models and efforts, and whether the CLI is logged in. Cached for a minute. */
export function inspectClaude(refresh = false): Promise<ClaudeFacts | { reason: string }> {
	if (cachedFacts && !refresh && Date.now() - cachedFacts.at < factsTtlMs) { return cachedFacts.promise; }
	const promise = (async (): Promise<ClaudeFacts | { reason: string }> => {
		const executable = claudeExecutable();
		if (!executable) { return { reason: 'Claude Code CLI ou o helper Windows do Singularity não foi encontrado.' }; }
		const [version, help, auth] = await Promise.all([capture(executable, ['--version']), capture(executable, ['--help']), capture(executable, ['auth', 'status', '--json'])]);
		const versionText = /^\d+\.\d+\.\d+/.exec(version.stdout.trim())?.[0];
		if (version.code !== 0 || !versionText) { return { reason: 'Não foi possível confirmar a versão do Claude Code.' }; }
		const { aliases, efforts } = parseClaudeHelp(help.stdout);
		if (help.code !== 0 || !aliases.length || !efforts.length) { return { reason: 'O catálogo headless desta versão do Claude Code não pôde ser confirmado.' }; }
		let loggedIn = false;
		try { loggedIn = JSON.parse(auth.stdout).loggedIn === true; } catch { /* the CLI answered something unusable: treated as not logged in */ }
		if (!loggedIn) { return { reason: 'Entre no Claude Code CLI (`claude auth login`) antes de usar este serviço.' }; }
		return { executable, version: versionText, aliases, efforts, loggedIn };
	})();
	cachedFacts = { at: Date.now(), promise };
	return promise;
}

export async function claudeRunnable(): Promise<{ ok: boolean; reason?: string }> {
	const facts = await inspectClaude();
	return 'reason' in facts ? { ok: false, reason: facts.reason } : { ok: true };
}

export function claudeProviders(facts: ClaudeFacts): CatalogProvider[] {
	return [{
		id: 'claude-code', name: 'Claude Code',
		models: facts.aliases.map(id => ({ id, name: id[0].toUpperCase() + id.slice(1), efforts: facts.efforts }))
	}];
}

// ---------- failures ----------

export type FailureKind = 'authentication' | 'usage-limit' | 'model' | 'other';

/** Classifies a failed run from the CLI's own result event and stderr. Never returns text the CLI printed. */
export function classifyFailure(event: { subtype?: unknown; api_error_status?: unknown; result?: unknown } | undefined, stderr = '', rejected = false, assistantError?: unknown): FailureKind {
	// The CLI labels the failed assistant turn itself (`authentication_failed`, `model_not_found`, ...): that is the most reliable signal.
	if (assistantError === 'authentication_failed') { return 'authentication'; }
	if (assistantError === 'model_not_found') { return 'model'; }
	if (assistantError === 'rate_limit' || assistantError === 'billing_error') { return 'usage-limit'; }
	const status = typeof event?.api_error_status === 'number' ? event.api_error_status : undefined;
	const detail = `${typeof event?.result === 'string' ? event.result : ''}\n${stderr}`.toLowerCase();
	if (status === 401 || /\/login|invalid api key|not logged in|authentication|oauth token|unauthori[sz]ed/.test(detail)) { return 'authentication'; }
	if (rejected || status === 429 || /usage limit|rate limit|limit reached|quota|too many requests|out of (?:extra )?usage/.test(detail)) { return 'usage-limit'; }
	if (status === 404 || /issue with the selected model|model.*(?:not found|not exist|unavailable|may not exist)|unknown model|invalid model|do(?:es)? not have access to (?:the )?model/.test(detail)) { return 'model'; }
	return 'other';
}

const FAILURE_TEXT: Record<FailureKind, string> = {
	authentication: 'O Claude Code recusou a autenticação. Entre novamente no CLI (`claude auth login`).',
	'usage-limit': 'O Claude Code informou limite de uso ou créditos insuficientes para este modelo. Escolha outro modelo ou tente quando o limite for liberado.',
	model: 'O modelo selecionado não está disponível nesta instalação ou conta do Claude Code.',
	other: 'O Claude Code informou falha na execução.'
};

// ---------- one run ----------

interface Managed {
	view: Session;
	selection: ModelSelection;
	permissionMode?: PermissionMode;
	run?: ClaudeRun;
	busy: boolean;
	closing?: boolean;
}

type Publish = (event: Omit<HubEvent, 'seq'>) => void;

class ClaudeRun {
	private readonly pipeId = randomUUID();
	private readonly control = randomBytes(32).toString('hex');
	private readonly child;
	private pending = '';
	private streamed = '';
	private full = '';
	private stderr = '';
	private finished = false;
	/** The outcome is held until the process has really exited, so a session is never `done` while its job is still alive. */
	private outcome?: { patch: Partial<Session>; name: string };
	private cancelling = false;
	private rejected = false;
	private assistantError: string | undefined;
	private timedOut = false;
	private denied = new Set<string>();
	readonly done: Promise<void>;

	constructor(executable: string, private readonly item: Managed, private readonly publish: Publish, resume: boolean, private readonly persist: (session: Session) => void) {
		const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompts', 'none',
			'--model', item.selection.modelID];
		if (item.selection.variant) { args.push('--effort', item.selection.variant); }
		if (item.permissionMode && item.permissionMode !== 'default') { args.push('--permission-mode', item.permissionMode); }
		args.push(resume ? '--resume' : '--session-id', item.view.id);
		const env: NodeJS.ProcessEnv = {};
		for (const [key, value] of Object.entries(process.env)) { if (!/^SINGULARITY_/i.test(key)) { env[key] = value; } }
		env.SINGULARITY_JOB_CONTROL = this.control;
		this.child = spawn(helper, ['run-cli', String(process.pid), this.pipeId, currentWindowsUser().sid, item.view.workspace!, executable, ...args],
			{ env, windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
		this.done = new Promise<void>(resolve => {
			const timer = setTimeout(() => { this.timedOut = true; void this.stop().catch(() => undefined); }, runTimeoutMs);
			timer.unref();
			let ended = false;
			const end = () => {
				if (ended) { return; }
				ended = true;
				clearTimeout(timer);
				// Whatever still holds the pipes (a grandchild that escaped the job) must not keep the session `running` for ever.
				this.child.stdout?.destroy();
				this.child.stderr?.destroy();
				resolve();
			};
			this.child.once('error', end);
			this.child.once('close', end);
			// `close` waits for every stdio pipe to end; `exit` is the process itself. Give the last output a moment, then settle.
			this.child.once('exit', () => { setTimeout(end, 750).unref(); });
		});
		this.child.stdin.on('error', () => { /* the process may end before it reads the prompt */ });
		this.child.stdout.setEncoding('utf8');
		this.child.stdout.on('data', (chunk: string) => this.output(chunk));
		this.child.stderr.setEncoding('utf8');
		this.child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4000); });
	}

	/** The prompt goes through stdin, never through the command line: it is not visible in the process list. */
	write(prompt: string): void { this.child.stdin.end(prompt); }

	private emit(name: string): void {
		this.publish({ type: 'claude.event', sessionId: this.item.view.id, data: { name } });
	}

	private update(patch: Partial<Session>): void {
		Object.assign(this.item.view, patch, { updatedAt: Date.now() });
		this.publish({ type: 'session.changed', sessionId: this.item.view.id, data: { ...this.item.view } });
	}

	private model(name: unknown): Partial<Session> {
		if (typeof name !== 'string' || !/^[A-Za-z0-9._:/\[\]-]{1,100}$/.test(name)) { return {}; }
		return { model: { providerID: 'claude-code', modelID: name, ...(this.item.selection.variant ? { variant: this.item.selection.variant } : {}) } };
	}

	private output(chunk: string): void {
		this.pending += chunk;
		if (this.pending.length > 4 * 1024 * 1024) { void this.stop().catch(() => undefined); this.pending = ''; return; }
		let boundary;
		while ((boundary = this.pending.indexOf('\n')) >= 0) {
			const line = this.pending.slice(0, boundary).trim();
			this.pending = this.pending.slice(boundary + 1);
			if (line.startsWith('{')) { this.event(line); }
		}
	}

	private event(line: string): void {
		let event: any;
		try { event = JSON.parse(line); } catch { return; }
		if (typeof event?.session_id === 'string' && event.session_id !== this.item.view.id) { return; }
		switch (event?.type) {
			case 'system':
				if (event.subtype === 'init') {
					// The model the CLI really runs, not the alias that was asked for.
					this.update({ ...this.model(event.model), resumable: true, status: 'running', ...(typeof event.claude_code_version === 'string' ? { version: event.claude_code_version } : {}) });
					// From here the CLI conversation exists: it must survive a Hub crash, so the archive learns it now, not at the end of the run.
					try { this.persist({ ...this.item.view }); } catch { /* the run itself does not depend on the archive */ }
					this.emit('session.started');
				}
				break;
			case 'stream_event': {
				const delta = event.event?.type === 'content_block_delta' ? event.event.delta : undefined;
				if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
					this.streamed = (this.streamed + delta.text).slice(0, outputLimit);
					this.update({ status: 'running', result: this.streamed });
					this.emit('session.text.delta');
				}
				break;
			}
			case 'assistant': {
				const parts: Array<{ type?: string; text?: string; name?: string }> = Array.isArray(event.message?.content) ? event.message.content : [];
				if (typeof event.error === 'string' && /^[a-z_]{1,40}$/.test(event.error)) { this.assistantError = event.error; }
				this.full += parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('');
				const patch = this.model(event.message?.model);
				if (!this.streamed && this.full) { Object.assign(patch, { status: 'running', result: this.full.slice(0, outputLimit) }); }
				if (Object.keys(patch).length) { this.update(patch); }
				for (const part of parts) { if (part.type === 'tool_use') { this.emit('session.tool.requested'); } }
				break;
			}
			case 'rate_limit_event':
				if (event.rate_limit_info?.status === 'rejected') { this.rejected = true; }
				break;
			case 'result': {
				this.finished = true;
				for (const entry of Array.isArray(event.permission_denials) ? event.permission_denials : []) {
					if (typeof entry?.tool_name === 'string' && /^[A-Za-z0-9_.:-]{1,60}$/.test(entry.tool_name)) { this.denied.add(entry.tool_name); }
				}
				const text = typeof event.result === 'string' ? event.result.slice(0, outputLimit) : this.streamed || this.full;
				const denied = this.denied.size ? ` ${this.denied.size === 1 ? 'Uma ação foi negada' : 'Ações foram negadas'} pela política de permissão (${[...this.denied].join(', ')}).` : '';
				if (event.is_error) {
					const kind = classifyFailure(event, this.stderr, this.rejected, this.assistantError);
					this.outcome = { patch: { status: 'failed', result: this.streamed || undefined, summary: FAILURE_TEXT[kind] + denied, failure: kind }, name: 'session.failed' };
				} else {
					this.outcome = { patch: { status: 'done', result: text, summary: denied.trim() || undefined, failure: undefined }, name: 'session.completed' };
				}
				break;
			}
		}
	}

	/** Publishes how the run ended. Called by the session once it is no longer busy, so a `done` session always accepts the next prompt. */
	apply(): void {
		if (this.outcome) { this.update(this.outcome.patch); this.emit(this.outcome.name); return; }
		if (this.cancelling) { this.update({ status: 'idle', summary: 'Execução interrompida.' }); this.emit('session.interrupted'); return; }
		if (this.timedOut) { this.update({ status: 'failed', summary: 'O Claude Code excedeu o tempo limite e foi encerrado.' }); return; }
		const kind = classifyFailure(undefined, this.stderr, this.rejected, this.assistantError);
		this.update({ status: 'failed', failure: kind, summary: kind === 'other' ? `O Claude Code encerrou sem concluir a tarefa (código ${this.child.exitCode ?? 'desconhecido'}).` : FAILURE_TEXT[kind] });
		this.emit('session.failed');
	}

	/** Terminates the whole Job Object, so no child of the CLI (a shell it started, an MCP server) survives. */
	async stop(): Promise<void> {
		if (this.child.exitCode !== null || this.child.killed && this.finished) { return; }
		this.cancelling = !this.timedOut;
		const stopped = spawnSync(helper, ['stop-job', this.pipeId, String(this.child.pid)], { input: this.control, windowsHide: true, timeout: 5000 });
		if (stopped.status !== 0 || stopped.stdout.toString('ascii') !== 'stopped') {
			if (this.child.exitCode !== null) { return; }
			throw new ClaudeCodeError('O helper não confirmou o encerramento do Job Object do Claude Code.');
		}
	}
}

// ---------- sessions ----------

export class ClaudeCodeSessions {
	private readonly sessions = new Map<string, Managed>();
	private readonly history?: SessionHistory;
	private closed = false;

	constructor(private readonly publish: Publish, historyDir?: string) {
		if (historyDir && process.platform === 'win32') { this.history = new SessionHistory(historyDir, helper, 'claude-code'); }
	}

	recover(): void { this.history?.load(); }

	list(): Session[] {
		const historical = this.history?.list().filter(session => !this.sessions.has(session.id)) ?? [];
		return [...[...this.sessions.values()].map(item => ({ ...item.view })), ...historical];
	}

	has(id: string): boolean { return this.sessions.has(id); }

	owns(id: string): boolean { return this.sessions.has(id) || (this.history?.list().some(session => session.id === id) ?? false); }

	async catalog(): Promise<CatalogResult> {
		const facts = await inspectClaude();
		if ('reason' in facts) { return { services: [], service: 'claude-code', providers: [], hiddenModels: 0, unavailable: facts.reason }; }
		const providers = claudeProviders(facts);
		return { services: [], service: 'claude-code', providers, default: { providerID: 'claude-code', modelID: facts.aliases.includes('sonnet') ? 'sonnet' : facts.aliases[0] }, hiddenModels: 0 };
	}

	private async validated(selection: ModelSelection | undefined): Promise<{ facts: ClaudeFacts; chosen: ModelSelection }> {
		const facts = await inspectClaude();
		if ('reason' in facts) { throw new ClaudeCodeError(facts.reason); }
		const fallback = facts.aliases.includes('sonnet') ? 'sonnet' : facts.aliases[0];
		return { facts, chosen: validateSelection(claudeProviders(facts), selection ?? { providerID: 'claude-code', modelID: fallback }) };
	}

	async create(directory: string, selection?: ModelSelection, permissionMode?: PermissionMode): Promise<Session> {
		if (this.closed || this.sessions.size >= maxSessions || !isAbsolute(directory)) { throw new ClaudeCodeError('Escolha um workspace local absoluto ou encerre uma sessão existente.'); }
		const workspace = await realpath(directory).catch(() => undefined);
		if (!workspace || !(await stat(workspace)).isDirectory()) { throw new ClaudeCodeError('O diretório do workspace não existe.'); }
		const { facts, chosen } = await this.validated(selection);
		const id = randomUUID();
		const at = Date.now();
		const item: Managed = {
			selection: chosen, permissionMode, busy: false,
			view: { id, harness: 'claude-code', title: 'Claude Code', status: 'idle', workspace, version: facts.version, createdAt: at, updatedAt: at,
				model: { providerID: chosen.providerID, modelID: chosen.modelID, ...(chosen.variant ? { variant: chosen.variant } : {}) }, ...(permissionMode ? { permissionMode } : {}) }
		};
		this.sessions.set(id, item);
		this.history?.save(item.view);
		this.publish({ type: 'session.changed', sessionId: id, data: { ...item.view } });
		return { ...item.view };
	}

	private item(id: string): Managed {
		const item = this.sessions.get(id);
		if (!item || item.closing) { throw new ClaudeCodeError('Sessão Claude Code indisponível.'); }
		return item;
	}

	prompt(id: string, text: string): void {
		const item = this.item(id);
		if (item.busy || !text.trim() || text.length > promptLimit) { throw new ClaudeCodeError('Há uma tarefa ativa ou o prompt está vazio ou excede o limite.'); }
		const executable = claudeExecutable();
		if (!executable) { throw new ClaudeCodeError('Claude Code CLI não foi encontrado.'); }
		item.busy = true;
		const at = Date.now();
		this.history?.save({ ...item.view, status: 'waiting', updatedAt: at }, { prompt: text, status: 'waiting', at });
		Object.assign(item.view, { status: 'waiting', prompt: text, result: undefined, summary: undefined, failure: undefined, updatedAt: at });
		this.publish({ type: 'session.changed', sessionId: id, data: { ...item.view } });
		void this.execute(item, executable, text, at).finally(() => { item.busy = false; item.run = undefined; });
	}

	private async execute(item: Managed, executable: string, text: string, at: number): Promise<void> {
		try {
			// `resumable` is only set once the CLI reported its session; a run that failed before that must start the session, not resume it.
			const run = new ClaudeRun(executable, item, this.publish, item.view.resumable === true, session => this.history?.save(session));
			item.run = run;
			run.write(text);
			await run.done;
			item.busy = false;
			item.run = undefined;
			run.apply();
		} catch (error) {
			Object.assign(item.view, { status: 'failed', summary: error instanceof ClaudeCodeError ? error.message : 'A execução do Claude Code não pôde ser confirmada.', updatedAt: Date.now() });
			this.publish({ type: 'session.changed', sessionId: item.view.id, data: { ...item.view } });
		}
		try {
			this.history?.save(item.view, { prompt: text, result: item.view.result, status: item.view.status, at }, true);
		} catch { /* The visible result stays available if protected persistence fails. */ }
	}

	async setModel(id: string, selection: ModelSelection): Promise<ModelInfo | undefined> {
		const item = this.item(id);
		if (item.busy) { throw new ClaudeCodeError('Aguarde a tarefa terminar para trocar o modelo ou o esforço.'); }
		const { chosen } = await this.validated(selection);
		if (item.busy) { throw new ClaudeCodeError('Aguarde a tarefa terminar para trocar o modelo ou o esforço.'); }
		item.selection = chosen;
		item.view.model = { providerID: chosen.providerID, modelID: chosen.modelID, ...(chosen.variant ? { variant: chosen.variant } : {}) };
		item.view.updatedAt = Date.now();
		this.publish({ type: 'session.changed', sessionId: id, data: { ...item.view } });
		return { ...item.view.model };
	}

	async interrupt(id: string): Promise<boolean> {
		const item = this.item(id);
		if (!item.run) { return false; }
		await item.run.stop();
		return true;
	}

	async stop(id: string): Promise<void> {
		const item = this.item(id);
		item.closing = true;
		try {
			await item.run?.stop();
			while (item.busy) { await delay(50); }
			this.sessions.delete(id);
			const archived: Session = { ...item.view, historical: true, updatedAt: Date.now() };
			this.history?.save(archived);
			const { prompt, result, ...metadata } = archived;
			this.publish({ type: 'session.changed', sessionId: id, data: metadata });
		} catch (error) { item.closing = false; throw error; }
	}

	private async scopedHistory(id: string, directory: string): Promise<Session> {
		const workspace = await realpath(directory).catch(() => undefined);
		const session = this.list().find(entry => entry.id === id);
		if (!session?.workspace || !workspace || workspace.toLowerCase() !== session.workspace.toLowerCase()) { throw new ClaudeCodeError('Histórico indisponível neste workspace.'); }
		return session;
	}

	async historyFor(id: string, directory: string): Promise<Turn[]> { await this.scopedHistory(id, directory); return this.history?.turns(id) ?? []; }

	async deleteHistory(id: string, directory: string): Promise<{ deleted: boolean }> {
		const session = await this.scopedHistory(id, directory);
		if (!session.historical) { throw new ClaudeCodeError('Encerre a sessão antes de excluir o histórico.'); }
		this.history?.delete(id);
		this.publish({ type: 'session.removed', sessionId: id });
		return { deleted: true };
	}

	/**
	 * Brings an archived session back as a live one. It only makes the session usable again: no process starts, and the next prompt
	 * resumes the CLI conversation by id. A session whose CLI conversation never started cannot be resumed and is refused.
	 */
	async reopen(id: string, directory: string): Promise<Session> {
		if (this.closed || this.sessions.size >= maxSessions) { throw new ClaudeCodeError('Encerre uma sessão existente antes de reabrir outra.'); }
		const session = await this.scopedHistory(id, directory);
		if (!session.historical || this.sessions.has(id)) { throw new ClaudeCodeError('Esta sessão já está aberta.'); }
		if (session.resumable !== true) { throw new ClaudeCodeError('Esta sessão nunca iniciou uma conversa no Claude Code e não pode ser retomada.'); }
		const { chosen } = await this.validated(session.model ? { providerID: session.model.providerID, modelID: session.model.modelID, variant: session.model.variant } : undefined)
			.catch(async () => this.validated(undefined));
		const { historical, prompt, result, ...rest } = session;
		const live: Session = { ...rest, status: 'idle', updatedAt: Date.now(), summary: undefined };
		this.sessions.set(id, { view: live, selection: chosen, permissionMode: session.permissionMode as PermissionMode | undefined, busy: false });
		this.history?.save(live);
		this.publish({ type: 'session.changed', sessionId: id, data: { ...live } });
		return { ...live };
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled([...this.sessions.keys()].map(id => this.stop(id)));
	}
}

export function claudeService(state: { ok: boolean; reason?: string }): ServiceInfo {
	return state.ok ? { id: 'claude-code', name: 'Claude Code', status: 'available' } : { id: 'claude-code', name: 'Claude Code', status: 'unavailable', reason: state.reason };
}
