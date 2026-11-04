import * as http from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { bearerToken, FailureLimiter, identityProof, isNonce, newId, RateBucket, tokenMatches } from './auth';
import { EventLog } from './eventlog';
import { OpenCodeError, OpenCodeSessions } from './opencode';
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

const KNOWN_METHODS = new Set(['hub.hello', 'sessions.list', 'session.subscribe', 'session.create', 'session.prompt', 'session.interrupt', 'session.stop', 'hub.shutdown']);

class RpcError extends Error {
	constructor(readonly code: number, message: string, readonly data?: unknown) {
		super(message);
	}
}

export class HubServer {
	readonly events = new EventLog();
	private readonly sessions = new OpenCodeSessions(event => this.publish(event));
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

	listen(): Promise<number> {
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
		await this.sessions.close();
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
			if (e instanceof RpcError) {
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
			case 'sessions.list':
				return this.sessions.list();
			case 'session.create':
			case 'session.prompt':
			case 'session.interrupt':
			case 'session.stop':
				return this.operateSession(method, request.params);
			case 'session.subscribe':
				return this.subscribe(client, request.params);
			case 'hub.shutdown':
				return { ok: true };
			default:
				throw new RpcError(ErrorCode.MethodNotFound, 'Method not found');
		}
	}

	private async operateSession(method: string, params: unknown): Promise<unknown> {
		const p = params as { workspace?: unknown; id?: unknown; text?: unknown } | undefined;
		try {
			if (method === 'session.create' && typeof p?.workspace === 'string') {
				return await this.sessions.create(p.workspace);
			}
			if (method !== 'session.create' && typeof p?.id === 'string') {
				if (!this.sessions.has(p.id)) {
					throw new RpcError(ErrorCode.SessionNotFound, 'Session not found');
				}
				if (method === 'session.prompt' && typeof p.text === 'string') {
					this.sessions.prompt(p.id, p.text);
					return { accepted: true };
				}
				if (method === 'session.interrupt') {
					return { interrupted: await this.sessions.interrupt(p.id) };
				}
				if (method === 'session.stop') {
					await this.sessions.stop(p.id);
					return { stopped: true };
				}
			}
		} catch (error) {
			if (error instanceof OpenCodeError) {
				throw new RpcError(-32006, error.message);
			}
			throw error;
		}
		throw new RpcError(ErrorCode.InvalidParams, 'Invalid OpenCode session parameters');
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
			capabilities: ['opencode.v2'],
			seq: this.events.seq,
		};
	}

	private subscribe(client: ClientState, params: unknown): SubscribeResult {
		const p = (params ?? {}) as Partial<SubscribeParams>;
		if ((p.sessionId !== undefined && typeof p.sessionId !== 'string') || (p.fromSeq !== undefined && (!Number.isInteger(p.fromSeq) || p.fromSeq < 0))) {
			throw new RpcError(ErrorCode.InvalidParams, 'Invalid params');
		}
		if (p.sessionId !== undefined && !this.sessions.has(p.sessionId)) {
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
