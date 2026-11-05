import { managedProviderPath } from './providerInstall';
// Codex CLI adapter: runs the real `codex exec --json` and turns its structured JSONL events into Hub sessions. Nothing here reads the
// terminal, calls the OpenAI API, or touches the CLI's credential files; authentication is whatever `codex login` already set up.
//
// What the CLI really offers (Codex CLI 0.166.0), and therefore what this adapter does and does not do:
//   * Catalog: `codex debug models` prints the model catalog as JSON, with the effort levels each model supports. It is read, reduced to
//     an allow-list and cached for a minute; nothing is assumed.
//   * Events are per item, not per token: `agent_message`, `command_execution`, `file_change`... arrive when they start/complete. A task
//     with several steps therefore streams step by step; one short answer arrives at once. (Token streaming exists only in the
//     experimental app-server protocol, which is not used.)
//   * The stream does NOT say which model ran. The session shows the model that was requested, validated against the catalog; the
//     docs and the UI state that this is the request, not a report from the CLI.
//   * Like Claude Code, Codex runs one process per prompt (inside a Job Object, via the helper's `run-cli` mode); the conversation lives
//     in the CLI's own store and continues with `codex exec resume <thread id>`. Crash recovery is therefore the Claude Code model:
//     the run in flight is lost when the Hub dies, the session stays in the protected history and can be reopened.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CatalogError, CatalogProvider, CatalogResult, ModelSelection, validateSelection } from './catalog';
import { SessionHistory, Turn } from './history';
import { HubEvent, ModelInfo, Session } from './protocol';
import { currentWindowsUser } from './secure';

const helper = join(__dirname, 'singularity-job.exe');
const outputLimit = 12000;
const maxSessions = 8;
const promptLimit = 16000;
const runTimeoutMs = 30 * 60 * 1000;
const factsTtlMs = 60_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EFFORT_ID = /^[A-Za-z0-9._-]{1,24}$/;
const THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export class CodexError extends Error { }

/** Sandbox modes a session may ask for. `danger-full-access` and the CLI's bypass flags are never offered. */
export const CODEX_PERMISSION_MODES = ['read-only', 'workspace-write'] as const;
export type CodexPermissionMode = typeof CODEX_PERMISSION_MODES[number];

export function parseCodexPermissionMode(value: unknown): CodexPermissionMode | undefined {
	if (value === undefined || value === null || value === '') { return undefined; }
	if (typeof value === 'string' && (CODEX_PERMISSION_MODES as readonly string[]).includes(value)) { return value as CodexPermissionMode; }
	throw new CatalogError('O modo de permissão solicitado não é permitido.');
}

// ---------- discovery ----------

/** The native `codex.exe`. The npm shim (`codex.cmd` → `codex.js`) only forwards to it, so it is resolved instead of going through node. */
export function codexExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (process.platform !== 'win32' || !existsSync(helper)) { return undefined; }
	const explicit = env.SINGULARITY_CODEX_CLI;
	if (explicit) { return isAbsolute(explicit) && /\.exe$/i.test(explicit) && existsSync(explicit) ? explicit : undefined; }
	const paths = (env.PATH ?? env.Path ?? '').split(delimiter);
	if (env.USERPROFILE) { paths.push(join(env.USERPROFILE, '.local', 'bin')); }
	if (env.LOCALAPPDATA) { paths.push(join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')); }
	for (const entry of paths) {
		const directory = entry.replace(/^"|"$/g, '');
		if (!isAbsolute(directory)) { continue; }
		if (existsSync(join(directory, 'codex.exe'))) { return join(directory, 'codex.exe'); }
		const vendor = join(directory, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor');
		if (!existsSync(vendor)) { continue; }
		for (const triple of readdirSync(vendor)) {
			const candidate = join(vendor, triple, 'bin', 'codex.exe');
			if (existsSync(candidate)) { return candidate; }
		}
	}
	const managed = managedProviderPath('codex-cli', env);
	return managed && existsSync(managed) ? managed : undefined;
}

function capture(executable: string, args: string[], timeout = 20000): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		execFile(executable, args, { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: dirname(executable) }, (error, stdout, stderr) => {
			resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
		});
	});
}

