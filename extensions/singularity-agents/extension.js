'use strict';

const vscode = require('vscode');
const { RealHubClient } = require('./hubClient.js');
const { selectionOf, same, text } = require('./selection.js');

const VIEW_ID = 'singularity.agents.sessions';
const CONTAINER_ID = 'singularityAgents';
const PREFS_KEY = 'singularity.agents.prefs';
const WORKSPACE_KEY = 'singularity.agents.workspace';

class AgentsViewProvider {
	/**
	 * @param {vscode.ExtensionContext} context
	 * @param {{ getState(): object, onDidChange(l: () => void): () => void }} hub
	 * @param {() => void} onVisible called when the panel is shown
	 */
	constructor(context, hub, onVisible) {
		this._context = context;
		this._extensionUri = context.extensionUri;
		this._onVisible = onVisible;
		this._hub = hub;
		this._view = undefined;
	}

	resolveWebviewView(view) {
		this._view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')] };
		view.webview.html = this._html(view.webview);

		const stop = this._hub.onDidChange(() => this._post());
		view.onDidDispose(() => { stop(); this._view = undefined; });
		view.onDidChangeVisibility(() => { if (view.visible) { this._onVisible(); this._post(); } });
		this._onVisible();
		view.webview.onDidReceiveMessage(async message => {
			if (message && message.type === 'ready') {
				this._post();
				this._postPrefs();
			} else if (message && message.type === 'openSettings') {
				await vscode.commands.executeCommand('singularity.agents.openSettings');
			} else {
				try {
					await this._operate(message);
				} catch (error) {
					const reason = error instanceof Error ? error.message : 'A operação falhou.';
					this._view?.webview.postMessage({ type: 'failed', message: reason });
				}
			}
		});
	}

	// ---------- workspace and preferences ----------

	_folders() {
		return (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
	}

	_workspace() {
		const saved = this._context.globalState.get(WORKSPACE_KEY);
		if (typeof saved === 'string' && saved) { return saved; }
		return this._folders()[0]?.uri.fsPath;
	}

	_postPrefs() {
		this._view?.webview.postMessage({ type: 'prefs', prefs: this._context.globalState.get(PREFS_KEY) ?? {}, workspace: this._workspace() ?? '' });
	}

	async _pickWorkspace() {
		const folders = this._folders().map(folder => ({ label: folder.name, description: folder.uri.fsPath, uri: folder.uri }));
		const picked = await vscode.window.showQuickPick([...folders, { label: 'Escolher outra pasta...' }], {
			title: 'Workspace das sessões de agentes', placeHolder: 'Selecione a pasta em que o agente poderá trabalhar'
		});
		if (!picked) {
			return undefined;
		}
		const uri = picked.uri ?? (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: 'Usar como workspace' }))?.[0];
		if (uri?.scheme === 'file') {
			await this._context.globalState.update(WORKSPACE_KEY, uri.fsPath);
			this._postPrefs();
			return uri.fsPath;
		}
		return undefined;
	}

	// ---------- operations ----------

	async _operate(message) {
		const post = payload => this._view?.webview.postMessage(payload);
		if (message?.type === 'reconnect') {
			await this._hub.start(true);
			return;
		}
		if (message?.type === 'prefs') {
			const prefs = message.prefs;
			if (prefs && typeof prefs === 'object') {
				await this._context.globalState.update(PREFS_KEY, {
					service: text(prefs.service, 40), providerID: text(prefs.providerID, 160), modelID: text(prefs.modelID, 160),
					variant: typeof prefs.variant === 'string' && prefs.variant.length <= 24 ? prefs.variant : ''
				});
			}
			return;
		}
		if (message?.type === 'pickWorkspace') {
			await this._pickWorkspace();
			return;
		}
		if (message?.type === 'catalog') {
			try {
				const catalog = await this._hub.catalog({ service: 'opencode', workspace: this._workspace(), refresh: message.refresh === true });
				post({ type: 'catalog', catalog });
			} catch (error) {
				post({ type: 'catalog', error: error instanceof Error ? error.message : 'Não foi possível ler o catálogo.' });
			}
			return;
		}
		if (message?.type === 'send') {
			await this._send(message);
			return;
		}
		if (typeof message?.id !== 'string') {
			return;
		}
		if (message.type === 'interrupt') {
			const result = await this._hub.sessionRequest('session.interrupt', { id: message.id });
			if (!result.interrupted) {
				await vscode.window.showInformationMessage('O OpenCode não encontrou uma execução ativa para cancelar.');
			}
		} else if (message.type === 'stop') {
			await this._hub.sessionRequest('session.stop', { id: message.id });
		}
	}

	/**
	 * One task from the single composer. With a session in use the model is switched first when the choice differs (the Hub
	 * validates it), then the prompt is sent; with no session, one is created now, with the chosen model, in the workspace.
	 */
	async _send(message) {
		const body = text(message.text?.trim?.(), 16000);
		const selection = selectionOf(message.selection);
		if (!body || !selection) {
			throw new Error('Escreva a tarefa e escolha o provedor e o modelo.');
		}
		if (!vscode.workspace.isTrusted) {
			throw new Error('Confie no workspace antes de iniciar o agente.');
		}
		let id = typeof message.sessionId === 'string' ? message.sessionId : undefined;
		const existing = id ? this._hub.getState().sessions.find(session => session.id === id) : undefined;
		if (id && !existing) {
			// a session was asked for and is not there: never create another one silently
			throw new Error('A sessão em uso não existe mais no Hub. Escolha "Nova sessão" e envie de novo.');
		}
		if (existing) {
			const current = existing.model ? { providerID: existing.model.providerID, modelID: existing.model.modelID, variant: existing.model.variant } : undefined;
			if (!same(current, selection)) {
				await this._hub.sessionRequest('session.setModel', { id, model: selection });
			}
		} else {
			let workspace = this._workspace();
			if (!workspace) {
				workspace = await this._pickWorkspace();
			}
			if (!workspace) {
				throw new Error('Escolha o workspace em que o agente poderá trabalhar.');
			}
			const created = await this._hub.sessionRequest('session.create', { workspace, model: selection });
			id = created.id;
		}
		await this._hub.sessionRequest('session.prompt', { id, text: body });
		this._view?.webview.postMessage({ type: 'sent', sessionId: id });
	}

	_post() {
		if (this._view) {
			this._view.webview.postMessage({ type: 'state', state: this._hub.getState() });
		}
	}

	_html(webview) {
		const media = name => webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', name));
		const nonce = Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
		// No remote content at all: only local script and style, and nothing else is allowed to load.
		const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};`;
		return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media('agents.css')}">
<title>Agentes</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${media('render.js')}"></script>
<script nonce="${nonce}" src="${media('main.js')}"></script>
</body>
</html>`;
	}
}

