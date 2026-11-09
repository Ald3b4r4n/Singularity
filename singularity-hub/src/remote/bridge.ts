import { EventEmitter } from 'node:events';
import { HubConnection, RpcFailure } from '../client';
import { Session } from '../protocol';

/**
 * The only way the gateway talks to the Hub. It holds one authenticated Hub connection (the token is read inside HubConnection and
 * never leaves it) and exposes a closed list of operations; there is no generic "call this method". Reconnecting to the Hub never
 * re-sends a prompt: requests are only made on behalf of an explicit phone action.
 */
export const ALLOWED_HUB_METHODS = [
	'sessions.list', 'session.create', 'session.prompt', 'session.interrupt', 'session.history', 'catalog.get',
	'comparisons.list', 'comparisons.inspect', 'teams.list', 'solutions.list', 'usage.get'
] as const;
export type AllowedMethod = typeof ALLOWED_HUB_METHODS[number];

export interface HubEventRecord { seq: number; type: string; sessionId?: string; data?: unknown }

export class HubBridge extends EventEmitter {
	private connection?: HubConnection;
	private closed = false;
	private connecting = false;
	private timer?: NodeJS.Timeout;
	private readonly ring: HubEventRecord[] = [];
	instanceId?: string;

	constructor(private readonly home: string | undefined, private readonly name = 'singularity-remote') { super(); }

	get connected(): boolean { return !!this.connection; }

	start(): void { void this.connect(); }

	private async connect(): Promise<void> {
		if (this.closed || this.connecting || this.connection) { return; }
		this.connecting = true;
		try {
			const connection = await HubConnection.connect({ home: this.home, clientName: this.name, timeoutMs: 4000 });
			connection.on('notification', (method: string, params: { event?: HubEventRecord }) => {
				if (method === 'session.event' && params?.event) {
					this.ring.push(params.event);
					if (this.ring.length > 500) { this.ring.shift(); }
					this.emit('event', params.event);
				}
			});
			connection.on('close', () => { this.connection = undefined; this.emit('state'); this.schedule(); });
			await connection.request('session.subscribe', {});
			this.instanceId = connection.hello.hub.instanceId;
			this.connection = connection;
			this.emit('state');
		} catch {
			this.schedule();
		} finally { this.connecting = false; }
	}

	private schedule(): void {
		if (this.closed || this.timer) { return; }
		this.timer = setTimeout(() => { this.timer = undefined; void this.connect(); }, 2000);
		this.timer.unref();
	}

	/** Events retained after `seq`, so a phone that reconnects catches up without anything being replayed to the agents. */
	eventsAfter(seq: number): HubEventRecord[] { return this.ring.filter(event => event.seq > seq); }

	async call<T = unknown>(method: AllowedMethod, params?: unknown, timeoutMs = 45000): Promise<T> {
		if (!(ALLOWED_HUB_METHODS as readonly string[]).includes(method)) { throw new Error('Método não permitido.'); }
		if (!this.connection) { throw new BridgeUnavailable(); }
		try {
			return await this.connection.request<T>(method, params, timeoutMs);
		} catch (error) {
			if (error instanceof RpcFailure) { throw new BridgeError(error.message); }
			throw error;
		}
	}

	sessions(): Promise<Session[]> { return this.call<Session[]>('sessions.list'); }

	close(): void {
		this.closed = true;
		if (this.timer) { clearTimeout(this.timer); }
		this.connection?.close();
		this.connection = undefined;
	}
}

export class BridgeUnavailable extends Error { constructor() { super('O Singularity Hub não está conectado.'); } }
export class BridgeError extends Error { }
