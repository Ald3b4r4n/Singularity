'use strict';

const vscode = require('vscode');
const { realpathSync } = require('node:fs');
const { RealHubClient } = require('./hubClient.js');
const { selectionOf, same, text } = require('./selection.js');

const VIEW_ID = 'singularity.agents.sessions';
const EDITOR_ID = 'singularity.agents.editor';
const FIRST_OPEN_KEY = 'singularity.agents.firstOpen';
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

	open(preserveFocus = false) {
		if (this._view) {
			this._view.reveal(undefined, preserveFocus);
			return;
		}
		this.attachEditor(vscode.window.createWebviewPanel(EDITOR_ID, 'Agentes', { viewColumn: vscode.ViewColumn.Active, preserveFocus }, {
			retainContextWhenHidden: true
		}));
	}

	resolveWebviewView(view) {
		this._sessions = view;
		view.webview.options = this._options();
		view.webview.html = this._html(view.webview, 'sessions.js');
		view.onDidDispose(() => { this._sessions = undefined; });
		view.webview.onDidReceiveMessage(async message => {
			if (message?.type === 'ready') {
				this._postSessions();
			} else if ((message?.type === 'use' || message?.type === 'continue') && !this._sending && this._visibleState().sessions.some(session => session.id === message.id)) {
				this._targetId = message.id;
				const wasOpen = !!this._view;
				this._focusComposerOnReady = !wasOpen && message.type === 'continue';
				this.open();
				if (wasOpen) {
					this._view.webview.postMessage({ type: 'use', id: message.id, focusComposer: message.type === 'continue' });
				}
				this._postSessions();
			} else if (message?.type === 'deleteHistory') {
				try {
					const workspace = this._workspace();
					if (!workspace || await vscode.window.showWarningMessage('Excluir o histórico desta sessão?', { modal: true }, 'Excluir') !== 'Excluir') { return; }
					await this._hub.sessionRequest('session.deleteHistory', { id: message.id, workspace });
				} catch (error) {
					vscode.window.showErrorMessage(error.message);
				}
			} else if (message?.type === 'stop') {
				try {
					await this._stop(message.id);
				} catch (error) {
					vscode.window.showErrorMessage(error.message);
				}
			}
		});
	}

	_options() {
		return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')] };
	}

	attachEditor(view, saved) {
		this._view = view;
		this._targetId ??= saved?.targetId;
		view.iconPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'agents.svg');
		view.webview.options = this._options();
		view.webview.html = this._html(view.webview, 'main.js');
		view.onDidDispose(() => { this._view = undefined; });
		view.onDidChangeViewState(() => { if (view.visible) { this._onVisible(); this._post(); } });
		this._onVisible();
		view.webview.onDidReceiveMessage(async message => {
			if (message?.type === 'ready') {
				this._postPrefs();
				this.setProfile(this._profile);
				this._post();
				if (this._targetId) {
					view.webview.postMessage({ type: 'use', id: this._targetId, focusComposer: this._focusComposerOnReady });
					this._focusComposerOnReady = false;
				}
			} else if (message?.type === 'target') {
				this._targetId = message.id;
				this._postSessions();
			} else if (message?.type === 'openSettings') {
				await vscode.commands.executeCommand('singularity.agents.openSettings');
			} else {
				try {
					await this._operate(message);
				} catch (error) {
					const reason = error instanceof Error ? error.message : 'A operação falhou.';
					view.webview.postMessage({ type: 'failed', message: reason });
				}
			}
		});
	}

	async _stop(id) {
		if (typeof id !== 'string') { return; }
		const choice = await vscode.window.showWarningMessage('Encerrar a sessão de agente?', { modal: true }, 'Encerrar');
		if (choice === 'Encerrar') {
			await this._hub.sessionRequest('session.stop', { id });
		}
	}

	// ---------- workspace and preferences ----------

	_folders() {
		return (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
	}

	_workspace() {
		const saved = this._context.workspaceState.get(WORKSPACE_KEY);
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
			await this._context.workspaceState.update(WORKSPACE_KEY, uri.fsPath);
			this._postPrefs();
			this._post();
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
		if (message?.type === 'history') {
			const workspace = this._workspace();
			if (workspace) {
				try {
					const turns = await this._hub.sessionRequest('session.history', { id: message.id, workspace });
					post({ type: 'history', id: message.id, key: message.key, turns });
				} catch {
					post({ type: 'history', id: message.id, key: message.key, turns: [] });
				}
			}
			return;
		}
		if (message?.type === 'catalog') {
			try {
				const catalog = await this._hub.catalog({ service: 'opencode', workspace: this._workspace(), refresh: message.refresh === true });
				this._catalog = catalog;
				this._postSessions();
				post({ type: 'catalog', catalog });
			} catch (error) {
				post({ type: 'catalog', error: error instanceof Error ? error.message : 'Não foi possível ler o catálogo.' });
			}
			return;
		}
		if (message?.type === 'send') {
			if (this._sending) { return; }
			this._sending = true;
			try { await this._send(message); } finally { this._sending = false; }
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
			this._view?.webview.postMessage({ type: 'interruptComplete' });
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
		const existing = id ? this._visibleState().sessions.find(session => session.id === id) : undefined;
		if (id && (!existing || existing.historical || existing.recovery)) {
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
		this._targetId = id;
		this._postSessions();
		if (!existing) { this._view?.webview.postMessage({ type: 'created', id }); }
		await this._hub.sessionRequest('session.prompt', { id, text: body });
		this._view?.webview.postMessage({ type: 'sent', sessionId: id });
	}

	setProfile(profile) {
		this._profile = profile;
		this._view?.webview.postMessage({ type: 'profile', profile });
	}

	_post() {
		this._postSessions();
		if (this._view) {
			this._view.webview.postMessage({ type: 'state', state: this._visibleState() });
		}
	}

	_visibleState() {
		const state = this._hub.getState();
		const workspace = this._workspace();
		if (workspace !== this._workspacePath) {
			this._workspacePath = workspace;
			try { this._canonicalWorkspace = workspace && realpathSync.native(workspace); }
			catch { this._canonicalWorkspace = undefined; }
		}
		const key = value => value?.replace(/\\/g, '/').toLowerCase();
		return { ...state, sessions: state.sessions.filter(session => !session.workspace || key(session.workspace) === key(this._canonicalWorkspace)) };
	}

	_postSessions() {
		const { hub, sessions } = this._visibleState();
		const entries = sessions.map(({ id, harness, status, workspace, model, recovery, historical, createdAt, updatedAt }) => ({
			id, harness, status, workspace, model, recovery, historical, createdAt, updatedAt
		}));
		this._sessions?.webview.postMessage({
			type: 'sessions', state: { hub, sessions: entries }, catalog: this._catalog, targetId: this._targetId, workspace: this._workspace()
		});
	}

	_html(webview, script) {
		const media = name => webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', name));
		const nonce = Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
		// No remote content at all: only local script and style, and nothing else is allowed to load.
		const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;`;
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
<script nonce="${nonce}" src="${media(script)}"></script>
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
	const account = vscode.extensions.getExtension('singularity.singularity-account');
	void account?.activate().then(api => {
		if (!api?.getPublicProfile || !api.onDidChangePublicProfile) { return; }
		context.subscriptions.push(api.onDidChangePublicProfile(profile => provider.setProfile(profile)));
		provider.setProfile(api.getPublicProfile());
	}, () => { /* The editor still works without a connected account. */ });


	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: false } }),
		vscode.window.registerWebviewPanelSerializer(EDITOR_ID, { deserializeWebviewPanel: async (view, saved) => provider.attachEditor(view, saved) }),
		{ dispose: hub.onDidChange(() => provider._post()) },
		vscode.commands.registerCommand('singularity.agents.open', () => provider.open()),
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

	// Open after the startup editors have been restored, preserving Welcome or the file already in focus.
	if (!context.globalState.get(FIRST_OPEN_KEY)) {
		void context.globalState.update(FIRST_OPEN_KEY, true).then(() => {
			const preserveFocus = !!vscode.window.tabGroups.activeTabGroup.activeTab;
			provider.open(preserveFocus);
			return vscode.commands.executeCommand(VIEW_ID + '.focus', { preserveFocus: true });
		});
	}

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
