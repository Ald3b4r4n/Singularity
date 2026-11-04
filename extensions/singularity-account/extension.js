'use strict';
// Singularity account: sign in with GitHub, independent of Copilot and of any AI subscription.
// Two separate authorizations, each with its own token and scope:
//   - identity ("Sign In with GitHub"): scope read:user, shows who is signed in;
//   - publishing ("Autorizar publicação"): scope repo, required before any push to github.com.
// Tokens live in SecretStorage (the OS credential store). They never go to a webview, to the Hub, or to a log.
// globalState keeps only public account data (login, name, avatar file, id, scopes) for display.

const vscode = require('vscode');
const fs = require('fs'), path = require('path');
const gh = require('./github.js');

const TOKEN_KEY = 'singularity.github.token';
const PUBLISH_KEY = 'singularity.github.publishToken';
const ACCOUNT_KEY = 'singularity.github.account';

const fetchFn = (url, init) => fetch(url, init);

function clientId() {
	return (vscode.workspace.getConfiguration('singularity.account').get('githubClientId') || '').trim() || gh.DEFAULT_CLIENT_ID;
}

/**
 * Device flow for one purpose: shows the code, opens GitHub when asked, polls until approved, and returns the token and the
 * account it belongs to. The code is shown to the user; the token is returned to the caller and not displayed.
 */
async function authorize(context, output, { scope, purpose }) {
	const id = clientId();
	let code;
	try {
		code = await gh.requestDeviceCode({ fetchFn, clientId: id, scopes: scope });
	} catch (e) {
		output.appendLine(`${purpose}: could not start (${e.code || 'error'})`); // no token or response body is logged
		vscode.window.showErrorMessage(vscode.l10n.t('Não foi possível iniciar a entrada no GitHub: {0}', e.message));
		return undefined;
	}
	const copyAndOpen = vscode.l10n.t('Copiar código e abrir GitHub');
	// Modal on purpose: a plain notification hides itself after about 10 seconds, and the choice would then be lost,
	// so the device flow would never start (nothing is polled and nothing is shown).
	const choice = await vscode.window.showInformationMessage(
		vscode.l10n.t('Para entrar no GitHub, abra {0} e digite o código {1}.', code.verificationUri, code.userCode),
		{ modal: true },
		copyAndOpen,
		vscode.l10n.t('Cancelar'),
	);
	if (choice !== copyAndOpen) { output.appendLine(`${purpose}: cancelled before approval`); return undefined; }
	await vscode.env.clipboard.writeText(code.userCode);
	await vscode.env.openExternal(vscode.Uri.parse(code.verificationUri));

	return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Aguardando autorização no GitHub…'), cancellable: true }, async (_p, token) => {
		const signal = { cancelled: false };
		token.onCancellationRequested(() => { signal.cancelled = true; });
		try {
			const result = await gh.pollForToken({ fetchFn, clientId: id, deviceCode: code.deviceCode, intervalMs: code.intervalMs, expiresInMs: code.expiresInMs, signal });
			return { accessToken: result.accessToken };
		} catch (e) {
			if (e.code !== 'cancelled') {
				output.appendLine(`${purpose}: ${e.code || 'error'}`);
				vscode.window.showErrorMessage(vscode.l10n.t('Entrada no GitHub não concluída: {0}', e.message));
			}
			return undefined;
		}
	});
}

/** Public avatar of the account, saved next to the extension's state so the UI can show it without contacting GitHub again. */
async function cacheAvatar(context, account) {
	if (!account || !account.avatarUrl || !/^https:\/\/avatars\.githubusercontent\.com\//.test(account.avatarUrl)) { return undefined; }
	try {
		const dir = context.globalStorageUri.fsPath;
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `avatar-${account.id}.png`);
		const res = await fetchFn(account.avatarUrl); // public image: no credentials
		if (!res.ok) { return undefined; }
		fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
		return file;
	} catch {
		return undefined;
	}
}

async function signIn(context, output, changed) {
	const result = await authorize(context, output, { scope: gh.IDENTITY_SCOPES, purpose: 'sign-in' });
	if (!result) { return; }
	try {
		const account = await gh.fetchAccount({ fetchFn, accessToken: result.accessToken });
		account.avatarPath = await cacheAvatar(context, account);
		await context.secrets.store(TOKEN_KEY, result.accessToken);
		await context.globalState.update(ACCOUNT_KEY, account);
		output.appendLine(`signed in as ${account.login}`);
		changed();
		vscode.window.showInformationMessage(vscode.l10n.t('Conectado ao GitHub como {0}.', account.login));
	} catch (e) {
		output.appendLine(`sign-in: could not read the account (${e.code || 'error'})`);
		vscode.window.showErrorMessage(vscode.l10n.t('Não foi possível ler a conta: {0}', e.message));
	}
}

