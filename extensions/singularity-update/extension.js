'use strict';
// Singularity updates in the IDE: check, download with progress, and reveal the verified installer.
// The release installer is offered only after integrity and provenance verification.

const vscode = require('vscode');
const fs = require('fs'), os = require('os'), path = require('path');
const update = require('./update.js');

const product = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8'));
const INSTALLED = product.singularityVersion;
const EXPECTED_VERSION_KEY = 'singularity.update.expectedVersion';
const LAST_CHECK_KEY = 'singularity.update.lastCheck';
const DAY = 24 * 60 * 60 * 1000;

function settings() {
	const c = vscode.workspace.getConfiguration('singularity.update');
	const configured = c.inspect('channel');
	const channel = configured?.workspaceFolderValue ?? configured?.workspaceValue ?? configured?.globalValue
		?? (INSTALLED?.includes('-preview.') ? 'preview' : 'stable');
	return { channel, automatic: c.get('checkAutomatically', true) };
}

async function check(context, output, { explicit }) {
	const { channel } = settings();
	let releases, selection;
	try {
		releases = await update.listReleases();
		selection = update.selectUpdate(releases, { installed: INSTALLED, channel, platform: process.platform, arch: process.arch, target: product.target });
	} catch (e) {
		output.appendLine(`check failed: ${e.code || 'error'}`);
		if (explicit) { vscode.window.showWarningMessage(vscode.l10n.t('Não foi possível verificar atualizações agora. Verifique a conexão e tente de novo.')); }
		return undefined;
	}
	await context.globalState.update(LAST_CHECK_KEY, Date.now());
	const { update: found, skipped } = selection;
	output.appendLine(`checked ${releases.length} release(s) on ${channel}; skipped: ${JSON.stringify(skipped)}`);
	if (!found) {
		if (explicit) {
			vscode.window.showInformationMessage(releases.length
				? vscode.l10n.t('Nenhuma atualização compatível para Singularity {0} no canal {1}.', INSTALLED, channel)
				: vscode.l10n.t('O repositório oficial ainda não tem releases disponíveis.'));
		}
		return undefined;
	}
	return found;
}

async function download(output, found) {
	const dir = path.join(os.tmpdir(), 'singularity-update');
	fs.mkdirSync(dir, { recursive: true });
	return vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: vscode.l10n.t('Baixando Singularity {0}', found.version),
		cancellable: true
	}, async (progress, token) => {
		const controller = new AbortController();
		const subscription = token.onCancellationRequested(() => controller.abort());
		if (token.isCancellationRequested) {
			controller.abort();
		}
		try {
			let last = 0;
			const result = await update.downloadVerified({
				update: found, dir, signal: controller.signal,
				onProgress: ({ received, total }) => {
					const pct = Math.floor((received / total) * 100);
					if (pct > last) {
						progress.report({ increment: pct - last, message: `${pct}%` });
						last = pct;
					}
				},
				onVerifying: () => progress.report({ message: vscode.l10n.t('Verificando procedência') }),
			});
			output.appendLine(`verified ${found.version} (${result.bytes} bytes, SHA-256 ${result.sha256})`);
			return result;
		} catch (error) {
			if (!controller.signal.aborted) {
				output.appendLine(`download failed: ${error.code || 'error'}`);
				const messages = {
					provenance: vscode.l10n.t('Não foi possível confirmar a procedência da atualização no GitHub.'),
					'checksum-mismatch': vscode.l10n.t('O hash do download diverge do manifesto verificado. Tente baixar a atualização novamente.'),
					incomplete: vscode.l10n.t('O tamanho do download diverge do manifesto. Tente baixar a atualização novamente.')
				};
				const message = messages[error.code] ?? vscode.l10n.t('Não foi possível baixar e verificar a atualização. Consulte Singularity Update para detalhes.');
				await vscode.window.showErrorMessage(message);
			}
		} finally {
			subscription.dispose();
		}
	});
}

