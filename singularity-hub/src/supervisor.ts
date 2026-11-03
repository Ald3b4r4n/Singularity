import { EventEmitter } from 'events';
import { HubConnection, RpcFailure } from './client';
import { DiscoveryError } from './discovery';
import { findNode, HUB_MAIN, spawnHub } from './launch';
import { hubHome } from './paths';
import { HUB_VERSION, Session } from './protocol';
import { discover } from './discovery';

export type HubStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** What the panel renders. It never carries the token, a connection or anything but display data. */
export interface PanelState {
	hub: { status: HubStatus; detail?: string };
	sessions: Session[];
}

export interface SupervisorOptions {
	home?: string;
	nodePath?: string;
	hubMain?: string;
	clientName?: string;
	/** Reconnect delays in ms, last one repeats. */
	backoffMs?: number[];
	startupWaitMs?: number;
}

const DEFAULT_BACKOFF = [500, 1000, 2000, 4000, 8000, 15000];

const reasonText: Record<DiscoveryError['reason'], string> = {
	'no-hub': 'Nenhum Hub em execução.',
	'unprotected': 'Os arquivos de conexão do Hub não estão protegidos para o seu usuário.',
	'invalid-info': 'O arquivo de conexão do Hub é inválido.',
	'unreachable': 'O Hub não respondeu.',
	'identity-mismatch': 'O processo na porta do Hub não provou ser o Hub. A conexão foi recusada.',
};

/**
 * Keeps the IDE connected to the Hub: discovers it, starts it when asked, reconnects after drops.
 * "connected" is reported only after an authenticated, version-compatible hello.
 */
export class HubSupervisor extends EventEmitter {
	private state: PanelState = { hub: { status: 'disconnected' }, sessions: [] };
	private connection: HubConnection | undefined;
	private attempt = 0;
	private timer: NodeJS.Timeout | undefined;
	private busy: Promise<void> | undefined;
	private watching = false;
	private disposed = false;

	constructor(private readonly options: SupervisorOptions = {}) {
		super();
	}

	get home(): string {
		return this.options.home ?? hubHome();
	}

	getState(): PanelState {
		return this.state;
	}

	/** Connect to a running Hub; with `spawn`, start one first if none answers. Keeps retrying (discovery only) after failures. */
	async start(spawn: boolean): Promise<void> {
		this.watching = true;
		return this.run(spawn);
	}

	/** Asks the Hub to exit (explicit, authenticated). */
	async stopHub(): Promise<void> {
		const c = this.connection ?? await HubConnection.connect({ home: this.home, clientName: this.options.clientName ?? 'singularity-ide' });
		try {
			await c.request('hub.shutdown', {});
		} finally {
			if (c !== this.connection) {
				c.close();
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		this.watching = false;
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.connection?.close();
		this.connection = undefined;
		this.removeAllListeners();
	}

	private set(next: PanelState): void {
		this.state = next;
		if (!this.disposed) {
			this.emit('change', next);
		}
	}

	private run(spawn: boolean): Promise<void> {
		if (!this.busy) {
			this.busy = this.attemptConnect(spawn).finally(() => { this.busy = undefined; });
		}
		return this.busy;
	}

	private async attemptConnect(spawn: boolean): Promise<void> {
		if (this.disposed || this.connection) {
			return;
		}
		if (spawn) {
			this.set({ hub: { status: 'connecting' }, sessions: [] }); // background retries stay quiet instead of flickering
		}
		try {
			let found = await this.tryConnect();
			if (!found && spawn) {
				const node = this.options.nodePath ?? findNode();
				if (!node) {
					this.fail('error', 'Node.js não foi encontrado no PATH. Instale o Node.js 22 ou superior.');
					return;
				}
				spawnHub(node, this.options.hubMain ?? HUB_MAIN, { ...process.env, SINGULARITY_HUB_HOME: this.home });
				const deadline = Date.now() + (this.options.startupWaitMs ?? 10_000);
				while (!found && Date.now() < deadline && !this.disposed) {
					await new Promise(r => setTimeout(r, 250));
					found = await this.tryConnect();
				}
			}
			if (!found) {
				this.fail('disconnected', this.lastReason);
			}
		} catch (e) {
			this.fail('error', e instanceof RpcFailure ? `O Hub recusou a conexão (${e.message}).` : 'Falha ao conectar ao Hub.');
		}
	}

	private lastReason = reasonText['no-hub'];

	private async tryConnect(): Promise<boolean> {
		try {
			await discover(this.home, 1500);
		} catch (e) {
			this.lastReason = e instanceof DiscoveryError ? reasonText[e.reason] : 'Falha ao procurar o Hub.';
			return false;
		}
		const connection = await HubConnection.connect({ home: this.home, clientName: this.options.clientName ?? 'singularity-ide', clientVersion: HUB_VERSION });
		const sessions = await connection.request<Session[]>('sessions.list');
		await connection.request('session.subscribe', {});
		connection.on('notification', (method: string) => {
			if (method === 'hub.shuttingDown') {
				this.lastReason = 'O Hub foi encerrado.';
			}
		});
		connection.once('close', () => {
			if (this.connection === connection) {
				this.connection = undefined;
				this.set({ hub: { status: 'disconnected', detail: this.lastReason === reasonText['no-hub'] ? 'A conexão com o Hub foi perdida.' : this.lastReason }, sessions: [] });
				this.scheduleReconnect();
			}
		});
		this.connection = connection;
		this.attempt = 0;
		this.set({ hub: { status: 'connected' }, sessions });
		return true;
	}

	private fail(status: HubStatus, detail: string): void {
		this.set({ hub: { status, detail }, sessions: [] });
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (!this.watching || this.disposed || this.timer) {
			return;
		}
		const steps = this.options.backoffMs ?? DEFAULT_BACKOFF;
		const delay = steps[Math.min(this.attempt++, steps.length - 1)];
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.run(false); // reconnecting never starts a Hub by itself
		}, delay);
		this.timer.unref?.();
	}
}
