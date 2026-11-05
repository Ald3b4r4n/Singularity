'use strict';

const vscode = require('vscode');
const { dirname } = require('node:path');

const labels = {
	'not-installed': 'Não instalado',
	'authentication-required': 'Autenticação necessária',
	ready: 'Disponível',
	unavailable: 'Indisponível',
	error: 'Erro de diagnóstico',
	planned: 'Em breve'
};

async function manageProviders(hub, workspace, useProvider) {
	for (;;) {
		const providers = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Verificando provedores' },
			() => hub.inspectProviders({ workspace, refresh: true }));
		const selected = await vscode.window.showQuickPick(providers.map(provider => ({
			label: provider.name,
			description: [labels[provider.status], provider.version].filter(Boolean).join(' · '),
			detail: [provider.reason, provider.executable, provider.executable ? 'Atualização e reparação gerenciadas indisponíveis nesta versão.' : undefined].filter(Boolean).join(' · '),
			provider
		})), { title: 'Gerenciar provedores', matchOnDetail: true });
		if (!selected || selected.provider.status === 'planned') { return; }
		const provider = selected.provider;
		const actions = [
			...(provider.install ? [{ label: 'Instalar', action: 'install' }] : []),
			...(provider.status === 'ready' ? [{ label: 'Utilizar', action: 'use' }] : []),
			...(provider.executable ? [{ label: 'Conectar conta', action: 'login' }] : []),
			{ label: 'Testar conexão', action: 'refresh' },
			{ label: 'Abrir instruções oficiais', action: 'docs' }
		];
		const choice = await vscode.window.showQuickPick(actions, { title: provider.name });
		if (!choice) { return; }
		if (choice.action === 'install') {
			const confirm = await vscode.window.showInformationMessage(
				`Instalar ${provider.name} ${provider.install.version}?`,
				{ modal: true, detail: `Origem oficial: ${provider.install.url}` }, 'Instalar');
			if (confirm !== 'Instalar') { return; }
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Instalando ' + provider.name },
				() => hub.installProvider({ id: provider.id, version: provider.install.version }));
			void vscode.window.showInformationMessage(provider.name + ' instalado.');
			continue;
		}
		if (choice.action === 'refresh') { continue; }
		if (choice.action === 'use') { await useProvider(provider.id); return; }
		if (choice.action === 'docs') { await vscode.env.openExternal(vscode.Uri.parse(provider.source)); return; }
		const shellArgs = provider.id === 'claude-code' ? ['auth', 'login'] : provider.id === 'codex-cli' ? ['login'] : ['auth', 'login', '--wizard'];
		const terminal = vscode.window.createTerminal({ name: provider.name + ' — Conectar conta', shellPath: provider.executable, shellArgs, cwd: dirname(provider.executable) });
		const closed = vscode.window.onDidCloseTerminal(async ended => {
			if (ended !== terminal) { return; }
			closed.dispose();
			const next = await vscode.window.showInformationMessage('Verifique se a conta foi conectada ao ' + provider.name + '.', 'Testar conexão');
			if (next === 'Testar conexão') { await vscode.commands.executeCommand('singularity.agents.manageProviders'); }
		});
		terminal.show();
		return;
	}
}

module.exports = { manageProviders };
