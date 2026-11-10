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

		vscode.commands.registerCommand('singularity.remote.profiles', wrap(async () => {
			if (!(await requireRunning())) { return; }
			const current = await state();
			const { profiles } = await control().adminRequest('GET', '/admin/profiles');
			const entries = [{ label: '$(add) Cadastrar perfil de teste', add: true }, ...profiles.map(profile => {
				const workspace = current.workspaces.find(item => item.id === profile.workspaceId);
				return { label: '$(trash) Remover ' + profile.label, description: workspace ? workspace.name : '', detail: `${profile.executable} ${profile.args.join(' ')}`.trim(), remove: profile.id };
			})];
			const picked = await vscode.window.showQuickPick(entries, { title: 'Perfis de teste que o celular pode usar', placeHolder: 'O celular só escolhe um perfil já cadastrado aqui; nunca informa um comando' });
			if (!picked) { return; }
			if (picked.remove) { await control().adminRequest('POST', '/admin/profiles/remove', { id: picked.remove }); vscode.window.showInformationMessage('Perfil removido.'); return; }
			if (!current.workspaces.length) { vscode.window.showInformationMessage('Autorize um workspace antes de cadastrar um perfil de teste.'); return; }
			const workspace = await vscode.window.showQuickPick(current.workspaces.map(item => ({ label: item.name, description: item.path, id: item.id })), { title: 'Para qual workspace?' });
			if (!workspace) { return; }
			const label = await vscode.window.showInputBox({ title: 'Nome do perfil de teste', placeHolder: 'Testes do projeto', validateInput: value => value.trim() && value.length <= 60 ? undefined : 'Informe um nome de até 60 caracteres.' });
			if (!label) { return; }
			const file = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Usar este executável', title: 'Executável dos testes (por exemplo npm.cmd, pytest.exe ou um .cmd do projeto)' });
			if (!file || !file[0]) { return; }
			const argsText = await vscode.window.showInputBox({ title: 'Argumentos (separados por espaço; vazio para nenhum)', placeHolder: 'test --silent' });
			if (argsText === undefined) { return; }
			const args = argsText.trim() ? argsText.trim().split(/\s+/) : [];
			const choice = await modal('Cadastrar este perfil de teste para o celular?', `Workspace: ${workspace.label}\nExecutável: ${file[0].fsPath}\nArgumentos: ${args.join(' ') || '(nenhum)'}\n\nO celular poderá pedir para rodar exatamente este comando como validação independente de uma equipe, depois de cada confirmação dele. Ele nunca verá nem poderá alterar o comando.`, 'Cadastrar');
			if (choice !== 'Cadastrar') { return; }
			await control().adminRequest('POST', '/admin/profiles/add', { workspaceId: workspace.id, label: label.trim(), executable: file[0].fsPath, args, confirm: true });
			vscode.window.showInformationMessage('Perfil cadastrado.');
		})),
		vscode.commands.registerCommand('singularity.remote.requests', wrap(async () => {
			if (!(await requireRunning())) { return; }
			const info = await control().adminRequest('GET', '/admin/requests');
			const c = info.counts;
			const summary = `Confirmados: ${c.confirmed + c.reconciled} · Falharam antes do envio: ${c['failed-before-send']} · Em processamento: ${c.processing + c.received} · Estado desconhecido: ${c.unknown}`;
			if (c.blocked) {
				const choice = await modal('O registro de envios remotos está bloqueado', 'O arquivo do registro está ilegível ou corrompido. Por segurança, nenhum envio do celular é feito até ele ser reiniciado. O arquivo antigo é guardado ao lado, nunca apagado. Tarefas enviadas pouco antes podem ter chegado ao agente: confira as sessões antes de reenviar.', 'Reiniciar o registro');
				if (choice === 'Reiniciar o registro') { await control().adminRequest('POST', '/admin/requests/reset', { confirm: true }); vscode.window.showInformationMessage('Registro reiniciado. O envio pelo celular voltou a funcionar.'); }
				return;
			}
			vscode.window.showInformationMessage(info.unresolved.length ? `${summary}. Há ${info.unresolved.length} envio(s) sem confirmação: o celular mostra as opções de verificar, reenviar ou descartar.` : `${summary}. Nenhum envio pendente de decisão.`);
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
			await offerPublication(tailscale, true);
		}))
	);

	/** What is published right now, in words, and the one action that makes sense for it. Nothing changes without an explicit answer. */
	async function offerPublication(tailscale, asked) {
		const serve = tailscale.serve || {};
		const address = 'https://' + tailscale.dnsName + '/';
		const facts = `Tailscale conectado como ${tailscale.dnsName}. Gateway em 127.0.0.1:${tailscale.gatewayPort}.`;
		const safety = 'É usado apenas "tailscale serve" (somente os seus dispositivos Tailscale). O Funnel nunca é usado: nada fica acessível pela internet pública.';
		if (!serve.known) { if (asked) { vscode.window.showWarningMessage('Não foi possível ler a publicação do Tailscale Serve. Nada foi alterado.'); } return; }
		if (serve.funnel) { vscode.window.showWarningMessage('O Tailscale Funnel está ligado neste computador (exposição pública). O Singularity não o usa nem o altera: revise com "tailscale funnel status".'); }
		if (serve.pointsHere) {
			if (!asked) { return; }
			const choice = await modal('A rede privada está publicada', `${facts}\n\nEndereço: ${address}\nPublicação: somente na sua rede Tailscale (tailnet only).\n\n${safety}`, 'Copiar endereço', 'Desligar publicação');
			if (choice === 'Copiar endereço') { vscode.env.clipboard.writeText(address); }
			if (choice === 'Desligar publicação') { const off = await control().adminRequest('POST', '/admin/tailscale/off', {}); vscode.window.showInformationMessage(off.skipped ? 'A publicação não era deste gateway; nada foi alterado.' : 'Publicação na rede privada desligada.'); }
			return;
		}
		if (serve.conflict) {
			if (!asked) { return; }
			const choice = await modal('Já existe outra publicação do Tailscale Serve', `${facts}\n\nO Tailscale Serve deste computador está publicando outro serviço, que não é este gateway. Publicar o Singularity Remote substitui essa publicação.`, 'Substituir pela do Singularity');
			if (choice !== 'Substituir pela do Singularity') { return; }
			return publish(address, true);
		}
		const why = serve.stale ? 'A publicação existente aponta para uma porta antiga do gateway, então o celular não o alcança.' : serve.previouslyPublished ? 'A publicação privada que existia não está mais configurada no Tailscale, então o celular não alcança o computador fora de casa.' : 'O gateway ainda não está publicado na sua rede privada.';
		const action = serve.stale || serve.previouslyPublished ? 'Reativar publicação privada' : 'Publicar na rede privada';
		const choice = asked
			? await modal(serve.previouslyPublished || serve.stale ? 'Reativar a publicação privada do acesso remoto?' : 'Publicar o gateway na sua rede privada Tailscale?', `${facts}\n\n${why}\n\nSerá executado "tailscale serve --bg --https=443 http://127.0.0.1:${tailscale.gatewayPort}" (a porta atual do gateway). ${safety}`, action)
			: await vscode.window.showWarningMessage('Singularity Remote: ' + why, action, 'Agora não');
		if (choice !== action) { return; }
		if (!asked) {
			const confirmed = await modal('Reativar a publicação privada do acesso remoto?', `${facts}\n\nSerá executado "tailscale serve --bg --https=443 http://127.0.0.1:${tailscale.gatewayPort}" (a porta atual do gateway). ${safety}`, action);
			if (confirmed !== action) { return; }
		}
		return publish(address, false);
	}
	async function publish(address, replace) {
		const result = await control().adminRequest('POST', '/admin/tailscale/serve', { consent: true, replace });
		if (!result.ok) { vscode.window.showWarningMessage(result.reason || 'O Tailscale recusou o comando.'); return; }
		const note = result.tailnetOnly === false ? ' Atenção: o Funnel está ligado neste computador; revise com "tailscale funnel status".' : ' Somente na sua rede Tailscale.';
		vscode.window.showInformationMessage('Disponível na rede privada: ' + result.url + '.' + note, 'Copiar endereço').then(c => { if (c) { vscode.env.clipboard.writeText(result.url); } });
	}

	// When remote access is on and its private publication is gone or stale, say so once and offer to restore it. Never done silently.
	const timer = setTimeout(async () => {
		try {
			if (!control().gatewayRunning()) { return; }
			const tailscale = await control().adminRequest('GET', '/admin/tailscale');
			if (!tailscale.installed || !tailscale.loggedIn || !tailscale.serve) { return; }
			if (!tailscale.serve.pointsHere && !tailscale.serve.conflict && (tailscale.serve.stale || tailscale.serve.previouslyPublished)) { await offerPublication(tailscale, false); }
		} catch { /* the offer is a convenience: a failure to read never blocks the IDE */ }
	}, 8000);
	context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}

module.exports = { register };
