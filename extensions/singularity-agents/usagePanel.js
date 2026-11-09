'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

/** Plan windows and token spend of every service, read locally by the Hub (nothing is queried online and no cost is estimated). */
function openUsage(hub) {
	const media = vscode.Uri.file(path.join(__dirname, 'media'));
	const panel = vscode.window.createWebviewPanel('singularity.usage', 'Uso dos serviços', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media] });
	const nonce = randomBytes(18).toString('base64');
	const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'usage.js'));
	panel.webview.html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:1100px;margin:auto}h1{font-size:24px;margin:0 0 4px}.sub{color:var(--vscode-descriptionForeground);margin:0 0 18px}
#services{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}.card{border:1px solid var(--vscode-widget-border,#444);border-radius:10px;padding:14px;display:grid;gap:8px;align-content:start}
.card h2{font-size:16px;margin:0}.row{display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:2px 0;border-bottom:1px dashed var(--vscode-widget-border,#444)}.row:last-child{border:0}.row .l{color:var(--vscode-descriptionForeground);flex:none}.row .v{text-align:right;overflow-wrap:anywhere}
.meter{display:grid;gap:3px;font-size:13px}.track{height:10px;border-radius:99px;border:1px solid var(--vscode-widget-border,#444);overflow:hidden}.fill{height:100%;background:var(--vscode-charts-green,#3fb950)}.warn .fill{background:var(--vscode-charts-yellow,#d29922)}.bad .fill{background:var(--vscode-charts-red,#f85149)}
.muted{color:var(--vscode-descriptionForeground);font-size:12px;margin:0}button{font:inherit;color:var(--vscode-foreground);background:transparent;border:1px solid var(--vscode-button-border,#666);border-radius:5px;padding:5px 12px;cursor:pointer;margin-top:16px}
</style></head><body><h1>Uso dos serviços</h1><p class="sub">Lido neste computador, sem consultar nenhum serviço e sem estimar valores. Tokens de entrada e saída; o cache fica à parte.</p><p id="notice" class="muted" role="status"></p><section id="services" aria-label="Uso por serviço"></section><button id="refresh" type="button">Atualizar</button> <button id="claude-plan" type="button">Mostrar limites do plano Claude</button><script nonce="${nonce}" src="${script}"></script></body></html>`;
	let disposed = false;
	const post = data => { if (!disposed) { void panel.webview.postMessage(data); } };
	async function load() {
		post({ type: 'loading' });
		try { await hub.start(true); post({ type: 'usage', usage: await hub.sessionRequest('usage.get', { fresh: true }) }); } catch (error) { post({ type: 'error', message: String((error && error.message) || error) }); }
	}
	const listener = panel.webview.onDidReceiveMessage(async message => {
		if (!message) { return; }
		if (message.action === 'ready' || message.action === 'refresh') { void load(); }
		if (message.action === 'enableClaudePlan' || message.action === 'disableClaudePlan') {
			if (message.action === 'enableClaudePlan') {
				const choice = await vscode.window.showWarningMessage('Mostrar os limites do plano do Claude?', { modal: true, detail: 'O Singularity vai ler o login do Claude Code que já está neste computador e consultar a API de uso da Anthropic, só da sua conta, para mostrar a janela de 5 horas e a semanal. O login não é copiado, guardado nem exibido, e nada disso vai para o código nem para outras pessoas. Você pode desligar quando quiser.' }, 'Ativar');
				if (choice !== 'Ativar') { return; }
			}
			try { await hub.sessionRequest('usage.configure', { claudePlan: message.action === 'enableClaudePlan' }); } catch (error) { void vscode.window.showErrorMessage(String((error && error.message) || error)); }
			void load();
		}
	});
	panel.onDidDispose(() => { disposed = true; listener.dispose(); });
}
module.exports = { openUsage };
