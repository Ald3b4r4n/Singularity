'use strict';

const vscode = require('vscode');
const { RealHubClient } = require('./hubClient.js');

const VIEW_ID = 'singularity.agents.sessions';
const CONTAINER_ID = 'singularityAgents';

class AgentsViewProvider {
	/**
	 * @param {vscode.Uri} extensionUri
	 * @param {{ getState(): object, onDidChange(l: () => void): () => void }} hub
	 * @param {() => void} onVisible called when the panel is shown
	 */
	constructor(extensionUri, hub, onVisible) {
		this._onVisible = onVisible;
		this._extensionUri = extensionUri;
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
			} else if (message && message.type === 'openSettings') {
				await vscode.commands.executeCommand('singularity.agents.openSettings');
			} else {
				try {
					await this._operate(message);
				} catch (error) {
					await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'OpenCode operation failed.');
				}
			}
		});
	}

	async _operate(message) {
		if (message?.type === 'reconnect') {
			await this._hub.start(true);
			return;
		}
		if (message?.type === 'create') {
			if (!vscode.workspace.isTrusted) {
				throw new Error('Confie no workspace antes de iniciar o OpenCode.');
			}
			const folders = (vscode.workspace.workspaceFolders ?? [])
				.filter(folder => folder.uri.scheme === 'file')
				.map(folder => ({ label: folder.name, description: folder.uri.fsPath, uri: folder.uri }));
			const picked = await vscode.window.showQuickPick([...folders, { label: 'Escolher outra pasta...' }], {
				title: 'Workspace da sessão OpenCode', placeHolder: 'Selecione a pasta em que o OpenCode poderá trabalhar'
			});
			if (!picked) {
				return;
			}
			const uri = picked.uri ?? (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: 'Usar como workspace' }))?.[0];
			if (uri?.scheme === 'file') {
				await this._hub.sessionRequest('session.create', { workspace: uri.fsPath });
			}
			return;
		}
		if (typeof message?.id !== 'string') {
			return;
		}
		if (message.type === 'prompt' && typeof message.text === 'string') {
			await this._hub.sessionRequest('session.prompt', { id: message.id, text: message.text });
		} else if (message.type === 'interrupt') {
			const result = await this._hub.sessionRequest('session.interrupt', { id: message.id });
			if (!result.interrupted) {
				await vscode.window.showInformationMessage('O OpenCode não encontrou uma execução ativa para cancelar.');
			}
		} else if (message.type === 'stop') {
			await this._hub.sessionRequest('session.stop', { id: message.id });
		}
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
<title>Singularity Agents</title>
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
	const provider = new AgentsViewProvider(context.extensionUri, hub, () => { void ensureHub(); });

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
	item.name = 'Singularity Agents';
	item.command = 'singularity.agents.open';
	context.subscriptions.push(item);

	const refreshItem = () => {
		const { hub: hubState, sessions } = hub.getState();
		const connected = hubState.status === 'connected';
		item.text = connected ? `$(circle-filled) Agentes: ${sessions.length}` : '$(circle-large-outline) Agentes';
		item.tooltip = connected
			? `Singularity Hub conectado, ${sessions.length} sessões. Clique para abrir o painel.`
			: 'Singularity Hub não conectado. Clique para abrir o painel de agentes.';
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
