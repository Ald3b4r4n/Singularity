'use strict';
// Singularity updates in the IDE: check, download with progress, and reveal the verified installer.
// Installing is not offered: it needs the installer and its migration tests (see docs/updates.md).

const vscode = require('vscode');
const fs = require('fs'), os = require('os'), path = require('path');
const update = require('./update.js');

const INSTALLED = require('./package.json').version; // the Singularity version of this build; bump with each release
const LAST_CHECK_KEY = 'singularity.update.lastCheck';
const DAY = 24 * 60 * 60 * 1000;

function settings() {
	const c = vscode.workspace.getConfiguration('singularity.update');
	return { channel: c.get('channel', 'stable'), automatic: c.get('checkAutomatically', true) };
}

async function check(context, output, { explicit }) {
	const { channel } = settings();
	let releases;
	try {
		releases = await update.listReleases({ fetchFn: (u, i) => fetch(u, i) });
	} catch (e) {
		output.appendLine(`check failed: ${e.code || 'error'}`);
		if (explicit) { vscode.window.showWarningMessage(vscode.l10n.t('Não foi possível verificar atualizações agora. Verifique a conexão e tente de novo.')); }
		return undefined;
	}
	await context.globalState.update(LAST_CHECK_KEY, Date.now());
	const { update: found, skipped } = update.selectUpdate(releases, { installed: INSTALLED, channel });
	output.appendLine(`checked ${releases.length} release(s) on ${channel}; skipped: ${JSON.stringify(skipped)}`);
	if (!found) {
		if (explicit) { vscode.window.showInformationMessage(vscode.l10n.t('Singularity {0} é a versão mais recente do canal {1}.', INSTALLED, channel)); }
		return undefined;
	}
	return found;
}

async function download(context, output, found) {
	const dir = path.join(os.tmpdir(), 'singularity-update');
	fs.mkdirSync(dir, { recursive: true });
	await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Baixando Singularity {0}', found.version), cancellable: false }, async progress => {
		let last = 0;
		const r = await update.downloadVerified({
			fetchFn: (u, i) => fetch(u, i), update: found, dir,
			onProgress: ({ received, total }) => {
				const pct = total ? Math.floor((received / total) * 100) : 0;
				if (pct > last) { progress.report({ increment: pct - last, message: `${pct}%` }); last = pct; }
			},
		});
		output.appendLine(`verified ${r.path} (${r.bytes} bytes, sha256 ${r.sha256})`);
		const open = vscode.l10n.t('Mostrar arquivo');
		const choice = await vscode.window.showInformationMessage(
			vscode.l10n.t('Singularity {0} foi baixado e verificado (SHA-256 confere com o do GitHub). A instalação automática ainda não está disponível nesta versão: revise as notas e execute o instalador quando quiser.', found.version),
			open,
		);
		if (choice === open) { vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(r.path)); }
	});
}

function activate(context) {
	const output = vscode.window.createOutputChannel('Singularity Update', { log: true });
	context.subscriptions.push(output);
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
	context.subscriptions.push(item);
	let pending;
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
			if (found) { show(found); }
		}),
		vscode.commands.registerCommand('singularity.update.download', async () => {
			const found = pending || await check(context, output, { explicit: true });
			if (found) { await download(context, output, found); }
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