/**
 * Asks for write access. The token is stored only if GitHub reports the "repo" scope on it; otherwise it is discarded.
 * Requires a signed-in account, so the publishing authorization is always tied to a visible identity.
 */
async function authorizePublish(context, output, changed) {
	const account = context.globalState.get(ACCOUNT_KEY);
	if (!account) {
		vscode.window.showInformationMessage(vscode.l10n.t('Entre com GitHub antes de autorizar a publicação.'));
		return;
	}
	const result = await authorize(context, output, { scope: gh.PUBLISH_SCOPES, purpose: 'publish-authorization' });
	if (!result) { return; }
	let granted;
	try {
		granted = await gh.fetchAccount({ fetchFn, accessToken: result.accessToken });
	} catch (e) {
		output.appendLine(`publish-authorization: could not verify (${e.code || 'error'})`);
		vscode.window.showErrorMessage(vscode.l10n.t('Não foi possível verificar a autorização: {0}', e.message));
		return;
	}
	if (granted.login !== account.login) {
		output.appendLine('publish-authorization: approved by a different account; discarded');
		vscode.window.showWarningMessage(vscode.l10n.t('A autorização foi concedida por outra conta ({0}). Ela não foi usada. Entre com {1} e autorize de novo.', granted.login, account.login));
		return;
	}
	if (!granted.scopes.includes('repo')) {
		output.appendLine('publish-authorization: "repo" scope not granted; discarded');
		vscode.window.showWarningMessage(vscode.l10n.t('A permissão de escrita (repo) não foi concedida. Nada foi publicado e nenhuma autorização foi guardada.'));
		return;
	}
	await context.secrets.store(PUBLISH_KEY, result.accessToken);
	output.appendLine(`publish authorized for ${account.login} (scopes: ${granted.scopes.join(',')})`);
	changed();
	vscode.window.showInformationMessage(vscode.l10n.t('Publicação autorizada para {0}.', account.login));
}

async function revokePublish(context, output, changed) {
	await context.secrets.delete(PUBLISH_KEY);
	output.appendLine('publish authorization removed from this IDE');
	changed();
	vscode.window.showInformationMessage(vscode.l10n.t('Autorização de publicação removida do Singularity. Para revogá-la no GitHub, use Configurações do GitHub → Aplicativos autorizados.'));
}

async function signOut(context, output, changed) {
	const account = context.globalState.get(ACCOUNT_KEY);
	await context.secrets.delete(TOKEN_KEY);
	await context.secrets.delete(PUBLISH_KEY);
	await context.globalState.update(ACCOUNT_KEY, undefined);
	output.appendLine(`signed out${account ? ' (' + account.login + ')' : ''}; publish authorization removed`);
	changed();
	vscode.window.showInformationMessage(vscode.l10n.t('Conta GitHub desconectada no Singularity. A autorização continua válida no GitHub até ser revogada em Configurações do GitHub.'));
}

/**
 * Checks both stored tokens still work and have what they should. A revoked identity token signs the account out; a publish
 * token without "repo" (or for another account) is removed, so the UI never shows an authorization that cannot push.
 */
async function verifyStored(context, output, changed) {
	const token = await context.secrets.get(TOKEN_KEY);
	if (!token) { return undefined; }
	try {
		const account = await gh.fetchAccount({ fetchFn, accessToken: token });
		const previous = context.globalState.get(ACCOUNT_KEY) || {};
		account.avatarPath = previous.avatarPath && previous.id === account.id ? previous.avatarPath : await cacheAvatar(context, account);
		await context.globalState.update(ACCOUNT_KEY, account);
	} catch (e) {
		if (e.code === 'unauthorized') {
			await context.secrets.delete(TOKEN_KEY);
			await context.secrets.delete(PUBLISH_KEY);
			await context.globalState.update(ACCOUNT_KEY, undefined);
			output.appendLine('stored token was revoked; signed out');
		} else {
			output.appendLine(`could not verify the account now (${e.code || 'error'}); keeping the last known state`);
		}
	}
	const publish = await context.secrets.get(PUBLISH_KEY);
	if (publish) {
		try {
			const granted = await gh.fetchAccount({ fetchFn, accessToken: publish });
			const current = context.globalState.get(ACCOUNT_KEY);
			if (!current || granted.login !== current.login || !granted.scopes.includes('repo')) {
				await context.secrets.delete(PUBLISH_KEY);
				output.appendLine('publish authorization no longer valid; removed');
			}
		} catch (e) {
			if (e.code === 'unauthorized') { await context.secrets.delete(PUBLISH_KEY); output.appendLine('publish authorization revoked on GitHub; removed'); }
		}
	}
	changed();
	return context.globalState.get(ACCOUNT_KEY);
}

