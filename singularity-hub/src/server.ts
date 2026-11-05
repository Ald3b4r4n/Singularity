import { Solutions } from './solutions';
import { Comparisons } from './comparisons';
import { join } from 'node:path';
import { hubHome } from './paths';
import { claudeExecutable } from './claude';
import { codexExecutable } from './codex';
import { cancelProviderInstall, installProvider, providerBusy, ProviderInstallError } from './providerInstall';
import { openCodeExecutable } from './opencode';
import { inspectProviders } from './providers';
import * as http from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { bearerToken, FailureLimiter, identityProof, isNonce, newId, RateBucket, tokenMatches } from './auth';
import { EventLog } from './eventlog';
import { CatalogError, parseSelection, serviceList } from './catalog';
import { ClaudeCodeError, ClaudeCodeSessions, claudeRunnable, parsePermissionMode } from './claude';
import { CodexError, CodexSessions, codexRunnable, parseCodexPermissionMode } from './codex';
import { OpenCodeError, OpenCodeSessions, openCodeRunnable } from './opencode';
import { Logger } from './logger';
import {
	ErrorCode, HelloParams, HelloResult, HUB_NAME, HUB_VERSION, HubEvent, IDENTITY_PATH, JsonRpcError, JsonRpcRequest,
	negotiate, PROTOCOL, SubscribeParams, SubscribeResult, WS_PATH
} from './protocol';

export interface ServerLimits {
	maxPayloadBytes: number;
	maxClients: number;
	/** Close a client whose unsent output grows past this. */
	maxBufferedBytes: number;
	messagesPerSecond: number;
	messageBurst: number;
	pingIntervalMs: number;
}

export const DEFAULT_LIMITS: ServerLimits = {
	maxPayloadBytes: 64 * 1024,
	maxClients: 16,
	maxBufferedBytes: 1024 * 1024,
	messagesPerSecond: 50,
	messageBurst: 100,
	pingIntervalMs: 15_000,
};

export interface ServerOptions {
	recoveryDir?: string;
	historyDir?: string;
	token: string;
	instanceId: string;
	startedAt: string;
	logger: Logger;
	limits?: Partial<ServerLimits>;
	/** Called after hub.shutdown has been answered. */
	onShutdownRequested?: () => void;
}

interface ClientState {
	ws: WebSocket;
	id: string;
	initialized: boolean;
	alive: boolean;
	bucket: RateBucket;
	subscriptions: Map<string, { sessionId?: string }>;
}

const KNOWN_METHODS = new Set(['solutions.prepare', 'solutions.list', 'solutions.review', 'solutions.validate', 'comparisons.create', 'comparisons.list', 'comparisons.cancel', 'comparisons.inspect', 'comparisons.select', 'comparisons.cleanup', 'hub.hello', 'sessions.list', 'session.subscribe', 'session.create', 'session.prompt', 'session.setModel', 'session.interrupt', 'session.stop', 'session.history', 'session.deleteHistory', 'session.reopen', 'catalog.get', 'providers.inspect', 'providers.install', 'providers.cancelInstall', 'hub.shutdown']);

class RpcError extends Error {
	constructor(readonly code: number, message: string, readonly data?: unknown) {
		super(message);
	}
}

export class HubServer {
	readonly events = new EventLog();
	private readonly comparisons: Comparisons;
	private readonly solutions: Solutions;
	private sessionRequests = 0;
	private readonly opencode: OpenCodeSessions;
	private readonly claude: ClaudeCodeSessions;
	private readonly codex: CodexSessions;
	private readonly limits: ServerLimits;
	private readonly authFailures = new FailureLimiter();
	private readonly identityFailures = new FailureLimiter(30, 60_000, 10_000);
	private readonly http: http.Server;
	private readonly wss: WebSocketServer;
	private readonly clients = new Set<ClientState>();
	private pingTimer: NodeJS.Timeout | undefined;
	private _port = 0;
	private closed = false;

