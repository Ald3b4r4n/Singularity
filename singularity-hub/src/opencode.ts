import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { delimiter, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Session, HubEvent } from './protocol';

const methods = {
	create: ['/api/session', 'POST', 'session.create'],
	remove: ['/api/session/{sessionID}', 'DELETE', 'session.remove'],
	state: ['/api/session/{sessionID}', 'GET', 'session.get'],
	prompt: ['/api/session/{sessionID}/prompt', 'POST', 'session.prompt'],
	interrupt: ['/api/session/{sessionID}/interrupt', 'POST', 'session.interrupt'],
	wait: ['/api/experimental/session/{sessionID}/wait', 'POST', 'experimental.session.wait'],
	messages: ['/api/session/{sessionID}/message', 'GET', 'session.message.list'],
	events: ['/api/event', 'GET', 'event.subscribe']
} as const;

const helper = join(__dirname, 'singularity-job.exe');
const deadline = 15000;
const maxSessions = 8;
const outputLimit = 12000;

export class OpenCodeError extends Error { }

function executable(): string | undefined {
	if (process.platform !== 'win32' || !existsSync(helper)) {
		return undefined;
	}
	for (const entry of (process.env.PATH ?? '').split(delimiter)) {
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

class OpenCodeProcess {
	private readonly child;
	private readonly closed: Promise<number | null>;
	private readonly stream = new AbortController();
	private readonly authorization: string;
	private readonly origin: string;
	private dead = false;

	constructor(exe: string, workspace: string, port: number) {
		const password = randomBytes(32).toString('hex');
		this.authorization = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
		this.origin = `http://127.0.0.1:${port}`;
		this.child = spawn(helper, [exe, workspace, String(port)], {
			env: { ...process.env, OPENCODE_PASSWORD: password },
			windowsHide: true, stdio: ['pipe', 'ignore', 'ignore']
		});
		this.child.stdin.on('error', () => {});
		this.closed = new Promise(resolve => {
			this.child.once('error', () => { this.dead = true; resolve(null); });
			this.child.once('close', code => { this.dead = true; resolve(code); });
		});
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

	async events(onEvent: (event: { type: string; data?: { sessionID?: string; error?: { type?: string } } }) => void, onClose: () => void): Promise<void> {
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
		if (!this.dead) {
			this.child.stdin.end('x');
		}
		const timer = new AbortController();
		try {
			const code = await Promise.race([
				this.closed,
				delay(10000, undefined, { signal: timer.signal }).then(() => null)
			]);
			if (code !== 0) {
				throw new OpenCodeError('O helper não confirmou que a árvore de processos foi encerrada.');
			}
		} finally {
			timer.abort();
		}
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
	private creating = 0;
	private closed = false;

	constructor(private readonly publish: (event: Omit<HubEvent, 'seq'>) => void) { }

	list(): Session[] {
		return [...this.sessions.values()].map(item => ({ ...item.view }));
	}

	has(id: string): boolean { return this.sessions.has(id); }

	async create(directory: string): Promise<Session> {
		const exe = executable();
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
			const created = await server.request<{ data: { id: string; location: { directory: string } } }>('create', undefined, { location: { directory: workspace } });
			const remoteId = created.data.id;
			if (!remoteId || (await realpath(created.data.location.directory)).toLowerCase() !== workspace.toLowerCase() || this.closed) {
				throw new OpenCodeError('O OpenCode não confirmou o workspace selecionado.');
			}
			const item: Managed = {
				server, remoteId,
				view: { id: randomUUID(), harness: 'opencode', title: 'OpenCode', status: 'idle', workspace, version }
			};
			await server.events(event => {
				if (event.data?.sessionID !== remoteId || !/^session\.[a-z.]+$/.test(event.type)) {
					return;
				}
				this.publish({ type: 'opencode.event', sessionId: item.view.id, data: { name: event.type } });
				if (event.type === 'session.execution.started') {
					this.update(item, { status: 'running' });
				}
			}, () => this.update(item, { status: 'failed', summary: 'A conexão SSE com o OpenCode foi interrompida.' }));
			if (this.closed) {
				throw new OpenCodeError('Hub is shutting down.');
			}
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
		this.update(item, { status: 'waiting', summary: undefined, result: undefined });
		item.run = this.run(item, text).finally(() => { item.run = undefined; });
	}

	private async run(item: Managed, text: string): Promise<void> {
		const { server, remoteId } = item;
		try {
			await server.request('prompt', remoteId, { text });
			await server.request('wait', remoteId, undefined, AbortSignal.timeout(15 * 60 * 1000));
			const { data } = await server.request<{ data: { outcome?: string } }>('state', remoteId);
			const { data: messages } = await server.request<{ data: Array<{ type: string; error?: { status?: number }; content?: Array<{ type: string; text?: string }> }> }>('messages', remoteId);
			const userIndex = messages.findIndex(message => message.type === 'user');
			const result = messages.slice(0, userIndex < 0 ? 0 : userIndex).find(message => message.type === 'assistant')?.content
				?.filter(part => part.type === 'text').map(part => part.text ?? '').join('').slice(0, outputLimit);
			const providerStatus = messages[0]?.error?.status;
			const http = Number.isInteger(providerStatus) && providerStatus! >= 400 && providerStatus! <= 599 ? ` (HTTP ${providerStatus})` : '';
			const status = data.outcome === 'succeeded' ? 'done' : data.outcome === 'interrupted' ? 'idle' : 'failed';
			this.update(item, { status, result, summary: data.outcome === 'interrupted' ? 'Execução interrompida.'
				: status === 'failed' ? `O OpenCode informou falha${http}. Confira o modelo e a autenticação na sua configuração do OpenCode.` : undefined });
		} catch (error) {
			if (!item.closing) {
				this.update(item, { status: 'failed', summary: error instanceof OpenCodeError ? error.message : 'A execução não pôde ser confirmada pelo OpenCode.' });
			}
		}
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
			this.sessions.delete(id);
			this.publish({ type: 'session.removed', sessionId: id });
		} catch (error) {
			item.closing = false;
			throw error;
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		while (this.creating) {
			await delay(50);
		}
		await Promise.all([...this.sessions.keys()].map(id => this.stop(id)));
	}
}
