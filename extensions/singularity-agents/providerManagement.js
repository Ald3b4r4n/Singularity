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

async function manageProvidersLegacy(hub, workspace, useProvider) {
	for (;;) {
		const providers = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Verificando provedores' },
			() => hub.inspectProviders({ workspace, refresh: true }));
		const selected = await vscode.window.showQuickPick(providers.map(provider => ({
			label: provider.name,
			description: [labels[provider.status], provider.version].filter(Boolean).join(' · '),
			detail: [provider.authenticated ? 'Conta conectada' : undefined, provider.reason, provider.executable, provider.latest ? 'Versão oficial disponível: ' + provider.latest : undefined, provider.verifiedVersion ? 'Versão aprovada para instalação: ' + provider.verifiedVersion : undefined, provider.latest && provider.verifiedVersion && provider.latest !== provider.verifiedVersion ? 'A versão mais recente ainda não foi verificada pelo Singularity.' : undefined, provider.executable && !provider.maintenance ? 'Instalação externa: manutenção pelo fornecedor.' : undefined].filter(Boolean).join(' · '),
			provider
		})), { title: 'Gerenciar provedores', matchOnDetail: true });
		if (!selected || selected.provider.status === 'planned') { return; }
		const provider = selected.provider;
		const actions = [
			...(provider.install ? [{ label: 'Instalar', action: 'install' }] : []),
			...(provider.maintenance ? [{ label: provider.maintenance.operation === 'repair' ? 'Reparar' : 'Atualizar', action: 'maintenance' }] : []),
			...(provider.status === 'ready' ? [{ label: 'Utilizar', action: 'use' }] : []),
			...(provider.executable ? [{ label: 'Conectar conta', action: 'login' }] : []),
			{ label: 'Testar conexão', action: 'refresh' },
			{ label: 'Abrir instruções oficiais', action: 'docs' }
		];
		const choice = await vscode.window.showQuickPick(actions, { title: provider.name });
		if (!choice) { return; }
		if (choice.action === 'install' || choice.action === 'maintenance') {
			const offer = provider.install || provider.maintenance;
			const verb = choice.label;
			const confirm = await vscode.window.showInformationMessage(
				`${verb} ${provider.name} ${offer.version}?`,
				{ modal: true, detail: `Origem oficial: ${offer.url}` }, verb);
			if (confirm !== verb) { return; }
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: (choice.action === 'install' ? 'Instalando ' : verb + ' ') + provider.name, cancellable: true },
				async (_progress, token) => {
					const pending = hub.installProvider({ id: provider.id, version: offer.version, operation: offer.operation });
					const listener = token.onCancellationRequested(() => { void hub.cancelProviderInstall(provider.id).catch(() => undefined); });
					try { await pending; } finally { listener.dispose(); }
				});
			void vscode.window.showInformationMessage(provider.name + ' pronto.');
			continue;
		}
		if (choice.action === 'refresh') { continue; }
		if (choice.action === 'use') { await useProvider(provider.id); return; }
		if (choice.action === 'docs') { await vscode.env.openExternal(vscode.Uri.parse(provider.source)); return; }
		let device = false;
		if (provider.id === 'codex-cli') {
			const method = await vscode.window.showQuickPick([
				{ label: 'Entrar pelo navegador', device: false },
				{ label: 'Usar código de dispositivo', device: true }
			], { title: 'Conectar conta ao Codex CLI' });
			if (!method) { return; }
			device = method.device;
		}
		const shellArgs = provider.id === 'claude-code' ? ['auth', 'login'] :
			provider.id === 'codex-cli' ? ['login', ...(device ? ['--device-auth'] : [])] : ['auth', 'login', '--wizard'];
		const instructions = device
			? 'Abra o endereço oficial exibido pelo Codex no terminal e informe o código mostrado ali.'
			: provider.id === 'opencode'
				? 'Escolha a integração no assistente do OpenCode e siga as instruções que ele exibir.'
				: 'Conclua o login na janela oficial aberta pelo provedor.';
		const terminal = vscode.window.createTerminal({
			name: provider.name + ' — Conectar conta', shellPath: provider.executable, shellArgs, cwd: dirname(provider.executable)
		});
		const closed = vscode.window.onDidCloseTerminal(async ended => {
			if (ended !== terminal) { return; }
			closed.dispose();
			try {
				const refreshed = await vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification, title: 'Confirmando conexão com ' + provider.name
				}, () => hub.inspectProviders({ workspace, refresh: true }));
				const result = refreshed.find(item => item.id === provider.id);
				if (result?.status === 'ready') {
					const use = await vscode.window.showInformationMessage(provider.name + ' disponível. O catálogo foi verificado.', 'Utilizar');
					if (use === 'Utilizar') { await useProvider(provider.id); }
				} else {
					void vscode.window.showWarningMessage(result?.reason || 'A conexão ainda não foi confirmada.');
				}
			} catch {
				void vscode.window.showWarningMessage('Não foi possível verificar o login. Tente Testar conexão em Gerenciar provedores.');
			}
		});
		terminal.show();
		void vscode.window.showInformationMessage(instructions);
		return;
	}
}

function manageProviders(hub, workspace, useProvider, changed) {
	return require('./providerDiagnostics').openProviderDiagnostics(hub, workspace, useProvider, () => manageProvidersLegacy(hub, workspace, useProvider), changed);
}
module.exports = { manageProviders, manageProvidersLegacy };