export interface CodexModel { id: string; name: string; efforts: string[]; defaultEffort?: string }

/**
 * The listed models of `codex debug models`, reduced to what the IDE needs. Hidden models (internal reviewers, reserves) are not
 * offered, and every field is built from typed pieces: the raw catalog carries long internal instructions that must never travel.
 */
export function parseCodexModels(raw: unknown): CodexModel[] {
	const list: unknown[] = typeof raw === 'object' && raw !== null && Array.isArray((raw as { models?: unknown }).models) ? (raw as { models: unknown[] }).models : [];
	const models: Array<CodexModel & { priority: number }> = [];
	for (const entry of list.slice(0, 200)) {
		if (typeof entry !== 'object' || entry === null) { continue; }
		const item = entry as Record<string, unknown>;
		if (item.visibility !== 'list' || typeof item.slug !== 'string' || !MODEL_ID.test(item.slug)) { continue; }
		const efforts: string[] = [];
		for (const level of Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels.slice(0, 12) : []) {
			const id = typeof level === 'object' && level !== null ? (level as { effort?: unknown }).effort : undefined;
			if (typeof id === 'string' && EFFORT_ID.test(id) && !efforts.includes(id)) { efforts.push(id); }
		}
		const name = typeof item.display_name === 'string' && item.display_name.length > 0 && item.display_name.length <= 80 ? item.display_name : item.slug;
		const defaultEffort = typeof item.default_reasoning_level === 'string' && efforts.includes(item.default_reasoning_level) ? item.default_reasoning_level : undefined;
		if (!models.some(model => model.id === item.slug)) {
			models.push({ id: item.slug, name, efforts, defaultEffort, priority: typeof item.priority === 'number' ? item.priority : 1000 });
		}
	}
	return models.sort((a, b) => a.priority - b.priority).map(({ priority, ...model }) => model);
}

export interface CodexFacts {
	executable: string;
	version: string;
	models: CodexModel[];
	/** How the CLI is logged in: `chatgpt` or `api-key`. Never a token. */
	login: 'chatgpt' | 'api-key' | 'other';
}

let cachedFacts: { at: number; promise: Promise<CodexFacts | { reason: string; authenticationRequired?: boolean; version?: string }> } | undefined;

export function inspectCodex(refresh = false): Promise<CodexFacts | { reason: string; authenticationRequired?: boolean; version?: string }> {
	if (cachedFacts && !refresh && Date.now() - cachedFacts.at < factsTtlMs) { return cachedFacts.promise; }
	const promise = (async (): Promise<CodexFacts | { reason: string; authenticationRequired?: boolean; version?: string }> => {
		const executable = codexExecutable();
		if (!executable) { return { reason: 'Codex CLI ou o helper Windows do Singularity não foi encontrado.' }; }
		const [version, login, models] = await Promise.all([capture(executable, ['--version']), capture(executable, ['login', 'status']), capture(executable, ['debug', 'models'], 30000)]);
		const versionText = /\d+\.\d+\.\d+/.exec(version.stdout)?.[0];
		if (version.code !== 0 || !versionText) { return { reason: 'Não foi possível confirmar a versão do Codex CLI.' }; }
		// `codex login status` prints its answer on stderr.
		const loginText = `${login.stdout}
${login.stderr}`.trim();
		if (login.code !== 0 || !/^Logged in/im.test(loginText)) { return { authenticationRequired: true, version: versionText, reason: 'Entre no Codex CLI (`codex login`) antes de usar este serviço.' }; }
		let parsed: CodexModel[] = [];
		try { parsed = parseCodexModels(JSON.parse(models.stdout)); } catch { /* an unreadable catalog offers nothing */ }
		if (models.code !== 0 || !parsed.length) { return { reason: 'O catálogo de modelos desta versão do Codex CLI não pôde ser confirmado.' }; }
		const method = /ChatGPT/i.test(loginText) ? 'chatgpt' : /API key/i.test(loginText) ? 'api-key' : 'other';
		return { executable, version: versionText, models: parsed, login: method };
	})();
	cachedFacts = { at: Date.now(), promise };
	return promise;
}