function activate(context) {
	const settings = () => vscode.workspace.getConfiguration('singularity.agents');
	const hub = new RealHubClient({ nodePath: settings().get('hub.nodePath', '') });
	// Showing the panel is what starts the Hub (when autoStart is on). Reconnecting after a drop never starts one by itself.
	const ensureHub = () => hub.start(settings().get('hub.autoStart', true));
	const provider = new AgentsViewProvider(context, hub, () => { void ensureHub(); });

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: false } }),
		vscode.commands.registerCommand('singularity.agents.open', () => vscode.commands.executeCommand(`workbench.view.extension.${CONTAINER_ID}`)),
		vscode.commands.registerCommand('singularity.hub.updateState', async () => {
			await hub.start(false);
			return hub.getState().hub.status;
		}),
		vscode.commands.registerCommand('singularity.hub.start', async () => { await hub.start(true); }),
		vscode.commands.registerCommand('singularity.hub.stop', async () => {
			try {
				await hub.stopHub();
			} catch {
				vscode.window.showWarningMessage('O Singularity Hub não está em execução.');
			}
		}),
		vscode.commands.registerCommand('singularity.agents.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:singularity.singularity-agents'))
	);

	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	// At startup only look for a Hub that is already running; nothing is started until the panel is opened.
	void hub.start(false);
	item.name = 'Singularity Agentes';
	item.command = 'singularity.agents.open';
	context.subscriptions.push(item);

	const refreshItem = () => {
		const { hub: hubState, sessions } = hub.getState();
		const connected = hubState.status === 'connected';
		item.text = connected ? `$(circle-filled) Agentes: ${sessions.length}` : '$(circle-large-outline) Agentes';
		item.tooltip = connected
			? `Singularity Hub conectado, ${sessions.length} sessões. Clique para abrir os agentes.`
			: 'Singularity Hub não conectado. Clique para abrir os agentes.';
		if (vscode.workspace.getConfiguration('singularity.agents').get('showStatusBarItem', true)) {
			item.show();
		} else {
			item.hide();
		}
	};
	refreshItem();
	context.subscriptions.push(
		{ dispose: () => hub.dispose() },
		{ dispose: hub.onDidChange(refreshItem) },
		vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('singularity.agents.showStatusBarItem')) { refreshItem(); } })
	);
}

function deactivate() { }

// The Hub is deliberately NOT stopped when the window closes: it is an independent process.

module.exports = { activate, deactivate };
