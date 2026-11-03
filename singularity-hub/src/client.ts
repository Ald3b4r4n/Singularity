import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { discover, Discovered } from './discovery';
import { hubHome } from './paths';
import { ErrorCode, HelloResult, JsonRpcResponse, PROTOCOL, WS_PATH } from './protocol';

export class RpcFailure extends Error {
	constructor(readonly code: number, message: string, readonly data?: unknown) {
		super(message);
	}
}

export interface ConnectOptions {
	home?: string;
	clientName: string;
	clientVersion?: string;
	timeoutMs?: number;
	/** Test hook: use these instead of discovering. */
	discovered?: Discovered;
}

/**
 * One authenticated, handshaked connection to the Hub.
 * Events: 'notification' (method, params), 'close' (code, reason).
 * The token is read inside this class and goes nowhere except the Authorization header of the upgrade.
 */
export class HubConnection extends EventEmitter {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	private _closed = false;

	private constructor(private readonly ws: WebSocket, readonly hello: HelloResult, readonly info: Discovered['info']) {
		super();
		ws.on('message', data => this.onMessage(data.toString('utf8')));
		ws.on('close', (code, reason) => this.onClose(code, reason.toString('utf8')));
		ws.on('error', () => { /* followed by 'close' */ });
	}

	static async connect(options: ConnectOptions): Promise<HubConnection> {
		const timeoutMs = options.timeoutMs ?? 5000;
		const found = options.discovered ?? await discover(options.home ?? hubHome(), Math.min(timeoutMs, 2000));
		const ws = await new Promise<WebSocket>((resolve, reject) => {
			const socket = new WebSocket(`ws://127.0.0.1:${found.info.port}${WS_PATH}`, {
				headers: { Authorization: `Bearer ${found.token}` },
				handshakeTimeout: timeoutMs,
				perMessageDeflate: false,
				maxPayload: 1024 * 1024,
				followRedirects: false,
			});
			socket.once('open', () => resolve(socket));
			socket.once('unexpected-response', (_req, res) => { res.resume(); reject(new RpcFailure(res.statusCode ?? 0, `Hub refused the connection (HTTP ${res.statusCode})`)); });
			socket.once('error', reject);
		});
		let connection: HubConnection | undefined;
		try {
			// The first frame must be the hello; messages that arrive before the constructor runs are impossible
			// because the server only answers requests.
			const pre = new HubConnection(ws, undefined as unknown as HelloResult, found.info);
			connection = pre;
			const hello = await pre.request<HelloResult>('hub.hello', { client: { name: options.clientName, version: options.clientVersion }, protocol: PROTOCOL }, timeoutMs);
			if (hello.hub.instanceId !== found.info.instanceId) {
				throw new RpcFailure(ErrorCode.InternalError, 'The Hub identity changed during the handshake');
			}
			(pre as { hello: HelloResult }).hello = hello;
			return pre;
		} catch (e) {
			connection?.close();
			ws.terminate();
			throw e;
		}
	}

	get closed(): boolean {
		return this._closed;
	}

	request<T>(method: string, params?: unknown, timeoutMs = 5000): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (this._closed || this.ws.readyState !== WebSocket.OPEN) {
				return reject(new RpcFailure(ErrorCode.InternalError, 'The connection is closed'));
			}
			const id = this.nextId++;
			const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcFailure(ErrorCode.InternalError, `Timed out waiting for ${method}`)); }, timeoutMs);
			this.pending.set(id, { resolve: v => resolve(v as T), reject, timer });
			this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), err => {
				if (err) {
					clearTimeout(timer);
					this.pending.delete(id);
					reject(err);
				}
			});
		});
	}

	close(): void {
		if (!this._closed && this.ws.readyState <= WebSocket.OPEN) {
			this.ws.close(1000, 'client closing');
		}
	}

	private onMessage(text: string): void {
		let message: JsonRpcResponse & { method?: string; params?: unknown };
		try {
			message = JSON.parse(text) as JsonRpcResponse & { method?: string; params?: unknown };
		} catch {
			return;
		}
		if (typeof message.method === 'string' && !('id' in message && message.id !== null && message.id !== undefined)) {
			this.emit('notification', message.method, message.params);
			return;
		}
		const id = typeof message.id === 'number' ? message.id : undefined;
		const entry = id === undefined ? undefined : this.pending.get(id);
		if (!entry || id === undefined) {
			return;
		}
		this.pending.delete(id);
		clearTimeout(entry.timer);
		if ('error' in message) {
			entry.reject(new RpcFailure(message.error.code, message.error.message, message.error.data));
		} else {
			entry.resolve(message.result);
		}
	}

	private onClose(code: number, reason: string): void {
		this._closed = true;
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(new RpcFailure(ErrorCode.InternalError, 'The connection closed'));
		}
		this.pending.clear();
		this.emit('close', code, reason);
	}
}
