'use strict';

const vscode = require('vscode');
const { DisconnectedHubClient } = require('./hub.js');

const VIEW_ID = 'singularity.agents.sessions';
const CONTAINER_ID = 'singularityAgents';

class AgentsViewProvider {
	/**
	 * @param {vscode.Uri} extensionUri
	 * @param {{ getState(): object, onDidChange(l: () => void): () => void }} hub
	 */
	constructor(extensionUri, hub) {
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
		view.webview.onDidReceiveMessage(message => {
			if (message && message.type === 'ready') {
				this._post();
			} else if (message && message.type === 'openSettings') {
				vscode.commands.executeCommand('singularity.agents.openSettings');
			}
		});
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
	const hub = new DisconnectedHubClient();
	const provider = new AgentsViewProvider(context.extensionUri, hub);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: false } }),
		vscode.commands.registerCommand('singularity.agents.open', () => vscode.commands.executeCommand(`workbench.view.extension.${CONTAINER_ID}`)),
		vscode.commands.registerCommand('singularity.agents.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:singularity.singularity-agents'))
	);

	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	item.name = 'Singularity Agents';
	item.command = 'singularity.agents.open';
	context.subscriptions.push(item);

	const refreshItem = () => {
		const { hub: hubState, sessions } = hub.getState();
		item.text = sessions.length ? `$(circle-filled) Agentes: ${sessions.length}` : '$(circle-large-outline) Agentes';
		item.tooltip = hubState.status === 'connected'
			? 'Singularity Agents: abrir painel'
			: 'Singularity Hub não conectado. Clique para abrir o painel de agentes.';
		if (vscode.workspace.getConfiguration('singularity.agents').get('showStatusBarItem', true)) {
			item.show();
		} else {
			item.hide();
		}
	};
	refreshItem();
	context.subscriptions.push(
		{ dispose: hub.onDidChange(refreshItem) },
		vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('singularity.agents.showStatusBarItem')) { refreshItem(); } })
	);
}

function deactivate() { }

module.exports = { activate, deactivate };
