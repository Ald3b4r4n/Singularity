'use strict';

// Real HubClient: a thin adapter over the HubSupervisor from the singularity-hub package.
// The token is read and used inside the supervisor, in this extension host process. It is never part
// of the state returned here, so it can never reach the webview.

const path = require('path');

// Development layout: <repo>/extensions/singularity-agents  and  <repo>/singularity-hub (built with `npm run build`).
// Packaged builds will ship the same relative layout under resources/app.
const HUB_PACKAGE = path.join(__dirname, '..', '..', 'singularity-hub', 'dist', 'index.js');

class RealHubClient {
	/** @param {{ nodePath?: string }} options */
	constructor(options = {}) {
		this._listeners = new Set();
		this._supervisor = undefined;
		this._unavailable = undefined;

		try {
			const { HubSupervisor } = require(HUB_PACKAGE);
			this._supervisor = new HubSupervisor({ nodePath: options.nodePath || undefined, clientName: 'singularity-ide' });
			this._supervisor.on('change', () => this._emit());
		} catch {
			this._unavailable = 'O Singularity Hub não está compilado. Execute "npm run build" na pasta singularity-hub.';
		}
	}

	getState() {
		if (!this._supervisor) {
			return { hub: { status: 'error', detail: this._unavailable }, sessions: [] };
		}
		return this._supervisor.getState();
	}

	onDidChange(listener) {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	/** Connects to a running Hub; with `spawn`, starts one first if none answers. */
	async start(spawn) {
		if (this._supervisor) {
			await this._supervisor.start(spawn);
		}
	}

	async stopHub() {
		if (!this._supervisor) {
			throw new Error(this._unavailable);
		}
		await this._supervisor.stopHub();
	}

	/** Services, providers, models and effort levels read from the service itself (never any secret: see the Hub's catalog.ts). */
	async installProvider(params) {
		if (!this._supervisor) { throw new Error('O Singularity Hub não está disponível.'); }
		return this._supervisor.installProvider(params);
	}

	async inspectProviders(params) {
		if (!this._supervisor) { throw new Error('O Singularity Hub não está disponível.'); }
		return this._supervisor.inspectProviders(params);
	}

	async catalog(params) {
		if (!this._supervisor) {
			throw new Error(this._unavailable);
		}
		return this._supervisor.catalog(params);
	}

	async sessionRequest(method, params) {
		if (!this._supervisor) {
			throw new Error(this._unavailable);
		}
		return this._supervisor.sessionRequest(method, params);
	}

	dispose() {
		if (this._supervisor) {
			this._supervisor.dispose();
		}
		this._listeners.clear();
	}

	_emit() {
		for (const l of [...this._listeners]) {
			l();
		}
	}
}

module.exports = { RealHubClient };