	constructor(private readonly opts: ServerOptions) {
		this.opencode = new OpenCodeSessions(event => this.publish(event), opts.recoveryDir, opts.historyDir);
		this.claude = new ClaudeCodeSessions(event => this.publish(event), opts.historyDir);
		this.codex = new CodexSessions(event => this.publish(event), opts.historyDir);
		this.comparisons = new Comparisons(join(opts.historyDir ?? join(hubHome(), 'history'), 'comparisons'), {
			create: async (workspace, service, model) => {
				this.sessionRequests++;
				try { return await this.operateSession('session.create', { workspace, service, model, permissionMode: service === 'claude-code' ? 'acceptEdits' : service === 'codex-cli' ? 'workspace-write' : undefined }) as import('./protocol').Session; }
				finally { this.sessionRequests--; }
			},
			prompt: (id, text) => {
				const owner = this.claude.has(id) ? this.claude : this.codex.has(id) ? this.codex : this.opencode;
				owner.prompt(id, text);
			},
			stop: async id => { await this.operateSession('session.stop', { id }); },
			history: async (id, workspace) => await this.operateSession('session.history', { id, workspace }) as import('./history').Turn[],
			list: () => [...this.opencode.list(), ...this.claude.list(), ...this.codex.list()]
		}, () => this.publish({ type: 'comparison.changed' }));
		this.solutions = new Solutions(join(opts.historyDir ?? join(hubHome(), 'history'), 'solutions'), (id, workspace, participantId) => this.comparisons.solutionSource(id, workspace, participantId));
		this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
		this.http = http.createServer((req, res) => this.onHttp(req, res));
		this.wss = new WebSocketServer({ noServer: true, maxPayload: this.limits.maxPayloadBytes, perMessageDeflate: false });
		this.http.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
		this.http.maxHeadersCount = 50;
		this.http.headersTimeout = 5000;
		this.http.requestTimeout = 5000;
	}

	get port(): number {
		return this._port;
	}

	get clientCount(): number {
		return this.clients.size;
	}

	async listen(): Promise<number> {
		await this.opencode.recover();
		this.claude.recover();
		this.codex.recover();
		await this.comparisons.recover();
		await this.solutions.recover();
		return new Promise((resolve, reject) => {
			this.http.once('error', reject);
			// Loopback only, never 0.0.0.0 or ::
			this.http.listen(0, '127.0.0.1', () => {
				this.http.off('error', reject);
				this._port = (this.http.address() as { port: number }).port;
				this.pingTimer = setInterval(() => this.heartbeat(), this.limits.pingIntervalMs);
				this.pingTimer.unref();
				resolve(this._port);
			});
		});
	}

