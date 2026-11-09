'use strict';

// Singularity Remote, IDE side: commands that turn the phone gateway on and off, authorize workspaces, pair and revoke devices and
// (optionally) publish the gateway to the user's own Tailscale network. Nothing here runs by itself: every step is a command the
// user invokes, the gateway is never started at login, and nothing is published without an explicit confirmation.

const path = require('path');
const vscode = require('vscode');

// Development layout: <repo>/extensions/singularity-agents and <repo>/singularity-hub (built).
const HUB_PACKAGE = path.join(__dirname, '..', '..', 'singularity-hub', 'dist');

function control() {
	return require(path.join(HUB_PACKAGE, 'remote', 'control.js'));
}

function nodePath(settings) {
	const { findNode } = require(path.join(HUB_PACKAGE, 'launch.js'));
	const found = findNode({ ...process.env, ...(settings ? { SINGULARITY_NODE_PATH: settings } : {}) });
	if (!found) { throw new Error('Node.js não encontrado. Configure singularity.agents.hub.nodePath.'); }
	return found;
}

const modal = (message, detail, ...items) => vscode.window.showWarningMessage(message, { modal: true, detail }, ...items);

async function state() {
	return control().adminRequest('GET', '/admin/state');
}

function register(context) {
	const configuredNode = () => vscode.workspace.getConfiguration('singularity.agents').get('hub.nodePath', '');
	const requireRunning = async () => {
		if (!control().gatewayRunning()) {
			vscode.window.showInformationMessage('O acesso remoto está desligado. Use "Singularity: Ativar acesso remoto" primeiro.');
			return false;
		}
		return true;
	};
	const wrap = fn => async () => {
		try { await fn(); } catch (error) { vscode.window.showErrorMessage(error instanceof Error ? error.message : 'A operação falhou.'); }
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('singularity.remote.enable', wrap(async () => {
			if (control().gatewayRunning()) {
				vscode.window.showInformationMessage('O acesso remoto já está ativo.');
				return;
			}
			const choice = await modal('Ativar o Singularity Remote?',
				'Isto inicia um gateway local, só neste computador (127.0.0.1). Nada é publicado na internet, nenhuma porta do roteador é aberta e o Windows não é configurado para iniciá-lo sozinho. O celular só alcança o gateway se você ativar uma rede privada (Tailscale) e parear o aparelho.',
				'Ativar');
			if (choice !== 'Ativar') { return; }
			await control().startGateway(nodePath(configuredNode()));
			const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
			vscode.window.showInformationMessage('Acesso remoto ativo (somente neste computador). Autorize workspaces e pareie um dispositivo.' + (folders.length ? '' : ' Abra uma pasta para autorizá-la.'));
		})),

		vscode.commands.registerCommand('singularity.remote.disable', wrap(async () => {
			if (!(await requireRunning())) { return; }
			const choice = await modal('Desativar o Singularity Remote?', 'Os dispositivos pareados permanecem, mas deixam de alcançar o computador até você ativar de novo. Se a rede privada estava publicada, ela é desligada.', 'Desativar');
			if (choice !== 'Desativar') { return; }
			await control().adminRequest('POST', '/admin/tailscale/off', {}).catch(() => undefined);
			await control().stopGateway();
			vscode.window.showInformationMessage('Acesso remoto desativado.');
		})),

		vscode.commands.registerCommand('singularity.remote.authorizeWorkspace', wrap(async () => {
			if (!(await requireRunning())) { return; }
			const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
			const current = await state();
			const entries = [
				...folders.map(folder => ({ label: '$(add) ' + folder.name, description: folder.uri.fsPath, add: folder.uri.fsPath })),
				...current.workspaces.map(workspace => ({ label: '$(trash) Remover ' + workspace.name, description: workspace.path, remove: workspace.id }))
			];
			if (!entries.length) { vscode.window.showInformationMessage('Abra uma pasta para autorizá-la ao acesso remoto.'); return; }
			const picked = await vscode.window.showQuickPick(entries, { title: 'Workspaces que o celular pode usar', placeHolder: 'O celular só vê e usa os workspaces autorizados' });
			if (!picked) { return; }
			if (picked.add) {
				const sure = await modal('Autorizar este workspace no celular?', picked.add + '\n\nO celular poderá iniciar tarefas de agentes nele. Os agentes continuam com as permissões que você escolher (somente leitura por padrão).', 'Autorizar');
				if (sure !== 'Autorizar') { return; }
				await control().adminRequest('POST', '/admin/workspaces/add', { path: picked.add });
			} else {
				await control().adminRequest('POST', '/admin/workspaces/remove', { id: picked.remove });
			}
		})),

		vscode.commands.registerCommand('singularity.remote.pair', wrap(async () => {
			if (!(await requireRunning())) { return; }
			const started = await control().adminRequest('POST', '/admin/pairing/start', {});
			const info = await state();
			const url = info.tailnetNames && info.tailnetNames[0] ? `https://${info.tailnetNames[0]}/` : `http://127.0.0.1:${info.publicPort}/ (somente neste computador; ative a rede privada para o celular)`;
			const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Singularity Remote — código ${started.code} (2 min). No celular: ${url}`, cancellable: true }, async (_progress, token) => {
				while (!token.isCancellationRequested && Date.now() < started.expiresAt + 3 * 60 * 1000) {
					await new Promise(resolve => setTimeout(resolve, 1500));
					const now = await state();
					const claim = now.pending[0];
					if (claim) {
						const choice = await modal(`Autorizar "${claim.deviceName}"?`, `Confira no celular: o código de verificação deve ser ${claim.fingerprint}. Só autorize se for o seu aparelho.`, 'Autorizar', 'Recusar');
						await control().adminRequest('POST', '/admin/pairing/decide', { id: claim.id, approve: choice === 'Autorizar' });
						return choice === 'Autorizar' ? 'approved' : 'denied';
					}
					if (!now.pairing) { return 'expired'; }
				}
				await control().adminRequest('POST', '/admin/pairing/cancel', {}).catch(() => undefined);
				return 'cancelled';
			});
			const message = { approved: 'Dispositivo autorizado.', denied: 'Pareamento recusado.', expired: 'O código expirou.', cancelled: 'Pareamento cancelado.' }[outcome];
			vscode.window.showInformationMessage(message);
		})),

		vscode.commands.registerCommand('singularity.remote.devices', wrap(async () => {
			if (!(await requireRunning())) { return; }
			const info = await state();
			const active = info.devices.filter(device => !device.revokedAt);
			if (!active.length) { vscode.window.showInformationMessage('Nenhum dispositivo pareado.'); return; }
			const picked = await vscode.window.showQuickPick(active.map(device => ({ label: device.name, description: 'Pareado em ' + new Date(device.createdAt).toLocaleString() + (device.lastSeen ? ' · visto em ' + new Date(device.lastSeen).toLocaleString() : ''), id: device.id })), { title: 'Dispositivos pareados', placeHolder: 'Escolha um dispositivo para revogar' });
			if (!picked) { return; }
			if (await modal(`Revogar "${picked.label}"?`, 'O aparelho perde o acesso imediatamente e precisará ser pareado de novo.', 'Revogar') === 'Revogar') {
				await control().adminRequest('POST', '/admin/devices/revoke', { id: picked.id });
				vscode.window.showInformationMessage('Dispositivo revogado.');
			}
		})),

		vscode.commands.registerCommand('singularity.remote.tailscale', wrap(async () => {
			if (!(await requireRunning())) { return; }
			const tailscale = await control().adminRequest('GET', '/admin/tailscale');
			if (!tailscale.installed || !tailscale.loggedIn) {
				vscode.window.showInformationMessage(tailscale.reason || 'Tailscale indisponível.', 'Abrir tailscale.com/download').then(choice => { if (choice) { vscode.env.openExternal(vscode.Uri.parse('https://tailscale.com/download')); } });
				return;
			}
			const choice = await modal('Publicar o gateway na sua rede privada Tailscale?',
				`Será executado "tailscale serve" para ${tailscale.dnsName}: o gateway fica disponível por HTTPS somente para os seus dispositivos Tailscale. Não é usado o Funnel: nada fica acessível pela internet pública. O Tailscale usa a infraestrutura de coordenação dele.`, 'Publicar na rede privada', 'Desligar publicação');
			if (choice === 'Publicar na rede privada') {
				const result = await control().adminRequest('POST', '/admin/tailscale/serve', { consent: true });
				if (result.ok) { vscode.window.showInformationMessage('Disponível na rede privada: ' + result.url, 'Copiar endereço').then(c => { if (c) { vscode.env.clipboard.writeText(result.url); } }); } else { vscode.window.showWarningMessage(result.reason || 'O Tailscale recusou o comando.'); }
			} else if (choice === 'Desligar publicação') {
				await control().adminRequest('POST', '/admin/tailscale/off', {});
				vscode.window.showInformationMessage('Publicação na rede privada desligada.');
			}
		}))
	);
}

module.exports = { register };