/**
 * Public account state for the workbench (the title bar entry reads these context keys). Only public values are published:
 * connected or not, login, display name, avatar image and whether publishing is authorized. Never a token.
 */
function setContext(key, value) { return vscode.commands.executeCommand('setContext', key, value); }

function avatarDataUri(account) {
	if (!account || !account.avatarPath) { return ''; }
	try {
		const bytes = fs.readFileSync(account.avatarPath);
		if (bytes.length === 0 || bytes.length > 256 * 1024) { return ''; }
		const mime = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : bytes[0] === 0x47 ? 'image/gif' : bytes[0] === 0x52 ? 'image/webp' : '';
		return mime ? `data:${mime};base64,${bytes.toString('base64')}` : '';
	} catch {
		return '';
	}
}

function publishContext(account, publishAuthorized) {
	void setContext('singularity.account.ready', true);
	void setContext('singularity.account.signedIn', !!account);
	void setContext('singularity.account.login', account ? account.login : '');
	void setContext('singularity.account.name', account ? account.name : '');
	void setContext('singularity.account.avatar', avatarDataUri(account));
	void setContext('singularity.account.publishAuthorized', !!account && !!publishAuthorized);
}

function activate(context) {
	const output = vscode.window.createOutputChannel('Singularity Account', { log: true });
	context.subscriptions.push(output);

	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	item.name = 'Singularity: GitHub';
	context.subscriptions.push(item);
	const render = async () => {
		const account = context.globalState.get(ACCOUNT_KEY);
		const publish = account ? await context.secrets.get(PUBLISH_KEY) : undefined;
		item.text = account ? `$(github) ${account.login}` : `$(github) ${vscode.l10n.t('Entrar no GitHub')}`;
		item.tooltip = account
			? vscode.l10n.t('Conta GitHub: {0}. Publicação: {1}. Clique para gerenciar.', account.login, publish ? vscode.l10n.t('autorizada') : vscode.l10n.t('não autorizada'))
			: vscode.l10n.t('Nenhuma conta GitHub conectada. Clique para entrar.');
		item.command = 'singularity.account.manage';
		item.show();
		publishContext(account, publish);
	};

	require('./publishing.js').registerPublishing(context, output);
	context.subscriptions.push(
		vscode.commands.registerCommand('singularity.account.signIn', () => signIn(context, output, render)),
		vscode.commands.registerCommand('singularity.account.signOut', () => signOut(context, output, render)),
		vscode.commands.registerCommand('singularity.account.switch', async () => { await signOut(context, output, render); await signIn(context, output, render); }),
		vscode.commands.registerCommand('singularity.account.authorizePublish', () => authorizePublish(context, output, render)),
		vscode.commands.registerCommand('singularity.account.revokePublish', () => revokePublish(context, output, render)),
		vscode.commands.registerCommand('singularity.account.manage', async () => {
			const account = context.globalState.get(ACCOUNT_KEY);
			const publish = account ? await context.secrets.get(PUBLISH_KEY) : undefined;
			const picks = account
				? [
					{ label: account.avatarPath ? `$(account) ${account.name} (${account.login})` : `$(account) ${account.name} (${account.login})`, detail: vscode.l10n.t('Conectada'), action: undefined, iconPath: account.avatarPath ? vscode.Uri.file(account.avatarPath) : undefined },
					{ label: publish ? vscode.l10n.t('Publicação: autorizada') : vscode.l10n.t('Publicação: não autorizada'), detail: publish ? vscode.l10n.t('Revogar autorização de publicação') : vscode.l10n.t('Autorizar escrita (permissão repo), só quando for publicar'), action: publish ? 'singularity.account.revokePublish' : 'singularity.account.authorizePublish' },
					{ label: vscode.l10n.t('Trocar de conta'), action: 'singularity.account.switch' },
					{ label: vscode.l10n.t('Sair da conta'), action: 'singularity.account.signOut' },
				]
				: [{ label: vscode.l10n.t('Entrar com GitHub'), action: 'singularity.account.signIn' }];
			const pick = await vscode.window.showQuickPick(picks, { placeHolder: vscode.l10n.t('Conta GitHub do Singularity') });
			if (pick && pick.action) { await vscode.commands.executeCommand(pick.action); }
		}),
	);
	void render();
	void verifyStored(context, output, render).then(render);

	// public surface for other Singularity components: the login and the authorization state, never a token
	return {
		getAccountLogin: () => (context.globalState.get(ACCOUNT_KEY) || {}).login,
	};
}

function deactivate() { }

module.exports = { activate, deactivate, PUBLISH_KEY };
