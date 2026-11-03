'use strict';
// Singularity account: sign in with GitHub, independent of Copilot and of any AI subscription.
// - The OAuth token lives in SecretStorage (the OS credential store). It never goes to a webview, to the Hub, or to a log.
// - globalState keeps only public account data (login, name, avatar URL, id) to show who is signed in.
// - Without a client id (setting singularity.account.githubClientId) the account features say so and do nothing else.

const vscode = require('vscode');
const gh = require('./github.js');

const TOKEN_KEY = 'singularity.github.token';
const ACCOUNT_KEY = 'singularity.github.account';

const fetchFn = (url, init) => fetch(url, init);

function clientId() {
	return (vscode.workspace.getConfiguration('singularity.account').get('githubClientId') || '').trim();
}

async function signIn(context, output, changed) {
	const id = clientId();
	if (!id) {
		vscode.window.showWarningMessage(vscode.l10n.t('Conta GitHub indisponível nesta build: falta o client id do aplicativo OAuth do Singularity.'));
		return;
	}
	let code;
	try {
		code = await gh.requestDeviceCode({ fetchFn, clientId: id });
	} catch (e) {
		output.appendLine(`sign-in failed to start: ${e.code || 'error'}`); // no token or response body is logged
		vscode.window.showErrorMessage(vscode.l10n.t('Não foi possível iniciar a entrada no GitHub: {0}', e.message));
		return;
	}
	const choice = await vscode.window.showInformationMessage(
		vscode.l10n.t('Para entrar no GitHub, abra {0} e digite o código {1}.', code.verificationUri, code.userCode),
		{ modal: false },
		vscode.l10n.t('Copiar código e abrir GitHub'),
		vscode.l10n.t('Cancelar'),
	);
	if (choice !== vscode.l10n.t('Copiar código e abrir GitHub')) { return; }
	await vscode.env.clipboard.writeText(code.userCode);
	await vscode.env.openExternal(vscode.Uri.parse(code.verificationUri));

	await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Aguardando autorização no GitHub…'), cancellable: true }, async (_p, token) => {
		const signal = { cancelled: false };
		token.onCancellationRequested(() => { signal.cancelled = true; });
		try {
			const result = await gh.pollForToken({ fetchFn, clientId: id, deviceCode: code.deviceCode, intervalMs: code.intervalMs, expiresInMs: code.expiresInMs, signal });
			const account = await gh.fetchAccount({ fetchFn, accessToken: result.accessToken });
			await context.secrets.store(TOKEN_KEY, result.accessToken);
			await context.globalState.update(ACCOUNT_KEY, account);
			output.appendLine(`signed in as ${account.login}`);
			changed();
			vscode.window.showInformationMessage(vscode.l10n.t('Conectado ao GitHub como {0}.', account.login));
		} catch (e) {
			if (e.code === 'cancelled') { return; }
			output.appendLine(`sign-in failed: ${e.code || 'error'}`);
			vscode.window.showErrorMessage(vscode.l10n.t('Entrada no GitHub não concluída: {0}', e.message));
		}
	});
}

async function signOut(context, output, changed) {
	const account = context.globalState.get(ACCOUNT_KEY);
	await context.secrets.delete(TOKEN_KEY);
	await context.globalState.update(ACCOUNT_KEY, undefined);
	output.appendLine(`signed out${account ? ' (' + account.login + ')' : ''}`);
	changed();
	vscode.window.showInformationMessage(vscode.l10n.t('Conta GitHub desconectada no Singularity. A autorização continua válida no GitHub até ser revogada em Configurações do GitHub.'));
}

/** Checks the stored token still works. A revoked token is removed, so the UI does not show a signed-in account that cannot publish. */
async function verifyStored(context, output, changed) {
	const token = await context.secrets.get(TOKEN_KEY);
	if (!token) { return undefined; }
	try {
		const account = await gh.fetchAccount({ fetchFn, accessToken: token });
		await context.globalState.update(ACCOUNT_KEY, account);
		changed();
		return account;
	} catch (e) {
		if (e.code === 'unauthorized') {
			await context.secrets.delete(TOKEN_KEY);
			await context.globalState.update(ACCOUNT_KEY, undefined);
			output.appendLine('stored token was revoked; signed out');
			changed();
		} else {
			output.appendLine(`could not verify the account now (${e.code || 'error'}); keeping the last known state`);
		}
		return context.globalState.get(ACCOUNT_KEY);
	}
}

function activate(context) {
	const output = vscode.window.createOutputChannel('Singularity Account', { log: true });
	context.subscriptions.push(output);

	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	item.name = 'Singularity: GitHub';
	context.subscriptions.push(item);
	const render = () => {
		const account = context.globalState.get(ACCOUNT_KEY);
		item.text = account ? `$(github) ${account.login}` : `$(github) ${vscode.l10n.t('Entrar no GitHub')}`;
		item.tooltip = account
			? vscode.l10n.t('Conta GitHub usada pelo Singularity: {0}. Clique para gerenciar.', account.login)
			: vscode.l10n.t('Nenhuma conta GitHub conectada. Clique para entrar.');
		item.command = 'singularity.account.manage';
		item.show();
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('singularity.account.signIn', () => signIn(context, output, render)),
		vscode.commands.registerCommand('singularity.account.signOut', () => signOut(context, output, render)),
		vscode.commands.registerCommand('singularity.account.switch', async () => { await signOut(context, output, render); await signIn(context, output, render); }),
		vscode.commands.registerCommand('singularity.account.manage', async () => {
			const account = context.globalState.get(ACCOUNT_KEY);
			const picks = account
				? [{ label: `$(account) ${account.name} (${account.login})`, description: vscode.l10n.t('conectada'), action: undefined },
					{ label: vscode.l10n.t('Trocar de conta'), action: 'singularity.account.switch' },
					{ label: vscode.l10n.t('Sair da conta'), action: 'singularity.account.signOut' }]
				: [{ label: vscode.l10n.t('Entrar com GitHub'), action: 'singularity.account.signIn' }];
			const pick = await vscode.window.showQuickPick(picks, { placeHolder: vscode.l10n.t('Conta GitHub do Singularity') });
			if (pick && pick.action) { await vscode.commands.executeCommand(pick.action); }
		}),
	);
	render();
	void verifyStored(context, output, render);

	// public surface for other Singularity components: the account login only, never the token
	return {
		getAccountLogin: () => (context.globalState.get(ACCOUNT_KEY) || {}).login,
	};
}

function deactivate() { }

module.exports = { activate, deactivate };