export async function codexRunnable(): Promise<{ ok: boolean; reason?: string }> {
	const facts = await inspectCodex();
	return 'reason' in facts ? { ok: false, reason: facts.reason } : { ok: true };
}

export function codexProviders(facts: CodexFacts): CatalogProvider[] {
	return [{ id: 'codex-cli', name: 'Codex CLI', models: facts.models.map(({ id, name, efforts }) => ({ id, name, efforts })) }];
}

// ---------- failures ----------

export type CodexFailure = 'authentication' | 'usage-limit' | 'model' | 'other';

/** Classifies a failed turn from the CLI's own message. The message itself is never shown: it carries request ids and URLs. */
export function classifyCodexFailure(message: string | undefined, stderr = ''): CodexFailure {
	const detail = `${message ?? ''}\n${stderr}`.toLowerCase();
	if (/\b401\b|unauthori[sz]ed|not logged in|missing bearer|log ?in again|token (?:expired|invalid)|authentication/.test(detail)) { return 'authentication'; }
	if (/usage limit|rate limit|\b429\b|too many requests|quota|out of credits|credits? (?:required|exhausted)|limit (?:reached|exceeded)/.test(detail)) { return 'usage-limit'; }
	if (/model.*(?:not supported|not found|unavailable|does not exist|unknown)|unknown model|invalid model|not supported when using codex/.test(detail)) { return 'model'; }
	return 'other';
}

const FAILURE_TEXT: Record<CodexFailure, string> = {
	authentication: 'O Codex CLI recusou a autenticação. Entre novamente (`codex login`).',
	'usage-limit': 'O Codex CLI informou limite de uso ou créditos insuficientes. Tente de novo quando o limite for liberado.',
	model: 'O modelo ou o esforço selecionado não está disponível nesta instalação ou conta do Codex CLI.',
	other: 'O Codex CLI informou falha na execução.'
};

// ---------- one run ----------

interface Managed {
	view: Session;
	selection: ModelSelection;
	permissionMode: CodexPermissionMode;
	run?: CodexRun;
	busy: boolean;
	closing?: boolean;
}

type Publish = (event: Omit<HubEvent, 'seq'>) => void;

class CodexRun {
	private readonly pipeId = randomUUID();
	private readonly control = randomBytes(32).toString('hex');
	private readonly child;
	private pending = '';
	private messages: string[] = [];
	private stderr = '';
	private failureMessage: string | undefined;
	private outcome?: { patch: Partial<Session>; name: string };
	private cancelling = false;
	private timedOut = false;
	readonly done: Promise<void>;

