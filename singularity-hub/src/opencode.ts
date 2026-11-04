import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { delimiter, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';
import { CatalogResult, ModelSelection, sanitizeCatalog, serviceList, validateSelection } from './catalog';
import { SessionHistory, Turn } from './history';
import { HubEvent, ModelInfo, Session } from './protocol';
import { currentWindowsUser, ensureSecureDir, readSecureFile, writeFileAtomic } from './secure';

const methods = {
	create: ['/api/session', 'POST', 'session.create'],
	remove: ['/api/session/{sessionID}', 'DELETE', 'session.remove'],
	state: ['/api/session/{sessionID}', 'GET', 'session.get'],
	prompt: ['/api/session/{sessionID}/prompt', 'POST', 'session.prompt'],
	interrupt: ['/api/session/{sessionID}/interrupt', 'POST', 'session.interrupt'],
	wait: ['/api/experimental/session/{sessionID}/wait', 'POST', 'experimental.session.wait'],
	messages: ['/api/session/{sessionID}/message', 'GET', 'session.message.list'],
	events: ['/api/event', 'GET', 'event.subscribe'],
	providers: ['/api/provider', 'GET', 'provider.list'],
	models: ['/api/model', 'GET', 'model.list'],
	defaultModel: ['/api/model/default', 'GET', 'model.default'],
	switchModel: ['/api/session/{sessionID}/model', 'POST', 'session.switchModel']
} as const;

const helper = join(__dirname, 'singularity-job.exe');
const deadline = 15000;
const maxSessions = 8;
const outputLimit = 12000;

export class OpenCodeError extends Error { }

interface RawModel { id?: unknown; providerID?: unknown; variant?: unknown }

/** The model a session reports, reduced to the three fields the IDE shows. Never the raw object: it can carry settings. */
function modelOf(raw: RawModel | undefined): ModelInfo | undefined {
	if (!raw || typeof raw.id !== 'string' || typeof raw.providerID !== 'string') {
		return undefined;
	}
	return { providerID: raw.providerID, modelID: raw.id, ...(typeof raw.variant === 'string' && raw.variant ? { variant: raw.variant } : {}) };
}

/** Reads the real catalog from a running OpenCode server and reduces it to the allow-listed form. */
async function readCatalog(server: OpenCodeProcess): Promise<ReturnType<typeof sanitizeCatalog>> {
	const [providers, models, fallback] = await Promise.all([
		server.request('providers'), server.request('models'), server.request('defaultModel').catch(() => undefined)
	]);
	return sanitizeCatalog(providers, models, fallback);
}

/** Whether the OpenCode adapter can run on this machine, with the reason when it cannot. */
export function openCodeRunnable(): { ok: boolean; reason?: string } {
	return openCodeExecutable() ? { ok: true } : { ok: false, reason: 'OpenCode v2 ou o helper Windows do Singularity não foi encontrado.' };
}

export function openCodeExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const explicit = env.SINGULARITY_OPENCODE;
	if (explicit) { return isAbsolute(explicit) && /\.exe$/i.test(explicit) && existsSync(explicit) ? explicit : undefined; }
	if (process.platform !== 'win32' || !existsSync(helper)) {
		return undefined;
	}
	const paths = (env.PATH ?? env.Path ?? '').split(delimiter);
	if (env.USERPROFILE) { paths.push(join(env.USERPROFILE, '.local', 'bin')); }
	if (env.LOCALAPPDATA) { paths.push(join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')); }
	for (const entry of paths) {
		const directory = entry.replace(/^"|"$/g, '');
		if (!isAbsolute(directory)) {
			continue;
		}
		for (const candidate of [join(directory, 'opencode.exe'), join(directory, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')]) {
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

async function localPort(): Promise<number> {
	const server = createServer();
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close();
				reject(new OpenCodeError('A porta local do OpenCode não pôde ser reservada.'));
				return;
			}
			server.close(error => error ? reject(error) : resolve(address.port));
		});
	});
}

interface RecoveryRecord {
	version: 1;
	sessionId: string;
	remoteId: string;
	workspace: string;
	executable: string;
	helperPid: number;
	identity: string;
	pipeId: string;
	control: string;
	authorization: string;
	origin: string;
}

const recoveryId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const loopbackOrigin = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/;

class OpenCodeProcess {
	private readonly stream = new AbortController();
	private readonly authorization: string;
	private readonly origin: string;
	private readonly pipeId: string;
	private readonly control: string;
	private readonly helperPid: number;
	private dead = false;
	private exitCode: number | null = null;

	constructor(exe: string, workspace: string, port: number, record?: RecoveryRecord) {
		if (record) {
			this.authorization = record.authorization;
			this.origin = record.origin;
			this.pipeId = record.pipeId;
			this.control = record.control;
			this.helperPid = record.helperPid;
			return;
		}
		const password = randomBytes(32).toString('hex');
		this.authorization = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
		this.origin = `http://127.0.0.1:${port}`;
		this.pipeId = randomUUID();
		this.control = randomBytes(32).toString('hex');
		const child = spawn(helper, [exe, workspace, String(port), this.pipeId, currentWindowsUser().sid], {
			env: { ...process.env, OPENCODE_PASSWORD: password, SINGULARITY_JOB_CONTROL: this.control },
			detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore']
		});
		this.helperPid = child.pid ?? 0;
		child.once('error', () => { this.dead = true; });
		child.once('close', code => { this.dead = true; this.exitCode = code; });
	}

	private controlJob(operation: 'inspect-job' | 'stop-job'): string {
		const result = spawnSync(helper, [operation, this.pipeId, String(this.helperPid)], {
			input: this.control, windowsHide: true, timeout: 3000, maxBuffer: 1024
		});
		return result.status === 0 ? result.stdout.toString('ascii') : '';
	}

	identity(): string {
		const identity = this.controlJob('inspect-job');
		if (!/^\d+(?::\d+){4}$/.test(identity)) {
			throw new OpenCodeError('O helper n�o confirmou a identidade do Job Object.');
		}
		return identity;
	}

	writeRecovery(directory: string, sessionId: string, remoteId: string, workspace: string, executable: string): void {
		const helperPid = this.helperPid;
		if (!helperPid || this.dead) {
			throw new OpenCodeError('O helper encerrou antes de registrar a sess�o.');
		}
		const input = Buffer.from(JSON.stringify({
			version: 1, sessionId, remoteId, workspace, executable, helperPid, identity: this.identity(),
			pipeId: this.pipeId, control: this.control, authorization: this.authorization, origin: this.origin
		}));
		try {
			const encrypted = spawnSync(helper, ['protect-recovery'], { input, windowsHide: true, timeout: 5000, maxBuffer: 32768 });
			if (encrypted.status !== 0 || !encrypted.stdout?.length) {
				throw new OpenCodeError('O Windows n�o protegeu os dados de recupera��o da sess�o.');
			}
			ensureSecureDir(directory);
			writeFileAtomic(join(directory, sessionId + '.dpapi'), encrypted.stdout.toString('base64'));
		} finally {
			input.fill(0);
		}
	}

	private fetch(route: string, method: string, body?: unknown, signal = AbortSignal.timeout(deadline), authenticate = true): Promise<Response> {
		return fetch(this.origin + route, {
			method, signal, redirect: 'error',
			headers: authenticate ? { Authorization: this.authorization, 'Content-Type': 'application/json' } : {},
			body: body === undefined ? undefined : JSON.stringify(body)
		});
	}

	async ready(): Promise<string> {
		const end = Date.now() + deadline;
		while (!this.dead && Date.now() < end) {
			const response = await this.fetch('/api/info', 'GET', undefined, AbortSignal.timeout(700)).catch(() => undefined);
			if (response?.ok) {
				const info = await response.json() as { version?: string };
				const unauthed = await this.fetch('/api/info', 'GET', undefined, AbortSignal.timeout(1500), false);
				await unauthed.body?.cancel();
				if (unauthed.status !== 401 || !/^v?2\./.test(info.version ?? '')) {
					throw new OpenCodeError('O servidor OpenCode não confirmou autenticação Basic e API v2.');
				}
				const document = await this.fetch('/openapi.json', 'GET');
				const schema = document.ok ? await document.json() as { paths?: Record<string, Record<string, { operationId?: string }>> } : undefined;
				if (!Object.values(methods).every(([route, method, id]) => schema?.paths?.[route]?.[method.toLowerCase()]?.operationId === id)) {
					throw new OpenCodeError('O contrato OpenAPI instalado não é compatível com este adapter.');
				}
				return info.version!;
			}
			await response?.body?.cancel();
			await delay(200);
		}
		throw new OpenCodeError('O OpenCode não iniciou em um Job Object com o servidor local disponível.');
	}

	async request<T>(operation: keyof typeof methods, id?: string, body?: unknown, signal?: AbortSignal): Promise<T> {
		const [route, method] = methods[operation];
		const response = await this.fetch(route.replace('{sessionID}', encodeURIComponent(id ?? '')), method, body, signal);
		if (!response.ok) {
			await response.body?.cancel();
			throw new OpenCodeError(`OpenCode recusou ${operation} (HTTP ${response.status}).`);
		}
		return (response.status === 204 ? undefined : await response.json()) as T;
	}

	async events(onEvent: (event: { type: string; data?: { sessionID?: string; delta?: unknown } }) => void, onClose: () => void): Promise<void> {
		const handshake = new AbortController();
		const timeout = setTimeout(() => handshake.abort(), deadline);
		let response: Response;
		try {
			response = await this.fetch(methods.events[0], 'GET', undefined, AbortSignal.any([this.stream.signal, handshake.signal]));
		} finally {
			clearTimeout(timeout);
		}
		if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
			await response.body?.cancel();
			throw new OpenCodeError('O fluxo SSE do OpenCode não está disponível.');
		}
		void (async () => {
			let pending = '';
			for await (const chunk of response.body!.pipeThrough(new TextDecoderStream())) {
				pending += chunk;
				let boundary: RegExpExecArray | null;
				while ((boundary = /\r?\n\r?\n/.exec(pending))) {
					const frame = pending.slice(0, boundary.index);
					pending = pending.slice(boundary.index + boundary[0].length);
					const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
					if (data && data.length <= 1024 * 1024) {
						onEvent(JSON.parse(data));
					}
				}
				if (pending.length > 1024 * 1024) {
					throw new Error('Oversized OpenCode SSE frame');
				}
			}
		})().catch(() => {}).finally(() => { if (!this.stream.signal.aborted) { onClose(); } });
	}

	async stop(): Promise<void> {
		this.stream.abort();
		if (this.dead && this.exitCode === 0) { return; }
		const deadline = Date.now() + 10000;
		do {
			if (this.controlJob('stop-job') === 'stopped' || (this.dead && this.exitCode === 0)) { return; }
			await delay(100);
		} while (Date.now() < deadline);
		throw new OpenCodeError('O helper n�o confirmou que a �rvore de processos foi encerrada.');
	}

}

interface Managed {
	view: Session;
	server: OpenCodeProcess;
	remoteId: string;
	run?: Promise<void>;
	closing?: boolean;
}

export class OpenCodeSessions {
	private readonly sessions = new Map<string, Managed>();
	private readonly unrecoverable = new Map<string, Session>();
	private readonly history?: SessionHistory;
	private creating = 0;
	private closed = false;
	private readonly catalogs = new Map<string, { at: number; result: Promise<CatalogResult> }>();

	constructor(private readonly publish: (event: Omit<HubEvent, 'seq'>) => void, private readonly recoveryDir?: string, historyDir?: string) {
		if (historyDir && process.platform === 'win32') { this.history = new SessionHistory(historyDir, helper); }
	}

	list(): Session[] {
		const historical = this.history?.list().filter(session => !this.sessions.has(session.id) && !this.unrecoverable.has(session.id)) ?? [];
		return [...[...this.sessions.values()].map(item => ({ ...item.view })), ...this.unrecoverable.values(), ...historical];
	}

	async recover(): Promise<void> {
		this.history?.load();
		if (!this.recoveryDir || !existsSync(this.recoveryDir)) { return; }
		const directory = this.recoveryDir;
		const expectedExecutable = openCodeExecutable();
		const files = readdirSync(directory).filter(name => name.endsWith('.dpapi') && recoveryId.test(name.slice(0, -6)));
		await Promise.all(files.slice(0, maxSessions).map(async name => {
			const id = name.slice(0, -6);
			let record: RecoveryRecord | undefined;
			let stage = 'registro protegido';
			try {
				const ciphertext = Buffer.from(readSecureFile(join(directory, name)), 'base64');
				const decrypted = spawnSync(helper, ['unprotect-recovery'], { input: ciphertext, windowsHide: true, timeout: 5000, maxBuffer: 32768 });
				try {
					if (decrypted.status !== 0) { throw new Error('invalid record'); }
					record = JSON.parse(decrypted.stdout.toString('utf8'));
				} finally {
					decrypted.stdout?.fill(0);
				}
				if (!record || record.version !== 1 || record.sessionId !== id || !recoveryId.test(record.pipeId) ||
					!Number.isSafeInteger(record.helperPid) || record.helperPid <= 0 || !loopbackOrigin.test(record.origin) ||
					!/^Basic [A-Za-z0-9+/]+=*$/.test(record.authorization) || !/^[a-f0-9]{64}$/.test(record.control) ||
					typeof record.remoteId !== 'string' || !record.remoteId || typeof record.workspace !== 'string' ||
					!isAbsolute(record.workspace) || record.executable !== expectedExecutable) {
					throw new Error('invalid identity');
				}
				stage = 'identidade do helper';
				const server = new OpenCodeProcess('', '', 0, record);
				if (server.identity() !== record.identity) { throw new Error('different job'); }
				stage = 'autentica��o HTTP';
				const version = await server.ready();
				stage = 'identidade da sess�o OpenCode';
				const { data } = await server.request<{ data: { id: string; location: { directory: string }; outcome?: string; model?: RawModel; time: { created?: number; busy?: number; idle?: number } } }>('state', record.remoteId);
				if (data.id !== record.remoteId || (await realpath(data.location.directory)).toLowerCase() !== record.workspace.toLowerCase()) {
					throw new Error('different session');
				}
				const active = (data.time.busy ?? 0) > (data.time.idle ?? 0);
				const item: Managed = { server, remoteId: record.remoteId, view: {
					id, harness: 'opencode', title: 'OpenCode', workspace: record.workspace, version,
					model: modelOf(data.model), createdAt: data.time.created, updatedAt: Date.now(), status: active ? 'running' : 'idle'
				} };
				stage = 'fluxo SSE';
				await this.subscribe(item);
				this.sessions.set(id, item);
				this.update(item, {});
				item.run = this.run(item).finally(() => { item.run = undefined; });
			} catch {
				this.unrecoverable.set(id, { id, harness: 'opencode', title: 'Sess�o n�o recuper�vel',
					status: 'failed', recovery: 'unrecoverable', summary: `Sess�o n�o recuper�vel: falha ao validar ${stage}.` });
			}
		}));
	}

	has(id: string): boolean { return this.sessions.has(id); }

	async create(directory: string, selection?: ModelSelection): Promise<Session> {
		const exe = openCodeExecutable();
		if (!exe) {
			throw new OpenCodeError('OpenCode v2 ou o helper Windows do Singularity não foi encontrado.');
		}
		if (this.closed || this.sessions.size + this.creating >= maxSessions || !isAbsolute(directory)) {
			throw new OpenCodeError('Escolha um workspace local absoluto ou encerre uma sessão existente.');
		}
		this.creating++;
		let server: OpenCodeProcess | undefined;
		try {
			const workspace = await realpath(directory).catch(() => undefined);
			if (!workspace || !(await stat(workspace)).isDirectory()) {
				throw new OpenCodeError('O diretório do workspace não existe.');
			}
			server = new OpenCodeProcess(exe, workspace, await localPort());
			const version = await server.ready();
			// the OpenCode API accepts any model and variant without checking: the choice is validated against the real catalog first
				const chosen = selection ? validateSelection((await readCatalog(server)).providers, selection) : undefined;
				const created = await server.request<{ data: { id: string; model?: RawModel; location: { directory: string } } }>('create', undefined, {
					location: { directory: workspace },
					...(chosen ? { model: { id: chosen.modelID, providerID: chosen.providerID, ...(chosen.variant ? { variant: chosen.variant } : {}) } } : {})
				});
			const remoteId = created.data.id;
			if (!remoteId || (await realpath(created.data.location.directory)).toLowerCase() !== workspace.toLowerCase() || this.closed) {
				throw new OpenCodeError('O OpenCode não confirmou o workspace selecionado.');
			}
			const item: Managed = {
				server, remoteId,
				view: { id: randomUUID(), harness: 'opencode', title: 'OpenCode', status: 'idle', workspace, version, createdAt: Date.now(), updatedAt: Date.now(), model: modelOf(created.data.model) }
			};
			await this.subscribe(item);
			if (this.closed) {
				throw new OpenCodeError('Hub is shutting down.');
			}
			if (this.recoveryDir) {
				server.writeRecovery(this.recoveryDir, item.view.id, remoteId, workspace, exe);
			}
			this.history?.save(item.view);
			this.sessions.set(item.view.id, item);
			this.update(item, {});
			return { ...item.view };
		} catch (error) {
			await server?.stop();
			throw error;
		} finally {
			this.creating--;
		}
	}

	private async subscribe(item: Managed): Promise<void> {
		await item.server.events(event => {
				if (event.data?.sessionID !== item.remoteId || !/^session\.[a-z.]+$/.test(event.type)) {
					return;
				}
				this.publish({ type: 'opencode.event', sessionId: item.view.id, data: { name: event.type } });
				if (event.type === 'session.execution.started') {
					this.update(item, { status: 'running' });
				} else if (event.type === 'session.text.delta' && typeof event.data.delta === 'string'
					&& item.view.status === 'running' && (item.view.result?.length ?? 0) < outputLimit) {
					this.update(item, { result: ((item.view.result ?? '') + event.data.delta).slice(0, outputLimit) });
				}
			}, () => this.update(item, { status: 'failed', summary: 'A conexão SSE com o OpenCode foi interrompida.' }));
	}

	private item(id: string): Managed {
		const item = this.sessions.get(id);
		if (!item || item.closing) {
			throw new OpenCodeError('Sessão OpenCode indisponível.');
		}
		return item;
	}

	private update(item: Managed, patch: Partial<Session>): void {
		Object.assign(item.view, patch);
		this.publish({ type: 'session.changed', sessionId: item.view.id, data: { ...item.view } });
	}

	prompt(id: string, text: string): void {
		const item = this.item(id);
		if (item.run || !text.trim() || text.length > 16000) {
			throw new OpenCodeError('Há uma tarefa ativa ou o prompt está vazio ou excede o limite.');
		}
		const at = Date.now();
		this.history?.save({ ...item.view, status: 'waiting', updatedAt: at }, { prompt: text, status: 'waiting', at });
		this.update(item, { status: 'waiting', prompt: text, updatedAt: at, summary: undefined, result: undefined });
		item.run = this.run(item, text).finally(() => { item.run = undefined; });
	}

	private async run(item: Managed, text?: string): Promise<void> {
		const { server, remoteId } = item;
		try {
			if (text !== undefined) { await server.request('prompt', remoteId, { text }); }
			await server.request('wait', remoteId, undefined, AbortSignal.timeout(15 * 60 * 1000));
			const { data } = await server.request<{ data: { outcome?: string; model?: RawModel } }>('state', remoteId);
			const { data: messages } = await server.request<{ data: Array<{ type: string; error?: { status?: number }; content?: Array<{ type: string; text?: string }> }> }>('messages', remoteId);
			const userIndex = messages.findIndex(message => message.type === 'user');
			const result = messages.slice(0, userIndex < 0 ? 0 : userIndex).find(message => message.type === 'assistant')?.content
				?.filter(part => part.type === 'text').map(part => part.text ?? '').join('').slice(0, outputLimit);
			const providerStatus = messages[0]?.error?.status;
			const http = Number.isInteger(providerStatus) && providerStatus! >= 400 && providerStatus! <= 599 ? ` (HTTP ${providerStatus})` : '';
			const status = data.outcome === 'succeeded' ? 'done' : !data.outcome || data.outcome === 'interrupted' ? 'idle' : 'failed';
			const prompt = text === undefined && userIndex >= 0 ? messages[userIndex].content
				?.filter(part => part.type === 'text').map(part => part.text ?? '').join('').slice(0, 16000) : undefined;
			this.update(item, { ...(prompt ? { prompt } : {}), status, result, updatedAt: Date.now(), model: modelOf(data.model) ?? item.view.model, summary: data.outcome === 'interrupted' ? 'Execução interrompida.'
				: status === 'failed' ? `O OpenCode informou falha${http}. Confira o modelo e a autenticação na sua configuração do OpenCode.` : undefined });
			const savedPrompt = text ?? prompt ?? this.history?.turns(item.view.id).at(-1)?.prompt;
			if (savedPrompt) { this.saveTurn(item, savedPrompt); }
		} catch (error) {
			if (!item.closing) {
				this.update(item, { status: 'failed', summary: error instanceof OpenCodeError ? error.message : 'A execução não pôde ser confirmada pelo OpenCode.' });
			}
		}
	}

	private saveTurn(item: Managed, prompt: string): void {
		const last = this.history?.turns(item.view.id).at(-1);
		try {
			this.history?.save(item.view, { prompt, result: item.view.result, status: item.view.status,
				at: last?.at ?? Date.now() }, !!last);
		} catch {
			this.update(item, { summary: 'O resultado foi recebido, mas n�o p�de ser salvo no hist�rico local.' });
		}
	}

	private async scopedHistory(id: string, directory: string): Promise<Session> {
		const workspace = await realpath(directory).catch(() => undefined);
		const session = this.list().find(entry => entry.id === id);
		if (!session?.workspace || !workspace || workspace.toLowerCase() !== session.workspace.toLowerCase()) {
			throw new OpenCodeError('Hist�rico indispon�vel neste workspace.');
		}
		return session;
	}

	async historyFor(id: string, directory: string): Promise<Turn[]> {
		await this.scopedHistory(id, directory);
		return this.history?.turns(id) ?? [];
	}

	async deleteHistory(id: string, directory: string): Promise<{ deleted: boolean }> {
		const session = await this.scopedHistory(id, directory);
		if (!session.historical) { throw new OpenCodeError('Encerre a sess�o antes de excluir o hist�rico.'); }
		this.history?.delete(id);
		this.publish({ type: 'session.removed', sessionId: id });
		return { deleted: true };
	}

	/**
	 * Services, providers, models and effort levels, read from a real OpenCode server for this workspace and reduced to the
	 * allow-listed form (see catalog.ts). A short-lived server is started in a Job Object for the read and stopped right after;
	 * the answer is cached for a minute.
	 */
	async catalog(directory?: string, refresh = false): Promise<CatalogResult> {
		const runnable = openCodeRunnable();
		const services = serviceList(runnable);
		const exe = openCodeExecutable();
		if (!exe) {
			return { services, service: 'opencode', providers: [], hiddenModels: 0, unavailable: runnable.reason };
		}
		const base = directory ?? homedir();
		if (!isAbsolute(base)) {
			throw new OpenCodeError('Escolha um workspace local absoluto.');
		}
		const workspace = await realpath(base).catch(() => undefined);
		if (!workspace || !(await stat(workspace)).isDirectory()) {
			throw new OpenCodeError('O diretório do workspace não existe.');
		}
		const key = workspace.toLowerCase();
		const cached = this.catalogs.get(key);
		if (cached && !refresh && Date.now() - cached.at < 60_000) {
			return cached.result;
		}
		if (this.closed) {
			throw new OpenCodeError('Hub is shutting down.');
		}
		const result = (async (): Promise<CatalogResult> => {
			const server = new OpenCodeProcess(exe, workspace, await localPort());
			try {
				await server.ready();
				return { services, service: 'opencode', ...(await readCatalog(server)) };
			} finally {
				await server.stop().catch(() => undefined);
			}
		})();
		this.catalogs.set(key, { at: Date.now(), result });
		result.catch(() => { if (this.catalogs.get(key)?.result === result) { this.catalogs.delete(key); } });
		return result;
	}

	/**
	 * Changes the model and effort of a session for the tasks that follow. The choice is validated against the real catalog
	 * (the OpenCode API would accept anything), and what the session reports afterwards is what the IDE shows.
	 */
	async setModel(id: string, selection: ModelSelection): Promise<ModelInfo | undefined> {
		const item = this.item(id);
		if (item.run) {
			throw new OpenCodeError('Aguarde a tarefa terminar para trocar o modelo ou o esforço.');
		}
		const chosen = validateSelection((await readCatalog(item.server)).providers, selection);
		if (item.run) {
			throw new OpenCodeError('Aguarde a tarefa terminar para trocar o modelo ou o esforço.');
		}
		await item.server.request('switchModel', item.remoteId, { model: { id: chosen.modelID, providerID: chosen.providerID, ...(chosen.variant ? { variant: chosen.variant } : {}) } });
		const { data } = await item.server.request<{ data: { model?: RawModel } }>('state', item.remoteId);
		const model = modelOf(data.model);
		this.update(item, { model });
		return model;
	}

	async interrupt(id: string): Promise<boolean> {
		const item = this.item(id);
		const response = await item.server.request<{ interrupted: boolean }>('interrupt', item.remoteId);
		return response.interrupted;
	}

	async stop(id: string): Promise<void> {
		const item = this.item(id);
		item.closing = true;
		try {
			await item.server.request('interrupt', item.remoteId, undefined, AbortSignal.timeout(3000)).catch(() => undefined);
			await item.server.request('remove', item.remoteId, undefined, AbortSignal.timeout(3000)).catch(() => undefined);
			await item.server.stop();
			await item.run;
			if (this.recoveryDir) {
				rmSync(join(this.recoveryDir, id + '.dpapi'), { force: true });
			}
			this.sessions.delete(id);
			if (this.history) {
				const archived: Session = { ...item.view, historical: true, updatedAt: Date.now() };
				this.history.save(archived);
				const { prompt, result, ...metadata } = archived;
				this.publish({ type: 'session.changed', sessionId: id, data: metadata });
			} else {
				this.publish({ type: 'session.removed', sessionId: id });
			}
		} catch (error) {
			item.closing = false;
			throw error;
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled([...this.catalogs.values()].map(entry => entry.result));
		while (this.creating) {
			await delay(50);
		}
		await Promise.all([...this.sessions.keys()].map(id => this.stop(id)));
	}
}
