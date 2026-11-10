import * as fs from 'node:fs';
import * as http from 'node:http';
import { join } from 'node:path';
import { FailureLimiter, RateBucket } from '../auth';
import { ensureSecureDir, writeFileAtomic } from '../secure';
import { Session } from '../protocol';
import { BridgeError, BridgeUnavailable, HubBridge, HubEventRecord } from './bridge';
import { HttpError } from './errors';
import { LedgerError, RequestLedger } from './ledger';
import { canonical, parseComparison, parseTeam, verifyChoices } from './orchestration';
import { Pairing } from './pairing';
import { bearerOf, hostAllowed, newToken, originAllowed, sameSecret } from './security';
import { Device, RemoteStore, Workspace } from './store';
import { disableServe, enableServe, Runner, serveConfig, serveTarget, tailscaleState } from './tailscale';

/**
 * The Singularity Remote gateway: a small HTTP server, separate from the Hub, that lets a paired phone follow and steer the agents.
 *
 *   - It listens on 127.0.0.1 only. Reaching it from the phone is done by the user, with a private network (Tailscale Serve); the
 *     gateway never opens a public port, never forwards a router port and never changes the firewall.
 *   - The phone-facing API is an allow-list: each route is written out below and calls one allow-listed Hub operation. There is no
 *     shell, no file access and no generic pass-through, and the Hub's own token never leaves the Hub connection object.
 *   - The admin surface (pairing approval, workspaces, devices) is a second loopback port guarded by a secret that only the IDE reads.
 */
const MAX_BODY = 64 * 1024;
const WEB_FILES: Record<string, { file: string; type: string }> = {
	'/': { file: 'index.html', type: 'text/html; charset=utf-8' },
	'/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
	'/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
	'/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
	'/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json' },
	'/sw.js': { file: 'sw.js', type: 'text/javascript; charset=utf-8' },
	'/icon.svg': { file: 'icon.svg', type: 'image/svg+xml' },
	'/icon-192.png': { file: 'icon-192.png', type: 'image/png' },
	'/icon-512.png': { file: 'icon-512.png', type: 'image/png' }
};


/** Keeps only plain data: primitives, arrays and objects, bounded, without anything that looks like a path, a command or a secret. */
export function plain(value: unknown, depth = 4, stringLimit = 4000): unknown {
	if (value === null || typeof value === 'number' || typeof value === 'boolean') { return value; }
	if (typeof value === 'string') { return value.length > stringLimit ? value.slice(0, stringLimit) : value; }
	if (depth <= 0) { return undefined; }
	if (Array.isArray(value)) { return value.slice(0, 200).map(item => plain(item, depth - 1, stringLimit)); }
	if (typeof value === 'object' && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value).slice(0, 60)) {
			// usage counters are numbers the tool reported, not credentials: they keep their names (a token key is dropped, a token count is not)
			if (/path|token|secret|cwd|worktree|workspace|directory|command|executable|args|password|authorization/i.test(key) && !(typeof item === 'number' && /^(input|output|cachedInput|cacheRead|cacheWrite|reasoning|total)Tokens$/.test(key))) { continue; }
			const kept = plain(item, depth - 1, key === 'diff' || key === 'patch' ? 200_000 : stringLimit);
			if (kept !== undefined) { out[key] = kept; }
		}
		return out;
	}
	return undefined;
}

export interface GatewayOptions {
	/** Directory of the remote state (owner-only). */
	directory: string;
	/** Hub home to connect to (default: the user's). */
	hubHome?: string;
	webDir: string;
	publicPort?: number;
	adminPort?: number;
	bridge?: HubBridge;
	now?: () => number;
	env?: NodeJS.ProcessEnv;
	/** Wait before the second try of a Hub read that failed for a moment (the Hub is starting, or busy with another catalog read). */
	retryDelayMs?: number;
	/** Test hook for the `tailscale` command. */
	tailscaleRunner?: Runner;
}

export class RemoteGateway {
	readonly store: RemoteStore;
	readonly bridge: HubBridge;
	private readonly pairing: Pairing;
	private publicServer?: http.Server;
	private adminServer?: http.Server;
	publicPort = 0;
	adminPort = 0;
	private adminToken = '';
	private readonly pairFailures = new FailureLimiter(5, 60_000, 60_000);
	private readonly authFailures = new FailureLimiter(10, 60_000, 30_000);
	private readonly buckets = new Map<string, RateBucket>();
	private readonly streams = new Set<{ res: http.ServerResponse; device: string }>();
	readonly ledger: RequestLedger;
	private readonly sessionWorkspace = new Map<string, string>();
	private tailnet = false;

	constructor(private readonly opts: GatewayOptions) {
		this.store = new RemoteStore(opts.directory);
		this.bridge = opts.bridge ?? new HubBridge(opts.hubHome);
		this.pairing = new Pairing(name => this.store.authorize(name), opts.now);
		this.ledger = new RequestLedger(opts.directory, { now: opts.now });
	}

	// ---------- lifecycle ----------

	async start(): Promise<void> {
		ensureSecureDir(this.opts.directory);
		this.ledger.open();
		this.adminToken = newToken();
		writeFileAtomic(join(this.opts.directory, 'admin.token'), this.adminToken);
		this.publicServer = http.createServer((req, res) => void this.onPublic(req, res));
		this.adminServer = http.createServer((req, res) => void this.onAdmin(req, res));
		for (const server of [this.publicServer, this.adminServer]) {
			server.maxHeadersCount = 40; server.headersTimeout = 5000; server.requestTimeout = 15000; server.keepAliveTimeout = 5000;
		}
		this.publicPort = await this.listen(this.publicServer, this.opts.publicPort ?? 0);
		this.adminPort = await this.listen(this.adminServer, this.opts.adminPort ?? 0);
		this.bridge.on('event', (event: HubEventRecord) => this.onHubEvent(event));
		this.bridge.start();
		writeFileAtomic(join(this.opts.directory, 'gateway.json'), JSON.stringify({ v: 1, pid: process.pid, publicPort: this.publicPort, adminPort: this.adminPort, startedAt: new Date().toISOString() }));
	}