	constructor(executable: string, private readonly item: Managed, private readonly publish: Publish, private readonly persist: (session: Session) => void) {
		const resumeId = item.view.resumeId;
		const args = ['exec'];
		if (resumeId) { args.push('resume'); }
		args.push('--json', '--skip-git-repo-check', '-m', item.selection.modelID);
		if (item.selection.variant) { args.push('-c', `model_reasoning_effort="${item.selection.variant}"`); }
		if (resumeId) {
			if (!THREAD_ID.test(resumeId)) { throw new CodexError('O identificador da conversa do Codex CLI é inválido.'); }
			args.push('-c', `sandbox_mode="${item.permissionMode}"`, resumeId);
		} else {
			args.push('-s', item.permissionMode, '-C', item.view.workspace!);
		}
		args.push('-');
		const env: NodeJS.ProcessEnv = {};
		for (const [key, value] of Object.entries(process.env)) { if (!/^SINGULARITY_/i.test(key)) { env[key] = value; } }
		env.SINGULARITY_JOB_CONTROL = this.control;
		// detached: the helper must not live in the Hub's own job, or it would die with it before it can end the agent's job.
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

	/** The prompt goes through stdin (`-`), never through the command line. */
	write(prompt: string): void { this.child.stdin.end(prompt); }

	private emit(name: string): void {
		this.publish({ type: 'codex.event', sessionId: this.item.view.id, data: { name } });
	}

	private update(patch: Partial<Session>): void {
		Object.assign(this.item.view, patch, { updatedAt: Date.now() });
		this.publish({ type: 'session.changed', sessionId: this.item.view.id, data: { ...this.item.view } });
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
		switch (event?.type) {
			case 'thread.started':
				if (typeof event.thread_id === 'string' && THREAD_ID.test(event.thread_id)) {
					// From here the CLI conversation exists: it must survive a Hub crash, so the archive learns it now.
					this.update({ resumeId: event.thread_id, resumable: true, status: 'running' });
					try { this.persist({ ...this.item.view }); } catch { /* the run does not depend on the archive */ }
					this.emit('session.started');
				}
				break;
			case 'turn.started':
				this.update({ status: 'running' });
				this.emit('session.turn.started');
				break;
			case 'item.started':
			case 'item.updated':
			case 'item.completed': {
				const kind = typeof event.item?.type === 'string' && /^[a-z_]{1,40}$/.test(event.item.type) ? event.item.type : 'item';
				if (event.type === 'item.completed' && kind === 'agent_message' && typeof event.item.text === 'string') {
					this.messages.push(event.item.text);
					this.update({ status: 'running', result: this.messages.join('\n\n').slice(0, outputLimit) });
				}
				// Only the kind of step is published: a command line or a path can carry secrets.
				this.emit(`session.${kind}.${event.type.slice(5)}`);
				break;
			}
			case 'turn.completed':
				this.outcome = { patch: { status: 'done', result: this.messages.join('\n\n').slice(0, outputLimit) || undefined, summary: undefined, failure: undefined }, name: 'session.completed' };
				break;
			case 'turn.failed':
			case 'error': {
				const message = typeof event.error?.message === 'string' ? event.error.message : typeof event.message === 'string' ? event.message : undefined;
				this.failureMessage = message ?? this.failureMessage;
				if (event.type === 'turn.failed') {
					const kind = classifyCodexFailure(this.failureMessage, this.stderr);
					this.outcome = { patch: { status: 'failed', result: this.messages.join('\n\n').slice(0, outputLimit) || undefined, summary: FAILURE_TEXT[kind], failure: kind }, name: 'session.failed' };
				}
				break;
			}
		}
	}

	/** The outcome is applied only after the process has exited, so a session is never `done` while its job is still alive. */
	/** Publishes how the run ended. Called by the session once it is no longer busy, so a `done` session always accepts the next prompt. */
	apply(): void {
		if (this.cancelling) { this.update({ status: 'idle', summary: 'Execução interrompida.' }); this.emit('session.interrupted'); return; }
		if (this.outcome) { this.update(this.outcome.patch); this.emit(this.outcome.name); return; }
		if (this.timedOut) { this.update({ status: 'failed', summary: 'O Codex CLI excedeu o tempo limite e foi encerrado.' }); return; }
		const kind = classifyCodexFailure(this.failureMessage, this.stderr);
		this.update({ status: 'failed', failure: kind, summary: kind === 'other' ? `O Codex CLI encerrou sem concluir a tarefa (código ${this.child.exitCode ?? 'desconhecido'}).` : FAILURE_TEXT[kind] });
		this.emit('session.failed');
	}

	/** Terminates the whole Job Object, so nothing the agent started survives. */
	async stop(): Promise<void> {
		if (this.child.exitCode !== null) { return; }
		this.cancelling = !this.timedOut;
		const stopped = spawnSync(helper, ['stop-job', this.pipeId, String(this.child.pid)], { input: this.control, windowsHide: true, timeout: 5000 });
		if (stopped.status !== 0 || stopped.stdout.toString('ascii') !== 'stopped') {
			if (this.child.exitCode !== null) { return; }
			throw new CodexError('O helper não confirmou o encerramento do Job Object do Codex CLI.');
		}
	}
}

// ---------- sessions ----------

export class CodexSessions {
	private readonly sessions = new Map<string, Managed>();
	private readonly history?: SessionHistory;
	private closed = false;