async function install(context, output, found, result) {
	let hub;
	try {
		hub = await vscode.commands.executeCommand('singularity.hub.updateState');
	} catch (error) {
		output.appendLine(`Hub preflight unavailable: ${error.message}`);
	}
	if (hub !== 'disconnected') {
		await vscode.window.showWarningMessage(vscode.l10n.t('Encerre o Hub e aguarde o fim das sessões antes de instalar a atualização.'));
		return;
	}
	if (vscode.workspace.textDocuments.some(document => document.isDirty)
		|| vscode.workspace.notebookDocuments.some(document => document.isDirty)) {
		await vscode.window.showWarningMessage(vscode.l10n.t('Salve os arquivos abertos antes de instalar a atualização.'));
		return;
	}
	await context.globalState.update(EXPECTED_VERSION_KEY, found.version);
	try {
		await vscode.commands.executeCommand('_singularity.installUpdate', {
			path: result.path, sha256: result.sha256, version: found.version
		});
	} catch (error) {
		await context.globalState.update(EXPECTED_VERSION_KEY, undefined);
		output.appendLine(`installation postponed: ${error.message}`);
		const message = error.message.includes('singularity-dirty-windows')
			? vscode.l10n.t('Salve os arquivos em todas as janelas do Singularity antes de atualizar.')
			: vscode.l10n.t('A instalação foi adiada. Você pode tentar novamente.');
		await vscode.window.showWarningMessage(message);
	}
}

async function review(context, output, found) {
	const downloadAction = vscode.l10n.t('Baixar atualização');
	const later = vscode.l10n.t('Adiar');
	const decision = await vscode.window.showInformationMessage(
		vscode.l10n.t('Atualização do Singularity disponível'), {
			modal: true,
			detail: vscode.l10n.t('Versão instalada: {0}\nNova versão: {1} ({2})\n\n{3}',
				INSTALLED, found.version, found.channel, found.notes.slice(0, 3000))
		}, downloadAction, later
	);
	if (decision !== downloadAction) {
		return;
	}
	const result = await download(output, found);
	if (!result) {
		return;
	}

	const reveal = vscode.l10n.t('Mostrar arquivo');
	const installAction = vscode.l10n.t('Instalar e reiniciar');
	const native = product.singularityUpdateInstall === true && ['user', 'system'].includes(product.target)
		&& (await vscode.commands.getCommands()).includes('_singularity.installUpdate');
	const choices = native ? [installAction, reveal, later] : [reveal, later];
	const action = await vscode.window.showInformationMessage(
		vscode.l10n.t('Integridade e procedência do instalador do Singularity {0} verificadas.', found.version),
		{ modal: native, detail: native ? vscode.l10n.t('Salve o trabalho em todas as janelas. O assistente do Windows abrirá após o encerramento do Singularity.') : undefined },
		...choices
	);
	if (action === installAction && native) {
		await install(context, output, found, result);
	} else if (action === reveal) {
		await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.path));
	}
}

function activate(context) {
	const output = vscode.window.createOutputChannel('Singularity Update', { log: true });
	context.subscriptions.push(output);
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
	context.subscriptions.push(item);
	const expected = context.globalState.get(EXPECTED_VERSION_KEY);
	if (expected) {
		void context.globalState.update(EXPECTED_VERSION_KEY, undefined);
		if (expected === INSTALLED) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Singularity atualizado para {0}.', INSTALLED));
		} else {
			output.appendLine(`expected version ${expected}; running ${INSTALLED}`);
			void vscode.window.showWarningMessage(vscode.l10n.t('A atualização para {0} ficou pendente. O Singularity ainda está na versão {1}.', expected, INSTALLED));
		}
	}
	let pending;
	let reviewing = false;
	const show = found => {
		pending = found;
		item.text = `$(cloud-download) ${vscode.l10n.t('Singularity {0}', found.version)}`;
		item.tooltip = vscode.l10n.t('Nova versão disponível no canal {0}. Clique para baixar.', found.channel);
		item.command = 'singularity.update.download';
		item.show();
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('singularity.update.check', async () => {
			const found = await check(context, output, { explicit: true });
			if (found) {
				show(found);
				await vscode.commands.executeCommand('singularity.update.download');
			} else {
				pending = undefined;
				item.hide();
			}
		}),
		vscode.commands.registerCommand('singularity.update.download', async () => {
			const found = pending && (settings().channel === 'preview' || pending.channel === 'stable') ? pending : await check(context, output, { explicit: true });
			if (found && !reviewing) {
				reviewing = true;
				try {
					await review(context, output, found);
				} finally {
					reviewing = false;
				}
			}
		}),
	);

	// at most one background check a day, and only if the user has not turned it off
	const last = context.globalState.get(LAST_CHECK_KEY, 0);
	if (settings().automatic && Date.now() - last > DAY) {
		setTimeout(() => { void check(context, output, { explicit: false }).then(f => { if (f) { show(f); } }); }, 20000);
	}
	return {};
}

function deactivate() { }

module.exports = { activate, deactivate };