	/** Entry point for adapters (later tasks): publish a sequenced event to subscribers. */
	publish(event: Omit<HubEvent, 'seq'>): HubEvent {
		if (event.type === 'session.changed' && event.data) { this.comparisons?.onSession(event.data as import('./protocol').Session); }
		const stored = this.events.append(event);
		for (const c of this.clients) {
			for (const [subscriptionId, sub] of c.subscriptions) {
				if (!sub.sessionId || sub.sessionId === stored.sessionId) {
					this.notify(c, 'session.event', { subscriptionId, event: stored });
				}
			}
		}
		return stored;
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		await Promise.all([this.opencode.close(), this.claude.close(), this.codex.close()]);
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
		}
		for (const c of this.clients) {
			this.notify(c, 'hub.shuttingDown', {});
			c.ws.close(1001, 'hub shutting down');
		}
		await new Promise<void>(resolve => {
			const t = setTimeout(() => { for (const c of this.clients) { c.ws.terminate(); } resolve(); }, 1000);
			this.wss.close(() => { clearTimeout(t); resolve(); });
		});
		await new Promise<void>(resolve => { this.http.close(() => resolve()); this.http.closeAllConnections(); });
	}

	// ---------- HTTP ----------

	private hostAllowed(req: http.IncomingMessage): boolean {
		const host = req.headers.host;
		return host === `127.0.0.1:${this._port}` || host === `localhost:${this._port}`;
	}

	private reply(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
		const payload = JSON.stringify(body);
		res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload), ...headers });
		res.end(payload);
	}

	private onHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		if (!this.hostAllowed(req)) {
			return this.reply(res, 403, { error: 'host not allowed' });
		}
		if (req.headers.origin !== undefined) {
			return this.reply(res, 403, { error: 'origin not allowed' });
		}
		if (req.method === 'GET' && url.pathname === IDENTITY_PATH && url.search === '') {
			const limit = this.identityFailures.check();
			if (!limit.allowed) {
				return this.reply(res, 429, { error: 'too many requests' }, { 'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)) });
			}
			const nonce = req.headers['x-singularity-nonce'];
			if (!isNonce(nonce)) {
				this.identityFailures.fail();
				return this.reply(res, 400, { error: 'invalid nonce' });
			}
			return this.reply(res, 200, {
				name: HUB_NAME,
				instanceId: this.opts.instanceId,
				protocol: PROTOCOL,
				proof: identityProof(this.opts.token, this.opts.instanceId, nonce),
			});
		}
		this.reply(res, 404, { error: 'not found' });
	}

	// ---------- Upgrade (authentication happens here, before any WebSocket exists) ----------

	private reject(socket: Duplex, status: number, reason: string, extra = ''): void {
		socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`);
		socket.destroy();
	}

	private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
		socket.on('error', () => { /* a client that vanishes mid-handshake is not an error for the Hub */ });
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		if (!this.hostAllowed(req)) {
			return this.reject(socket, 403, 'Forbidden');
		}
		if (req.headers.origin !== undefined) {
			return this.reject(socket, 403, 'Forbidden');
		}
		if (url.pathname !== WS_PATH) {
			return this.reject(socket, 404, 'Not Found');
		}
		const limit = this.authFailures.check();
		if (!limit.allowed) {
			this.opts.logger.log('warn', 'upgrade refused: locked out');
			return this.reject(socket, 429, 'Too Many Requests', `Retry-After: ${Math.ceil(limit.retryAfterMs / 1000)}\r\n`);
		}
		if (url.search !== '') {
			// Credentials must never travel in the URL (they end up in logs and history), whatever the parameter is called.
			this.authFailures.fail();
			this.opts.logger.log('warn', 'upgrade refused: query string');
			return this.reject(socket, 400, 'Bad Request');
		}
		const presented = bearerToken(req.headers.authorization);
		if (!presented || !tokenMatches(presented, this.opts.token)) {
			this.authFailures.fail();
			this.opts.logger.log('warn', 'upgrade refused: unauthorized');
			return this.reject(socket, 401, 'Unauthorized', 'WWW-Authenticate: Bearer\r\n');
		}
		if (this.clients.size >= this.limits.maxClients) {
			this.opts.logger.log('warn', 'upgrade refused: too many clients');
			return this.reject(socket, 503, 'Service Unavailable');
		}
		this.authFailures.success();
		this.wss.handleUpgrade(req, socket, head, ws => this.onConnection(ws));
	}

	// ---------- JSON-RPC ----------

	private onConnection(ws: WebSocket): void {
		const client: ClientState = {
			ws, id: newId(), initialized: false, alive: true, subscriptions: new Map(),
			bucket: new RateBucket(this.limits.messagesPerSecond, this.limits.messageBurst),
		};
		this.clients.add(client);
		this.opts.logger.log('info', 'client connected', { clients: this.clients.size });
		ws.on('pong', () => { client.alive = true; });
		ws.on('close', () => { this.clients.delete(client); this.opts.logger.log('info', 'client disconnected', { clients: this.clients.size }); });
		ws.on('error', () => { /* oversized frames and resets end up in 'close' */ });
		ws.on('message', (data, isBinary) => {
			if (isBinary) {
				return ws.close(1003, 'text only');
			}
			if (!client.bucket.take()) {
				this.opts.logger.log('warn', 'client closed: rate limit');
				return ws.close(1008, 'rate limit');
			}
			void this.onMessage(client, data.toString('utf8'));
		});
	}

	private async onMessage(client: ClientState, text: string): Promise<void> {
		let request: JsonRpcRequest;
		try {
			const parsed: unknown = JSON.parse(text);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as JsonRpcRequest).jsonrpc !== '2.0' || typeof (parsed as JsonRpcRequest).method !== 'string') {
				return this.respondError(client, null, { code: ErrorCode.InvalidRequest, message: 'Invalid Request' });
			}
			request = parsed as JsonRpcRequest;
		} catch {
			return this.respondError(client, null, { code: ErrorCode.ParseError, message: 'Parse error' });
		}
		const id = request.id ?? null;
		const isNotification = request.id === undefined;
		try {
			const result = await this.dispatch(client, request);
			if (!isNotification && this.isOpen(client)) {
				this.send(client, { jsonrpc: '2.0', id, result });
			}
			if (request.method === 'hub.shutdown') {
				this.opts.logger.log('info', 'shutdown requested');
				setImmediate(() => this.opts.onShutdownRequested?.());
			}
		} catch (e) {
			if (isNotification) {
				return;
			}
			if ((request.method.startsWith('comparisons.') || request.method.startsWith('solutions.')) && e instanceof Error && !(e instanceof RpcError)) {
				this.respondError(client, id, { code: -32006, message: e.message });
			} else if (e instanceof RpcError) {
				this.respondError(client, id, { code: e.code, message: e.message, data: e.data });
			} else {
				this.opts.logger.log('error', 'internal error', { method: request.method });
				this.respondError(client, id, { code: ErrorCode.InternalError, message: 'Internal error' });
			}
		}
	}

	private async dispatch(client: ClientState, request: JsonRpcRequest): Promise<unknown> {
		const { method } = request;
		// Only known method names are logged: an unknown one is client-controlled text.
		this.opts.logger.log('info', 'rpc', { method: KNOWN_METHODS.has(method) ? method : '(unknown)' });
		if (method === 'hub.hello') {
			return this.hello(client, request.params);
		}
		if (!client.initialized) {
			throw new RpcError(ErrorCode.NotInitialized, 'Call hub.hello first');
		}
		switch (method) {
			case 'solutions.prepare':
			case 'solutions.list':
			case 'solutions.review':
			case 'solutions.validate': {
				const p = request.params as { workspace?: unknown; id?: unknown; comparisonId?: unknown; participantId?: unknown; command?: unknown };
				if (typeof p?.workspace !== 'string') { throw new RpcError(ErrorCode.InvalidParams, 'Workspace required'); }
				if (method === 'solutions.list') { return this.solutions.list(p.workspace); }
				if (method === 'solutions.prepare' && typeof p.comparisonId === 'string' && typeof p.participantId === 'string') { return this.solutions.prepare(p.comparisonId, p.workspace, p.participantId); }
				if (typeof p.id !== 'string') { throw new RpcError(ErrorCode.InvalidParams, 'Solution required'); }
				if (method === 'solutions.review') { return this.solutions.review(p.id, p.workspace); }
				if (method === 'solutions.validate') { return this.solutions.validate(p.id, p.workspace, p.command as { executable?: unknown; args?: unknown; approved?: unknown }); }
				throw new RpcError(ErrorCode.InvalidParams, 'Invalid solution parameters');
			}
			case 'comparisons.create':
				return this.comparisons.create(request.params);
			case 'comparisons.list':
			case 'comparisons.cancel':
			case 'comparisons.inspect':
			case 'comparisons.select':
			case 'comparisons.cleanup': {
				const p = request.params as { workspace?: unknown; id?: unknown; participantId?: unknown };
				if (typeof p?.workspace !== 'string' || (method !== 'comparisons.list' && typeof p.id !== 'string') || (p.participantId !== undefined && typeof p.participantId !== 'string')) { throw new RpcError(ErrorCode.InvalidParams, 'Invalid comparison parameters'); }
				if (method === 'comparisons.list') { return this.comparisons.list(p.workspace); }
				if (method === 'comparisons.cancel') { await this.comparisons.cancel(p.id as string, p.workspace, p.participantId as string | undefined); return { cancelled: true }; }
				if (method === 'comparisons.cleanup') { await this.comparisons.cleanup(p.id as string, p.workspace); return { cleaned: true }; }
				if (typeof p.participantId !== 'string') { throw new RpcError(ErrorCode.InvalidParams, 'Participant required'); }
				if (method === 'comparisons.inspect') { return this.comparisons.inspect(p.id as string, p.workspace, p.participantId); }
				this.comparisons.select(p.id as string, p.workspace, p.participantId);
				return { selected: true };
			}
			case 'sessions.list':
				return [...this.opencode.list(), ...this.claude.list(), ...this.codex.list()];
			case 'providers.cancelInstall': {
				const p = request.params as { id?: string } | undefined;
				if (p?.id !== 'opencode' && p?.id !== 'claude-code' && p?.id !== 'codex-cli') {
					throw new RpcError(ErrorCode.InvalidParams, 'Invalid provider');
				}
				return { cancelled: cancelProviderInstall(p.id) };
			}
			case 'providers.install': {
				const p = request.params as { id?: string; version?: string; operation?: 'install' | 'repair' | 'update' } | undefined;
				if ((p?.id !== 'opencode' && p?.id !== 'claude-code' && p?.id !== 'codex-cli') || typeof p.version !== 'string') {
					throw new RpcError(ErrorCode.InvalidParams, 'Versão ou provedor não confirmado.');
				}
				const resolve = p.id === 'opencode' ? openCodeExecutable : p.id === 'claude-code' ? claudeExecutable : codexExecutable;
				const operation = p.operation ?? 'install';
				if (operation !== 'install' && operation !== 'repair' && operation !== 'update') {
					throw new RpcError(ErrorCode.InvalidParams, 'Invalid maintenance operation');
				}
				const canReplace = () => this.sessionRequests === 0 && ![...this.opencode.list(), ...this.claude.list(), ...this.codex.list()]
					.some(session => !session.historical && session.harness === p.id);
				try { await installProvider(p.id, p.version, resolve, operation, canReplace); return { installed: true }; }
				catch (error) {
					throw new RpcError(-32006, error instanceof ProviderInstallError ? error.message : 'Não foi possível preparar o executável oficial.');
				}
			}
			case 'providers.inspect': {
				const p = (request.params ?? {}) as { workspace?: unknown; refresh?: unknown };
				if ((p.workspace !== undefined && (typeof p.workspace !== 'string' || p.workspace.length > 1024)) ||
					(p.refresh !== undefined && typeof p.refresh !== 'boolean')) {
					throw new RpcError(ErrorCode.InvalidParams, 'Invalid provider inspection parameters');
				}
				return inspectProviders(async () => (await this.opencode.catalog(p.workspace as string | undefined, p.refresh === true)).providers.some(provider => provider.models.length > 0), p.refresh === true);
			}
			case 'catalog.get':
				return this.catalog(request.params);
			case 'session.create':
			case 'session.prompt':
			case 'session.setModel':
			case 'session.interrupt':
			case 'session.stop':
			case 'session.history':
			case 'session.deleteHistory':
			case 'session.reopen':
				this.sessionRequests++;
				try { return await this.operateSession(method, request.params); }
				finally { this.sessionRequests--; }
			case 'session.subscribe':
				return this.subscribe(client, request.params);
			case 'hub.shutdown':
				return { ok: true };
			default:
				throw new RpcError(ErrorCode.MethodNotFound, 'Method not found');
		}
	}

	/** catalog.get { service?, workspace?, refresh? }: what can be run here, read from the service itself. */
	private async catalog(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as { service?: unknown; workspace?: unknown; refresh?: unknown };
		if ((p.service !== undefined && p.service !== 'opencode' && p.service !== 'claude-code' && p.service !== 'codex-cli') || (p.workspace !== undefined && (typeof p.workspace !== 'string' || p.workspace.length > 1024)) || (p.refresh !== undefined && typeof p.refresh !== 'boolean')) {
			throw new RpcError(ErrorCode.InvalidParams, 'Invalid catalog parameters');
		}
		try {
			const services = serviceList(openCodeRunnable(), await claudeRunnable(), await codexRunnable());
			if (p.service === 'claude-code') {
				return { ...(await this.claude.catalog()), services };
			}
			if (p.service === 'codex-cli') {
				return { ...(await this.codex.catalog()), services };
			}
			return { ...(await this.opencode.catalog(p.workspace as string | undefined, p.refresh === true)), services };
		} catch (error) {
			if (error instanceof OpenCodeError || error instanceof ClaudeCodeError || error instanceof CodexError) {
				throw new RpcError(-32006, error.message);
			}
			throw error;
		}
	}

	private async operateSession(method: string, params: unknown): Promise<unknown> {
		if (['session.create', 'session.prompt', 'session.reopen'].includes(method) &&
			(['opencode', 'claude-code', 'codex-cli'] as const).some(providerBusy)) {
			throw new RpcError(-32006, 'Aguarde a manutencao do provedor terminar.');
		}
		const p = params as { workspace?: unknown; id?: unknown; text?: unknown; model?: unknown; service?: unknown; permissionMode?: unknown } | undefined;
		try {
			if (method === 'session.create' && typeof p?.workspace === 'string') {
				const selection = parseSelection(p.model);
				const service = p.service ?? selection?.providerID;
				if (service === 'claude-code') {
					return await this.claude.create(p.workspace, selection, parsePermissionMode(p.permissionMode));
				}
				if (service === 'codex-cli') {
					return await this.codex.create(p.workspace, selection, parseCodexPermissionMode(p.permissionMode));
				}
				return await this.opencode.create(p.workspace, selection);
			}
			if (typeof p?.id === 'string' && typeof p.workspace === 'string') {
				const owner = this.claude.owns(p.id) ? this.claude : this.codex.owns(p.id) ? this.codex : this.opencode;
				if (method === 'session.history') { return await owner.historyFor(p.id, p.workspace); }
				if (method === 'session.deleteHistory') { return await owner.deleteHistory(p.id, p.workspace); }
				if (method === 'session.reopen') {
					if (owner === this.opencode) { throw new RpcError(ErrorCode.InvalidParams, 'Only Claude Code and Codex CLI sessions can be reopened'); }
					return await (owner as ClaudeCodeSessions | CodexSessions).reopen(p.id, p.workspace);
				}
			}
			if (method !== 'session.create' && method !== 'session.reopen' && typeof p?.id === 'string') {
				const owner = this.claude.has(p.id) ? this.claude : this.codex.has(p.id) ? this.codex : this.opencode.has(p.id) ? this.opencode : undefined;
				if (!owner) {
					throw new RpcError(ErrorCode.SessionNotFound, 'Session not found');
				}
				if (method === 'session.prompt' && typeof p.text === 'string') {
					owner.prompt(p.id, p.text);
					return { accepted: true };
				}
				if (method === 'session.setModel') {
					const selection = parseSelection(p.model);
					if (selection) {
						return { model: await owner.setModel(p.id, selection) };
					}
				}
				if (method === 'session.interrupt') {
					return { interrupted: await owner.interrupt(p.id) };
				}
				if (method === 'session.stop') {
					await owner.stop(p.id);
					return { stopped: true };
				}
			}
		} catch (error) {
			if (error instanceof OpenCodeError || error instanceof ClaudeCodeError || error instanceof CodexError || error instanceof CatalogError) {
				throw new RpcError(-32006, error.message);
			}
			throw error;
		}
		throw new RpcError(ErrorCode.InvalidParams, 'Invalid session parameters');
	}

	private hello(client: ClientState, params: unknown): HelloResult {
		const p = params as Partial<HelloParams> | undefined;
		const range = p?.protocol;
		if (!p || typeof p.client?.name !== 'string' || !range || !Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min > range.max) {
			throw new RpcError(ErrorCode.InvalidParams, 'Invalid params');
		}
		const version = negotiate(range);
		if (version === undefined) {
			throw new RpcError(ErrorCode.IncompatibleProtocol, 'Incompatible protocol version', { supported: PROTOCOL });
		}
		client.initialized = true;
		return {
			protocol: version,
			hub: { name: HUB_NAME, version: HUB_VERSION, instanceId: this.opts.instanceId, pid: process.pid, startedAt: this.opts.startedAt },
			capabilities: ['opencode.v2', 'claude-code.v1', 'codex-cli.v1', 'catalog.v1', 'session.model.v1', 'comparisons.v1'],
			seq: this.events.seq,
		};
	}

	private subscribe(client: ClientState, params: unknown): SubscribeResult {
		const p = (params ?? {}) as Partial<SubscribeParams>;
		if ((p.sessionId !== undefined && typeof p.sessionId !== 'string') || (p.fromSeq !== undefined && (!Number.isInteger(p.fromSeq) || p.fromSeq < 0))) {
			throw new RpcError(ErrorCode.InvalidParams, 'Invalid params');
		}
		if (p.sessionId !== undefined && !this.opencode.has(p.sessionId) && !this.claude.has(p.sessionId) && !this.codex.has(p.sessionId)) {
			throw new RpcError(ErrorCode.SessionNotFound, 'Session not found');
		}
		let replayed = 0;
		const subscriptionId = newId();
		if (p.fromSeq !== undefined) {
			const { events, gap } = this.events.since(p.fromSeq, e => !p.sessionId || e.sessionId === p.sessionId);
			if (gap) {
				throw new RpcError(ErrorCode.ReplayGap, 'Requested events are no longer retained', { oldestAvailable: this.events.since(0).events[0]?.seq ?? this.events.seq + 1 });
			}
			for (const event of events) {
				this.notify(client, 'session.event', { subscriptionId, event, replay: true });
				replayed++;
			}
		}
		client.subscriptions.set(subscriptionId, { sessionId: p.sessionId });
		return { subscriptionId, seq: this.events.seq, replayed };
	}

	// ---------- sending ----------

	private isOpen(client: ClientState): boolean {
		return client.ws.readyState === WebSocket.OPEN;
	}

	private send(client: ClientState, message: unknown): void {
		if (!this.isOpen(client)) {
			return;
		}
		if (client.ws.bufferedAmount > this.limits.maxBufferedBytes) {
			// Slow reader: drop it rather than let it grow the Hub's memory.
			this.opts.logger.log('warn', 'client closed: slow consumer', { buffered: client.ws.bufferedAmount });
			client.ws.terminate();
			return;
		}
		client.ws.send(JSON.stringify(message));
	}

	private notify(client: ClientState, method: string, params: unknown): void {
		this.send(client, { jsonrpc: '2.0', method, params });
	}

	private respondError(client: ClientState, id: string | number | null, error: JsonRpcError): void {
		this.send(client, { jsonrpc: '2.0', id, error });
	}

	private heartbeat(): void {
		for (const c of this.clients) {
			if (!c.alive) {
				c.ws.terminate();
				continue;
			}
			c.alive = false;
			c.ws.ping();
		}
	}
}