	constructor(private readonly publish: Publish, historyDir?: string) {
		if (historyDir && process.platform === 'win32') { this.history = new SessionHistory(historyDir, helper, 'codex-cli'); }
	}

	recover(): void { this.history?.load(); }

	list(): Session[] {
		const historical = this.history?.list().filter(session => !this.sessions.has(session.id)) ?? [];
		return [...[...this.sessions.values()].map(item => ({ ...item.view })), ...historical];
	}

	has(id: string): boolean { return this.sessions.has(id); }

	owns(id: string): boolean { return this.sessions.has(id) || (this.history?.list().some(session => session.id === id) ?? false); }

	async catalog(): Promise<CatalogResult> {
		const facts = await inspectCodex();
		if ('reason' in facts) { return { services: [], service: 'codex-cli', providers: [], hiddenModels: 0, unavailable: facts.reason }; }
		return { services: [], service: 'codex-cli', providers: codexProviders(facts), default: { providerID: 'codex-cli', modelID: facts.models[0].id }, hiddenModels: 0 };
	}

	private async validated(selection: ModelSelection | undefined): Promise<{ facts: CodexFacts; chosen: ModelSelection }> {
		const facts = await inspectCodex();
		if ('reason' in facts) { throw new CodexError(facts.reason); }
		return { facts, chosen: validateSelection(codexProviders(facts), selection ?? { providerID: 'codex-cli', modelID: facts.models[0].id }) };
	}

	async create(directory: string, selection?: ModelSelection, permissionMode?: CodexPermissionMode): Promise<Session> {
		if (this.closed || this.sessions.size >= maxSessions || !isAbsolute(directory)) { throw new CodexError('Escolha um workspace local absoluto ou encerre uma sessão existente.'); }
		const workspace = await realpath(directory).catch(() => undefined);
		if (!workspace || !(await stat(workspace)).isDirectory()) { throw new CodexError('O diretório do workspace não existe.'); }
		const { facts, chosen } = await this.validated(selection);
		const id = randomUUID();
		const at = Date.now();
		const mode = permissionMode ?? 'read-only';
		const item: Managed = {
			selection: chosen, permissionMode: mode, busy: false,
			view: { id, harness: 'codex-cli', title: 'Codex CLI', status: 'idle', workspace, version: facts.version, createdAt: at, updatedAt: at, permissionMode: mode,
				model: { providerID: chosen.providerID, modelID: chosen.modelID, ...(chosen.variant ? { variant: chosen.variant } : {}) } }
		};
		this.sessions.set(id, item);
		this.history?.save(item.view);
		this.publish({ type: 'session.changed', sessionId: id, data: { ...item.view } });
		return { ...item.view };
	}

	private item(id: string): Managed {
		const item = this.sessions.get(id);
		if (!item || item.closing) { throw new CodexError('Sessão Codex CLI indisponível.'); }
		return item;
	}