	// Loopback only, never 0.0.0.0 or ::
	private listen(server: http.Server, port: number): Promise<number> {
		return new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve((server.address() as { port: number }).port); });
		});
	}

	async stop(): Promise<void> {
		this.bridge.close();
		this.ledger.close();
		for (const stream of this.streams) { stream.res.end(); }
		this.streams.clear();
		await Promise.all([this.publicServer, this.adminServer].map(server => new Promise<void>(resolve => {
			if (!server) { return resolve(); }
			server.close(() => resolve());
			server.closeAllConnections();
		})));
		fs.rmSync(join(this.opts.directory, 'gateway.json'), { force: true });
		fs.rmSync(join(this.opts.directory, 'admin.token'), { force: true });
	}

	// ---------- shared HTTP helpers ----------

	private send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
		const payload = JSON.stringify(body);
		res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload), 'x-content-type-options': 'nosniff', ...extra });
		res.end(payload);
	}

	private async readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
		if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) { throw new HttpError(415, 'Use application/json.'); }
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > MAX_BODY) { throw new HttpError(413, 'Corpo grande demais.'); }
			chunks.push(chunk as Buffer);
		}
		try {
			const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
			if (typeof value !== 'object' || value === null || Array.isArray(value)) { throw new Error('shape'); }
			return value as Record<string, unknown>;
		} catch { throw new HttpError(400, 'JSON inválido.'); }
	}

	private fail(res: http.ServerResponse, error: unknown): void {
		if (error instanceof HttpError) { return this.send(res, error.status, { error: error.message }); }
		if (error instanceof BridgeUnavailable) { return this.send(res, 503, { error: error.message }); }
		if (error instanceof BridgeError) { return this.send(res, 422, { error: error.message }); }
		return this.send(res, 500, { error: 'Erro interno.' });
	}

	// ---------- phone-facing surface ----------

	private securityHeaders(): Record<string, string> {
		return {
			'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
			'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin',
			'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'x-frame-options': 'DENY'
		};
	}

	private async onPublic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			const host = req.headers.host;
			if (!hostAllowed(host, this.publicPort, this.store.tailnetNames())) { return this.send(res, 403, { error: 'Host não permitido.' }); }
			if (!originAllowed(req.headers.origin, host)) { return this.send(res, 403, { error: 'Origem não permitida.' }); }
			const url = new URL(req.url ?? '/', 'http://localhost');
			if (req.method === 'GET' && WEB_FILES[url.pathname] && !url.search) { return this.serveStatic(res, url.pathname); }
			if (!url.pathname.startsWith('/api/')) { return this.send(res, 404, { error: 'Não encontrado.' }); }
			await this.api(req, res, url);
		} catch (error) { this.fail(res, error); }
	}

	private serveStatic(res: http.ServerResponse, pathname: string): void {
		const entry = WEB_FILES[pathname];
		let data: Buffer;
		try { data = fs.readFileSync(join(this.opts.webDir, entry.file)); } catch { return this.send(res, 404, { error: 'Cliente web indisponível.' }); }
		res.writeHead(200, { 'content-type': entry.type, 'content-length': data.length, 'cache-control': 'no-cache', ...this.securityHeaders() });
		res.end(data);
	}

	private authenticate(req: http.IncomingMessage): Device {
		const token = bearerOf(req.headers.authorization);
		const device = token ? this.store.identify(token) : undefined;
		if (!device) {
			// Wrong tokens are counted and, past the limit, answered with 429; a valid token is never locked out by someone else's guesses.
			const limit = this.authFailures.check();
			if (!limit.allowed) { throw new HttpError(429, 'Muitas tentativas. Aguarde.'); }
			this.authFailures.fail();
			throw new HttpError(401, 'Dispositivo não autorizado.');
		}
		let bucket = this.buckets.get(device.id);
		if (!bucket) { bucket = new RateBucket(30, 60); this.buckets.set(device.id, bucket); }
		if (!bucket.take()) { throw new HttpError(429, 'Muitas requisições.'); }
		this.store.touch(device.id);
		return device;
	}

	private workspaceOf(session: Session): Workspace | undefined { return this.store.workspaceByPath(session.workspace); }

	private sessionView(session: Session): Record<string, unknown> | undefined {
		const workspace = this.workspaceOf(session);
		if (!workspace) { return undefined; }
		this.sessionWorkspace.set(session.id, workspace.id);
		const { id, harness, status, model, title, createdAt, updatedAt, summary, result, prompt, historical, resumable, permissionMode, failure, recovery, version } = session;
		return { id, harness, status, model, title, workspaceId: workspace.id, workspaceName: workspace.name, createdAt, updatedAt, summary, result, prompt, historical, resumable, permissionMode, failure, recovery, version };
	}

	private async ownSession(id: string): Promise<{ session: Session; workspace: Workspace }> {
		const session = (await this.bridge.sessions()).find(item => item.id === id);
		const workspace = session && this.workspaceOf(session);
		if (!session || !workspace) { throw new HttpError(404, 'Sessão não encontrada.'); }
		return { session, workspace };
	}

	private requireWorkspace(value: unknown): Workspace {
		const workspace = this.store.workspaceById(value);
		if (!workspace) { throw new HttpError(403, 'Workspace não autorizado.'); }
		return workspace;
	}

	private async api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
		const route = `${req.method} ${url.pathname}`;
		// ----- pairing (no device token yet) -----
		if (route === 'POST /api/pair/claim') {
			const limit = this.pairFailures.check();
			if (!limit.allowed) { return this.send(res, 429, { error: 'Muitas tentativas. Aguarde um minuto.' }, { 'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)) }); }
			const body = await this.readBody(req);
			const claim = this.pairing.claim(body.code, body.deviceName);
			if (!claim) { this.pairFailures.fail(); return this.send(res, 403, { error: 'Código inválido ou expirado.' }); }
			this.pairFailures.success();
			return this.send(res, 200, { claimId: claim.id, claimSecret: claim.secret, fingerprint: claim.fingerprint, expiresAt: claim.expiresAt });
		}
		if (req.method === 'POST' && url.pathname === '/api/pair/poll') {
			const body = await this.readBody(req);
			const status = this.pairing.poll(body.claimId, body.claimSecret);
			return this.send(res, 200, status);
		}
		// ----- everything below needs a paired device -----
		const device = this.authenticate(req);
		if (route === 'GET /api/status') {
			const { services, state: providersState } = await this.services();
			return this.send(res, 200, {
				hub: { connected: this.bridge.connected, instanceId: this.bridge.instanceId },
				providers: plain(services),
				// 'ok' when read just now, 'stale' when the last good reading is shown because the Hub did not answer, 'unavailable' when there is none yet
				providersState,
				workspaces: this.store.workspaces().map(({ id, name }) => ({ id, name })),
				device: { id: device.id, name: device.name, createdAt: device.createdAt },
				tailnet: this.tailnet
			});
		}
		if (route === 'GET /api/catalog') {
			const workspace = this.requireWorkspace(url.searchParams.get('workspaceId'));
			const service = url.searchParams.get('service');
			if (service !== null && !['opencode', 'claude-code', 'codex-cli'].includes(service)) { throw new HttpError(400, 'Provedor inválido.'); }
			return this.send(res, 200, plain(await this.withRetry('catalog.get', { workspace: workspace.path, ...(service ? { service } : {}) }), 6));
		}
		if (route === 'GET /api/sessions') {
			const views = (await this.bridge.sessions()).map(session => this.sessionView(session)).filter(Boolean);
			return this.send(res, 200, { sessions: views });
		}
		const history = /^\/api\/sessions\/([0-9a-f-]{36})\/history$/.exec(url.pathname);
		if (req.method === 'GET' && history) {
			const { workspace } = await this.ownSession(history[1]);
			return this.send(res, 200, { turns: plain(await this.bridge.call('session.history', { id: history[1], workspace: workspace.path }), 5) });
		}
		if (route === 'POST /api/sessions') {
			const body = await this.readBody(req);
			if (body.confirm !== true) { throw new HttpError(400, 'A ação precisa ser confirmada pelo usuário.'); }
			const workspace = this.requireWorkspace(body.workspaceId);
			const service = body.service;
			if (service !== 'opencode' && service !== 'claude-code' && service !== 'codex-cli') { throw new HttpError(400, 'Provedor inválido.'); }
			const model = body.model as { providerID?: unknown; modelID?: unknown; variant?: unknown } | undefined;
			if (!model || typeof model.providerID !== 'string' || typeof model.modelID !== 'string') { throw new HttpError(400, 'Modelo inválido.'); }
			const created = await this.bridge.call<Session>('session.create', {
				workspace: workspace.path, service, model: { providerID: model.providerID, modelID: model.modelID, ...(typeof model.variant === 'string' && model.variant ? { variant: model.variant } : {}) },
				...(typeof body.permissionMode === 'string' && body.permissionMode ? { permissionMode: body.permissionMode } : {})
			});
			return this.send(res, 201, { session: this.sessionView(created) });
		}
		const action = /^\/api\/sessions\/([0-9a-f-]{36})\/(prompt|interrupt)$/.exec(url.pathname);
		if (req.method === 'POST' && action) {
			const body = await this.readBody(req);
			if (body.confirm !== true) { throw new HttpError(400, 'A ação precisa ser confirmada pelo usuário.'); }
			await this.ownSession(action[1]);
			if (action[2] === 'interrupt') { return this.send(res, 200, await this.bridge.call('session.interrupt', { id: action[1] })); }
			const text = typeof body.text === 'string' ? body.text.trim() : '';
			if (!text || text.length > 16000) { throw new HttpError(400, 'Tarefa vazia ou grande demais.'); }
			// A request id makes a retry after a dropped connection a no-op: the prompt is never sent twice.
			const rawRequestId = typeof req.headers['x-request-id'] === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(req.headers['x-request-id']) ? req.headers['x-request-id'] : undefined;
			if (!rawRequestId) { throw new HttpError(400, 'X-Request-Id é obrigatório.'); }
			return this.sendPrompt(res, device.id, action[1], rawRequestId, text);
		}
		const resolve = /^\/api\/sessions\/([0-9a-f-]{36})\/requests\/([A-Za-z0-9_-]{8,64})$/.exec(url.pathname);
		if (resolve && (req.method === 'GET' || req.method === 'POST')) {
			await this.ownSession(resolve[1]);
			const record = this.ledger.get(device.id, resolve[1], resolve[2]);
			if (!record) { throw new HttpError(404, 'Este envio não está registrado.'); }
			if (req.method === 'POST') {
				const body = await this.readBody(req);
				if (body.confirm !== true || (body.action !== 'retry' && body.action !== 'discard')) { throw new HttpError(400, 'Escolha explicitamente reenviar ou descartar.'); }
				try { this.ledger.resolve(record, body.action); } catch (error) { throw new HttpError(409, (error as Error).message); }
			}
			return this.send(res, 200, { state: record.state, resolution: record.resolution ?? null, attempts: record.attempts });
		}
		if (await this.orchestrate(req, res, url, route, device)) { return; }
		if (route === 'GET /api/policy') {
			// what the implementer of this workspace may run, as the owner set it on the computer. There is no route that changes it.
			const workspace = this.requireWorkspace(url.searchParams.get('workspaceId'));
			const policy = await this.bridge.call<{ mode?: string; external?: boolean }>('policy.get', { workspace: workspace.path });
			return this.send(res, 200, { mode: ['development', 'autonomous'].includes(String(policy?.mode)) ? policy.mode : 'restricted', external: policy?.external === true });
		}
		if (route === 'GET /api/usage') { return this.send(res, 200, await this.bridge.call('usage.get', {})); }
		if (route === 'GET /api/comparisons' || route === 'GET /api/teams') {
			const workspaces = this.store.workspaces();
			const out: unknown[] = [];
			for (const workspace of workspaces) {
				const records = await this.bridge.call<Array<Record<string, unknown>>>(route.endsWith('comparisons') ? 'comparisons.list' : 'teams.list', { workspace: workspace.path }).catch(() => []);
				for (const record of records) { out.push({ ...(plain(record, 6) as object), workspaceId: workspace.id, workspaceName: workspace.name }); }
			}
			return this.send(res, 200, route.endsWith('comparisons') ? { comparisons: out } : { teams: out });
		}
		const diff = /^\/api\/comparisons\/([A-Za-z0-9_-]{4,64})\/([A-Za-z0-9_-]{4,64})\/diff$/.exec(url.pathname);
		if (req.method === 'GET' && diff) {
			const workspace = this.requireWorkspace(url.searchParams.get('workspaceId'));
			return this.send(res, 200, plain(await this.bridge.call('comparisons.inspect', { id: diff[1], workspace: workspace.path, participantId: diff[2] }), 6));
		}
		if (route === 'GET /api/events') { return this.stream(req, res, device, Number(url.searchParams.get('after') ?? '0') || 0); }
		if (route === 'GET /api/device') { return this.send(res, 200, { id: device.id, name: device.name, createdAt: device.createdAt, lastSeen: device.lastSeen }); }
		if (route === 'POST /api/logout') {
			this.store.revoke(device.id);
			this.closeStreams(device.id);
			return this.send(res, 200, { revoked: true });
		}
		return this.send(res, 404, { error: 'Rota não permitida.' });
	}

	// ---------- Remote 2.0: start and steer comparisons and teams ----------

	private lastServices?: unknown[];

	/** A read of the Hub that may fail for a moment is tried once more; a Hub that is not connected at all is not (nothing to wait for). */
	private async withRetry<T = unknown>(method: Parameters<HubBridge['call']>[0], params?: unknown, timeout = 60000): Promise<T> {
		try { return await this.bridge.call<T>(method, params, timeout); } catch (error) {
			if (error instanceof BridgeUnavailable) { throw error; }
			await new Promise(resolve => setTimeout(resolve, this.opts.retryDelayMs ?? 2500));
			return this.bridge.call<T>(method, params, timeout);
		}
	}

	/**
	 * The services (OpenCode, Claude Code, Codex CLI) and whether each is available. Reading them can fail for a moment (the Hub is starting, or it is
	 * busy with another catalog read), and that must never leave the phone with empty selectors: one more try, then the last good reading.
	 */
	private async services(): Promise<{ services: unknown[]; state: 'ok' | 'stale' | 'unavailable' }> {
		if (this.bridge.connected) {
			for (let attempt = 0; attempt < 2; attempt++) {
				const catalog = await this.bridge.call<{ services?: unknown[] }>('catalog.get', {}, 60000).catch(() => undefined);
				if (Array.isArray(catalog?.services) && catalog.services.length) { this.lastServices = catalog.services; return { services: catalog.services, state: 'ok' }; }
				if (attempt === 0) { await new Promise(resolve => setTimeout(resolve, this.opts.retryDelayMs ?? 2500)); }
			}
		}
		return this.lastServices ? { services: this.lastServices, state: 'stale' } : { services: [], state: 'unavailable' };
	}

	private requestIdOf(req: http.IncomingMessage): string {
		const value = req.headers['x-request-id'];
		if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) { throw new HttpError(400, 'X-Request-Id é obrigatório.'); }
		return value;
	}

	private async orchestrate(req: http.IncomingMessage, res: http.ServerResponse, url: URL, route: string, device: Device): Promise<boolean> {
		if (route === 'GET /api/validation-profiles') {
			const workspace = this.requireWorkspace(url.searchParams.get('workspaceId'));
			// only the label and an opaque id: what runs is never shown to the phone and never chosen by it
			this.send(res, 200, { profiles: this.store.profiles(workspace.id).map(({ id, label }) => ({ id, label })) });
			return true;
		}
		const detail = /^\/api\/(comparisons|teams)\/([0-9a-f-]{36})$/.exec(url.pathname);
		if (req.method === 'GET' && detail) {
			const workspace = this.requireWorkspace(url.searchParams.get('workspaceId'));
			const records = await this.bridge.call<Array<{ id?: string }>>(detail[1] === 'comparisons' ? 'comparisons.list' : 'teams.list', { workspace: workspace.path });
			const found = records.find(record => record.id === detail[2]);
			if (!found) { throw new HttpError(404, 'Não encontrado neste workspace.'); }
			this.send(res, 200, { ...(plain(found, 6) as object), workspaceId: workspace.id, workspaceName: workspace.name });
			return true;
		}
		const operation = /^\/api\/operations\/([a-z.]{3,40})\/([A-Za-z0-9_-]{4,64})\/([A-Za-z0-9_-]{8,64})$/.exec(url.pathname);
		if (operation && (req.method === 'GET' || req.method === 'POST')) {
			const record = this.ledger.get(device.id, operation[2], operation[3], operation[1]);
			if (!record) { throw new HttpError(404, 'Este envio não está registrado.'); }
			if (req.method === 'POST') {
				const body = await this.readBody(req);
				if (body.confirm !== true || (body.action !== 'retry' && body.action !== 'discard')) { throw new HttpError(400, 'Escolha explicitamente tentar de novo ou descartar.'); }
				try { this.ledger.resolve(record, body.action); } catch (error) { throw new HttpError(409, (error as Error).message); }
			}
			this.send(res, 200, { state: record.state, resolution: record.resolution ?? null, attempts: record.attempts, ref: record.ref ?? null });
			return true;
		}
		if (req.method !== 'POST') { return false; }

		if (route === 'POST /api/comparisons') {
			const body = await this.readBody(req);
			if (body.confirm !== true) { throw new HttpError(400, 'A ação precisa ser confirmada pelo usuário.'); }
			const rid = this.requestIdOf(req);
			const input = parseComparison(body);
			const workspace = this.requireWorkspace(input.workspaceId);
			await this.operate(res, device.id, { action: 'comparison.create', scope: workspace.id, rid, content: { text: input.text, participants: input.participants }, status: 201,
				perform: async () => {
					await verifyChoices({ call: (method, params, timeout) => this.withRetry(method, params, timeout) }, workspace.path, input.participants);
					const created = await this.bridge.call<{ id: string }>('comparisons.create', { workspace: workspace.path, text: input.text, participants: input.participants });
					return { ref: created.id, body: { comparison: { id: created.id, workspaceId: workspace.id } } };
				},
				reconcile: async () => {
					const wanted = JSON.stringify(canonical({ text: input.text, participants: input.participants }));
					const list = await this.bridge.call<Array<{ id: string; prompt: string; createdAt: number; participants: Array<{ service: string; model: { providerID: string; modelID: string; variant?: string } }> }>>('comparisons.list', { workspace: workspace.path });
					const since = this.ledger.get(device.id, workspace.id, rid, 'comparison.create')?.createdAt ?? 0;
					const match = list.find(item => item.createdAt >= since - 2000 && JSON.stringify(canonical({ text: item.prompt, participants: item.participants.map(p => ({ service: p.service, model: { providerID: p.model.providerID, modelID: p.model.modelID, ...(p.model.variant ? { variant: p.model.variant } : {}) } })) })) === wanted);
					return { found: !!match, ref: match?.id };
				} });
			return true;
		}
		if (route === 'POST /api/teams') {
			const body = await this.readBody(req);
			if (body.confirm !== true) { throw new HttpError(400, 'A ação precisa ser confirmada pelo usuário.'); }
			const rid = this.requestIdOf(req);
			const input = parseTeam(body);
			const workspace = this.requireWorkspace(input.workspaceId);
			await this.operate(res, device.id, { action: 'team.start', scope: workspace.id, rid, content: { text: input.text, roles: input.roles, maxCorrections: input.maxCorrections }, status: 201,
				perform: async () => {
					await verifyChoices({ call: (method, params, timeout) => this.withRetry(method, params, timeout) }, workspace.path, input.roles);
					const created = await this.bridge.call<{ id: string }>('teams.start', { workspace: workspace.path, text: input.text, participants: input.roles, maxCorrections: input.maxCorrections });
					return { ref: created.id, body: { team: { id: created.id, workspaceId: workspace.id } } };
				},
				reconcile: async () => {
					const list = await this.bridge.call<Array<{ id: string; task: string; createdAt: number; maxCorrections: number; roles: Array<{ service: string; model: { providerID: string; modelID: string; variant?: string } }> }>>('teams.list', { workspace: workspace.path });
					const since = this.ledger.get(device.id, workspace.id, rid, 'team.start')?.createdAt ?? 0;
					const wanted = JSON.stringify(canonical({ text: input.text, roles: input.roles, maxCorrections: input.maxCorrections }));
					const match = list.find(item => item.createdAt >= since - 2000 && JSON.stringify(canonical({ text: item.task, roles: item.roles.map(p => ({ service: p.service, model: { providerID: p.model.providerID, modelID: p.model.modelID, ...(p.model.variant ? { variant: p.model.variant } : {}) } })), maxCorrections: item.maxCorrections })) === wanted);
					return { found: !!match, ref: match?.id };
				} });
			return true;
		}

		const action = /^\/api\/(comparisons|teams)\/([0-9a-f-]{36})\/(cancel|select|resume|choose|validate|delete|instruct)$/.exec(url.pathname);
		if (!action) { return false; }
		const body = await this.readBody(req);
		if (body.confirm !== true) { throw new HttpError(400, 'A ação precisa ser confirmada pelo usuário.'); }
		const rid = this.requestIdOf(req);
		const workspace = this.requireWorkspace(body.workspaceId);
		const [, kind, id, verb] = action;
		const allowed = kind === 'comparisons' ? ['cancel', 'select'] : ['cancel', 'resume', 'choose', 'validate', 'delete', 'instruct'];
		const instruction = typeof body.text === 'string' ? body.text.trim() : '';
		if (kind === 'teams' && verb === 'instruct' && (!instruction || instruction.length > 3000)) { throw new HttpError(400, 'Escreva a nova instrução (até 3000 caracteres).'); }
		const since = Date.now();
		if (!allowed.includes(verb)) { throw new HttpError(404, 'Ação não disponível.'); }
		const participantId = typeof body.participantId === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(body.participantId) ? body.participantId : undefined;
		const role = typeof body.role === 'string' && ['implementer', 'reviewer', 'tester'].includes(body.role) ? body.role : undefined;
		if (kind === 'comparisons' && verb === 'select' && !participantId) { throw new HttpError(400, 'Escolha a solução a revisar.'); }
		let profile: { executable: string; args: string[] } | undefined;
		if (kind === 'teams' && verb === 'validate') {
			profile = this.store.profileById(workspace.id, body.profileId);
			if (!profile) { throw new HttpError(403, 'Este perfil de teste não está cadastrado para este workspace. Cadastre-o na IDE Windows.'); }
		}
		const stateOf = async (): Promise<Record<string, any> | undefined> => (await this.bridge.call<Array<Record<string, any>>>(kind === 'comparisons' ? 'comparisons.list' : 'teams.list', { workspace: workspace.path })).find(item => item.id === id);
		await this.operate(res, device.id, { action: `${kind}.${verb}`, scope: id, rid, content: { workspace: workspace.id, participantId, role, profileId: profile ? body.profileId : undefined, ...(verb === 'instruct' ? { text: instruction } : {}) }, status: 200,
			perform: async () => {
				const params = { id, workspace: workspace.path };
				if (kind === 'comparisons' && verb === 'cancel') { await this.bridge.call('comparisons.cancel', { ...params, ...(participantId ? { participantId } : {}) }); }
				else if (kind === 'comparisons') { await this.bridge.call('comparisons.select', { ...params, participantId }); }
				else if (verb === 'cancel') { await this.bridge.call('teams.cancel', { ...params, ...(role ? { role } : {}) }); }
				else if (verb === 'resume') { await this.bridge.call('teams.resume', params); }
				else if (verb === 'delete') { await this.bridge.call('teams.delete', params); }
				else if (verb === 'instruct') { await this.bridge.call('teams.instruct', { ...params, text: instruction }, 120000); }
				else if (verb === 'choose') { await this.bridge.call('teams.choose', params); }
				else { await this.bridge.call('teams.validate', { ...params, command: { executable: profile!.executable, args: profile!.args, approved: true } }); }
				return { body: { ok: true } };
			},
			reconcile: async () => {
				const item = await stateOf().catch(() => undefined);
				if (verb === 'delete') { return { found: !item }; }
				if (!item) { return { found: false }; }
				if (kind === 'comparisons' && verb === 'select') { return { found: item.selected === participantId }; }
				if (kind === 'comparisons') { return { found: (item.participants ?? []).some((p: { id: string; status: string }) => (!participantId || p.id === participantId) && p.status === 'cancelled') }; }
				if (verb === 'cancel') { return { found: item.state === 'cancelled' || (role ? (item.cancelledRoles ?? []).includes(role) : false) }; }
				if (verb === 'choose') { return { found: item.chosen === true }; }
				if (verb === 'instruct') { return { found: (item.followUps ?? []).some((entry: { text: string; at: number }) => entry.text === instruction && entry.at >= since - 2000) }; }
				if (verb === 'resume') { return { found: item.state !== 'paused' }; }
				return { found: (item.versions ?? []).some((v: { validation?: unknown }) => !!v.validation) };
			} });
		return true;
	}

	/**
	 * One multi-agent operation, through the same persistent ledger as the instructions: written to disk before the Hub is asked, bound to
	 * device, workspace/target, action and content, never repeated on its own when its outcome is unknown, reconciled with what the Hub shows.
	 */
	private async operate(res: http.ServerResponse, deviceId: string, spec: {
		action: string; scope: string; rid: string; content: unknown; status: number;
		perform: () => Promise<{ ref?: string; body: object }>; reconcile: () => Promise<{ found: boolean; ref?: string }>;
	}): Promise<void> {
		let decision;
		try { decision = this.ledger.begin(deviceId, spec.scope, spec.rid, JSON.stringify(canonical(spec.content)), spec.action); } catch (error) {
			if (error instanceof LedgerError) { return this.send(res, 503, { state: 'blocked', error: 'Não foi possível registrar a operação com segurança; nada foi iniciado.' }); }
			throw error;
		}
		const settle = async (record: import('./ledger').LedgerRecord): Promise<boolean> => {
			try { const evidence = await spec.reconcile(); if (evidence.found) { this.ledger.reconciled(record, evidence.ref ?? record.ref); } return evidence.found; } catch { return false; }
		};
		switch (decision.kind) {
			case 'blocked': return this.send(res, 503, { state: 'blocked', error: decision.reason });
			case 'conflict': return this.send(res, 409, { state: 'conflict', error: 'Este identificador já foi usado para outra operação.' });
			case 'in-progress': return this.send(res, 202, { state: 'processing' });
			case 'duplicate': return this.send(res, 200, { duplicate: true, state: decision.record.state, resolution: decision.record.resolution ?? null, ref: decision.record.ref ?? null });
			case 'unknown': {
				if (await settle(decision.record)) { return this.send(res, 200, { duplicate: true, state: 'reconciled', resolution: 'sent', ref: decision.record.ref ?? null }); }
				return this.send(res, 409, { state: 'unknown', needsResolution: true, error: 'Não foi possível confirmar se esta operação foi iniciada.' });
			}
			case 'dispatch': break;
		}
		const record = decision.record;
		try {
			const result = await spec.perform();
			this.ledger.confirm(record, result.ref);
			return this.send(res, spec.status, { ...result.body, state: 'confirmed' });
		} catch (error) {
			if (error instanceof BridgeUnavailable || error instanceof BridgeError || error instanceof HttpError) {
				try { this.ledger.failedBeforeSend(record, error instanceof Error ? error.message.slice(0, 160) : 'Recusado.'); } catch { /* the next start marks it unknown */ }
				return this.fail(res, error);
			}
			try { this.ledger.unknown(record, 'A conexão com o Hub caiu antes da confirmação.'); } catch { /* the next start marks it unknown */ }
			if (await settle(record)) { return this.send(res, 200, { state: 'reconciled', resolution: 'sent', ref: record.ref ?? null }); }
			return this.send(res, 409, { state: 'unknown', needsResolution: true, error: 'Não foi possível confirmar se esta operação foi iniciada.' });
		}
	}

	/**
	 * The one place that sends an instruction to the Hub. The ledger decides first and writes "processing" to disk before anything is
	 * dispatched; the answers below never invent an outcome: a lost connection after dispatch is "unknown", never "failed".
	 */
	private async sendPrompt(res: http.ServerResponse, deviceId: string, sessionId: string, requestId: string, text: string): Promise<void> {
		let decision;
		try { decision = this.ledger.begin(deviceId, sessionId, requestId, text); } catch (error) {
			if (error instanceof LedgerError) { return this.send(res, 503, { state: 'blocked', error: 'Não foi possível registrar o envio com segurança; nada foi enviado ao agente.' }); }
			throw error;
		}
		switch (decision.kind) {
			case 'blocked': return this.send(res, 503, { state: 'blocked', error: decision.reason });
			case 'conflict': return this.send(res, 409, { state: 'conflict', error: 'Este identificador já foi usado para outra instrução ou outra sessão.' });
			case 'in-progress': return this.send(res, 202, { state: 'processing' });
			case 'duplicate': return this.send(res, 200, { duplicate: true, state: decision.record.state, resolution: decision.record.resolution ?? null });
			case 'unknown': {
				if (await this.reconcile(decision.record.sessionId, decision.record, text)) { return this.send(res, 200, { duplicate: true, state: 'reconciled', resolution: 'sent' }); }
				return this.send(res, 409, { state: 'unknown', needsResolution: true, error: 'Não foi possível confirmar se esta instrução chegou ao agente.' });
			}
			case 'dispatch': break;
		}
		const record = decision.record;
		try {
			const result = await this.bridge.call('session.prompt', { id: sessionId, text });
			this.ledger.confirm(record);
			return this.send(res, 200, { ...(result && typeof result === 'object' ? result as object : {}), state: 'confirmed' });
		} catch (error) {
			if (error instanceof BridgeUnavailable || error instanceof BridgeError) {
				// the Hub was not connected, or it answered with a refusal: the instruction did not run
				try { this.ledger.failedBeforeSend(record, error instanceof BridgeError ? 'O Hub recusou a instrução.' : 'O Hub não estava conectado.'); } catch { /* the state stays "processing" in memory only; the next start marks it unknown */ }
				return this.fail(res, error);
			}
			try { this.ledger.unknown(record, 'A conexão com o Hub caiu antes da confirmação.'); } catch { /* the next start marks it unknown */ }
			if (await this.reconcile(sessionId, record, text)) { return this.send(res, 200, { state: 'reconciled', resolution: 'sent' }); }
			return this.send(res, 409, { state: 'unknown', needsResolution: true, error: 'Não foi possível confirmar se esta instrução chegou ao agente.' });
		}
	}

	/** Looks for the instruction in what the Hub itself recorded after the send began. Conclusive only when it is found. */
	private async reconcile(sessionId: string, record: import('./ledger').LedgerRecord, text: string): Promise<boolean> {
		try {
			const { workspace } = await this.ownSession(sessionId);
			const turns = await this.bridge.call<Array<{ prompt?: unknown; at?: unknown }>>('session.history', { id: sessionId, workspace: workspace.path });
			const found = turns.some(turn => typeof turn.prompt === 'string' && typeof turn.at === 'number' && turn.at >= record.createdAt - 2000 && this.ledger.digest(sessionId, turn.prompt.trim()) === this.ledger.digest(sessionId, text));
			if (found) { this.ledger.reconciled(record); }
			return found;
		} catch { return false; }
	}


	// ---------- events ----------

	private async stream(req: http.IncomingMessage, res: http.ServerResponse, device: Device, after: number): Promise<void> {
		res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
		const entry = { res, device: device.id };
		this.streams.add(entry);
		req.on('close', () => this.streams.delete(entry));
		// refresh the session→workspace map, then replay what the phone missed (reading only: nothing is sent to an agent)
		await this.bridge.sessions().then(list => list.forEach(session => this.sessionView(session))).catch(() => undefined);
		res.write(`event: hello\ndata: ${JSON.stringify({ seq: this.bridge.eventsAfter(0).at(-1)?.seq ?? 0, hub: this.bridge.connected })}\n\n`);
		for (const event of this.bridge.eventsAfter(after)) { this.writeEvent(res, event); }
	}

	private writeEvent(res: http.ServerResponse, event: HubEventRecord): void {
		const sessionId = event.sessionId;
		let payload: Record<string, unknown> = { seq: event.seq, type: event.type };
		if (sessionId) {
			const known = this.sessionWorkspace.get(sessionId);
			const changed = event.type === 'session.changed' ? this.sessionView(event.data as Session) : undefined;
			if (!known && !changed) { return; }
			payload = { ...payload, sessionId };
			if (changed) { payload.session = changed; }
			const name = (event.data as { name?: unknown } | undefined)?.name;
			if (typeof name === 'string' && /^[a-z0-9_.]{1,60}$/i.test(name)) { payload.name = name; }
		}
		res.write(`id: ${event.seq}\nevent: hub\ndata: ${JSON.stringify(payload)}\n\n`);
	}

	private onHubEvent(event: HubEventRecord): void {
		for (const stream of this.streams) { this.writeEvent(stream.res, event); }
	}

	private closeStreams(deviceId: string): void {
		for (const stream of [...this.streams]) { if (stream.device === deviceId) { stream.res.end(); this.streams.delete(stream); } }
	}

	// ---------- admin surface (the IDE) ----------

	private async onAdmin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			// A browser page must never reach this surface: no Origin at all, loopback Host only, and the secret.
			if (req.headers.origin !== undefined || !hostAllowed(req.headers.host, this.adminPort, [])) { return this.send(res, 403, { error: 'Não permitido.' }); }
			const presented = req.headers['x-admin-token'];
			if (typeof presented !== 'string' || !sameSecret(presented, this.adminToken)) { return this.send(res, 401, { error: 'Não autorizado.' }); }
			const url = new URL(req.url ?? '/', 'http://localhost');
			const route = `${req.method} ${url.pathname}`;
			if (route === 'GET /admin/state') {
				return this.send(res, 200, {
					publicPort: this.publicPort, hub: this.bridge.connected, workspaces: this.store.workspaces(), devices: this.store.devices().map(({ id, name, createdAt, lastSeen, revokedAt }) => ({ id, name, createdAt, lastSeen, revokedAt })),
					pairing: this.pairing.active(), pending: this.pairing.pending(), tailnetNames: this.store.tailnetNames(), tailnet: this.tailnet
				});
			}
			const body = req.method === 'POST' ? await this.readBody(req) : {};
			if (route === 'POST /admin/pairing/start') { return this.send(res, 200, this.pairing.start()); }
			if (route === 'POST /admin/pairing/cancel') { this.pairing.cancel(); return this.send(res, 200, { ok: true }); }
			if (route === 'POST /admin/pairing/decide') {
				if (typeof body.id !== 'string' || typeof body.approve !== 'boolean') { throw new HttpError(400, 'Parâmetros inválidos.'); }
				return this.send(res, 200, { ok: this.pairing.decide(body.id, body.approve) });
			}
			if (route === 'POST /admin/workspaces/add') {
				if (typeof body.path !== 'string' || body.path.length > 1024) { throw new HttpError(400, 'Caminho inválido.'); }
				return this.send(res, 200, { workspace: this.store.addWorkspace(body.path) });
			}
			if (route === 'POST /admin/workspaces/remove') { return this.send(res, 200, { ok: this.store.removeWorkspace(String(body.id)) }); }
			if (route === 'GET /admin/profiles') { return this.send(res, 200, { profiles: this.store.profiles() }); }
			if (route === 'POST /admin/profiles/add') {
				if (body.confirm !== true) { throw new HttpError(400, 'O cadastro precisa ser confirmado.'); }
				try { return this.send(res, 200, { profile: this.store.addProfile(String(body.workspaceId), String(body.label ?? ''), String(body.executable ?? ''), Array.isArray(body.args) ? body.args as string[] : []) }); } catch (error) { throw new HttpError(400, (error as Error).message); }
			}
			if (route === 'POST /admin/profiles/remove') { return this.send(res, 200, { ok: this.store.removeProfile(String(body.id)) }); }
			if (route === 'POST /admin/devices/revoke') {
				const id = String(body.id);
				this.closeStreams(id);
				return this.send(res, 200, { ok: this.store.revoke(id) });
			}
			if (route === 'GET /admin/requests') { return this.send(res, 200, { counts: this.ledger.counts(), unresolved: this.ledger.unresolved() }); }
			if (route === 'POST /admin/requests/reset') {
				if (body.confirm !== true) { throw new HttpError(400, 'A reinicialização precisa ser confirmada.'); }
				this.ledger.reset();
				return this.send(res, 200, { counts: this.ledger.counts() });
			}
			if (route === 'GET /admin/tailscale') {
				const state = await tailscaleState(this.opts.env, this.opts.tailscaleRunner);
				const serve = state.installed ? await serveConfig(this.opts.env, this.opts.tailscaleRunner) : { known: false, configured: false, targets: [] as string[], funnel: false };
				const previous = this.store.servedPort();
				const pointsHere = serve.targets.includes(serveTarget(this.publicPort));
				const stale = !pointsHere && previous !== undefined && serve.targets.includes(serveTarget(previous));
				return this.send(res, 200, { ...state, gatewayPort: this.publicPort, serve: {
					known: serve.known, configured: serve.configured, funnel: serve.funnel, pointsHere, stale,
					// another publication on this computer that is not this gateway's: it is reported, never replaced silently
					conflict: serve.targets.some(target => target !== serveTarget(this.publicPort) && (previous === undefined || target !== serveTarget(previous))),
					previouslyPublished: previous !== undefined || this.store.tailnetNames().length > 0
				} });
			}
			if (route === 'POST /admin/tailscale/serve') {
				if (body.consent !== true) { throw new HttpError(400, 'É preciso consentimento explícito.'); }
				const state = await tailscaleState(this.opts.env, this.opts.tailscaleRunner);
				if (!state.installed || !state.loggedIn || !state.dnsName) { return this.send(res, 200, { ok: false, reason: state.reason }); }
				// always the port this gateway is listening on right now, never a remembered one
				const result = await enableServe(this.publicPort, this.opts.env, this.opts.tailscaleRunner, { previousPort: this.store.servedPort(), replace: body.replace === true });
				if (result.ok) { this.store.setTailnetNames([state.dnsName]); this.store.setServedPort(this.publicPort); this.tailnet = true; }
				return this.send(res, 200, { ...result, url: result.ok ? `https://${state.dnsName}/` : undefined });
			}
			if (route === 'POST /admin/tailscale/off') {
				const result = await disableServe(this.publicPort, this.opts.env, this.opts.tailscaleRunner);
				if (result.ok && !result.skipped) { this.tailnet = false; this.store.setServedPort(undefined); }
				return this.send(res, 200, result);
			}
			if (route === 'POST /admin/stop') { this.send(res, 200, { ok: true }); setImmediate(() => process.emit('SIGTERM')); return; }
			this.send(res, 404, { error: 'Rota não encontrada.' });
		} catch (error) { this.fail(res, error); }
	}
}