	prompt(id: string, text: string): void {
		const item = this.item(id);
		if (item.busy || !text.trim() || text.length > promptLimit) { throw new CodexError('Há uma tarefa ativa ou o prompt está vazio ou excede o limite.'); }
		const executable = codexExecutable();
		if (!executable) { throw new CodexError('Codex CLI não foi encontrado.'); }
		item.busy = true;
		const at = Date.now();
		this.history?.save({ ...item.view, status: 'waiting', updatedAt: at }, { prompt: text, status: 'waiting', at });
		Object.assign(item.view, { status: 'waiting', prompt: text, result: undefined, summary: undefined, failure: undefined, updatedAt: at });
		this.publish({ type: 'session.changed', sessionId: id, data: { ...item.view } });
		void this.execute(item, executable, text, at).finally(() => { item.busy = false; item.run = undefined; });
	}

	private async execute(item: Managed, executable: string, text: string, at: number): Promise<void> {
		try {
			const run = new CodexRun(executable, item, this.publish, session => this.history?.save(session));
			item.run = run;
			run.write(text);
			await run.done;
			item.busy = false;
			item.run = undefined;
			run.apply();
		} catch (error) {
			Object.assign(item.view, { status: 'failed', summary: error instanceof CodexError ? error.message : 'A execução do Codex CLI não pôde ser confirmada.', updatedAt: Date.now() });
			this.publish({ type: 'session.changed', sessionId: item.view.id, data: { ...item.view } });
		}
		try {
			this.history?.save(item.view, { prompt: text, result: item.view.result, status: item.view.status, at }, true);
		} catch { /* The visible result stays available if protected persistence fails. */ }
	}

	async setModel(id: string, selection: ModelSelection): Promise<ModelInfo | undefined> {
		const item = this.item(id);
		if (item.busy) { throw new CodexError('Aguarde a tarefa terminar para trocar o modelo ou o esforço.'); }
		const { chosen } = await this.validated(selection);
		if (item.busy) { throw new CodexError('Aguarde a tarefa terminar para trocar o modelo ou o esforço.'); }
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
		if (!session?.workspace || !workspace || workspace.toLowerCase() !== session.workspace.toLowerCase()) { throw new CodexError('Histórico indisponível neste workspace.'); }
		return session;
	}

	async historyFor(id: string, directory: string): Promise<Turn[]> { await this.scopedHistory(id, directory); return this.history?.turns(id) ?? []; }

	async deleteHistory(id: string, directory: string): Promise<{ deleted: boolean }> {
		const session = await this.scopedHistory(id, directory);
		if (!session.historical) { throw new CodexError('Encerre a sessão antes de excluir o histórico.'); }
		this.history?.delete(id);
		this.publish({ type: 'session.removed', sessionId: id });
		return { deleted: true };
	}

	/** Brings an archived session back as a live one. No process starts; the next prompt resumes the CLI conversation by thread id. */
	async reopen(id: string, directory: string): Promise<Session> {
		if (this.closed || this.sessions.size >= maxSessions) { throw new CodexError('Encerre uma sessão existente antes de reabrir outra.'); }
		const session = await this.scopedHistory(id, directory);
		if (!session.historical || this.sessions.has(id)) { throw new CodexError('Esta sessão já está aberta.'); }
		if (session.resumable !== true || !session.resumeId || !THREAD_ID.test(session.resumeId)) { throw new CodexError('Esta sessão nunca iniciou uma conversa no Codex CLI e não pode ser retomada.'); }
		const { chosen } = await this.validated(session.model ? { providerID: session.model.providerID, modelID: session.model.modelID, variant: session.model.variant } : undefined)
			.catch(async () => this.validated(undefined));
		const { historical, prompt, result, ...rest } = session;
		const live: Session = { ...rest, status: 'idle', updatedAt: Date.now(), summary: undefined };
		const mode = session.permissionMode === 'workspace-write' ? 'workspace-write' : 'read-only';
		this.sessions.set(id, { view: live, selection: chosen, permissionMode: mode, busy: false });
		this.history?.save(live);
		this.publish({ type: 'session.changed', sessionId: id, data: { ...live } });
		return { ...live };
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled([...this.sessions.keys()].map(id => this.stop(id)));
	}
}
