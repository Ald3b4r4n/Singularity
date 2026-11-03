'use strict';
// Wiring of the publishing modes into the IDE. The token stays in this extension: it is read from SecretStorage here and
// handed only to the git process of a push (see publish.js). Nothing in this file exposes it.

const vscode = require('vscode');
const pub = require('./publish.js');

// Only the publishing authorization (scope repo) can push to github.com. The identity token (read:user) never does.
const PUBLISH_KEY = 'singularity.github.publishToken';
const GITHUB_HTTPS = /^https:\/\/github\.com\//i;
const askedFor = new Map(); // root -> head commit the user answered "not now" for
const pushedThisSession = new Set();

function settings() {
	const c = vscode.workspace.getConfiguration('singularity.publish');
	return {
		defaultMode: c.get('defaultMode', 'manual'),
		automaticRepositories: c.get('automaticRepositories', []),
	};
}

/** Checks one repository and acts according to its mode. `explicit` = the user asked for it (command), so it pushes in any mode. */
async function checkRepository(context, output, root, { explicit = false } = {}) {
	const { defaultMode, automaticRepositories } = settings();
	const mode = pub.modeFor(root, { defaultMode, automaticRepositories });
	const wantsNetwork = explicit || mode !== 'manual';
	const token = wantsNetwork ? await context.secrets.get(PUBLISH_KEY) : undefined;
	const state = await pub.inspect(root, { fetch: wantsNetwork, token });
	if (state.fetchError) { output.appendLine(`fetch skipped for ${root}: ${state.fetchError}`); }
	const decision = pub.decide(explicit ? 'automatic' : mode, state);
	output.appendLine(`${root}: mode=${explicit ? 'explicit' : mode} automatic=${JSON.stringify(automaticRepositories)} ahead=${state.ahead} behind=${state.behind} -> ${decision.action} (${decision.reason})`);

	if (decision.action === 'report') {
		const text = {
			'no-upstream': 'Este branch não tem upstream configurado. Nada foi publicado e nenhum remoto foi alterado.',
			'no-branch': 'HEAD destacado ou repositório sem commits. Nada a publicar.',
			diverged: 'O remoto tem commits que você não tem localmente. Nada foi enviado; resolva pelo Git (não há force-push).',
		}[decision.reason];
		if (explicit || decision.reason === 'diverged') { vscode.window.showWarningMessage(text); }
		output.appendLine(`${root}: ${decision.reason}`);
		return;
	}
	if (decision.action === 'none') {
		if (explicit) { vscode.window.showInformationMessage('Nada a publicar: o branch está em dia com o upstream.'); }
		return;
	}
	if (decision.action === 'ask') {
		if (askedFor.get(root) === state.head) { return; } // answered "not now" for this commit already
		const publishNow = vscode.l10n.t('Publicar');
		const later = vscode.l10n.t('Agora não');
		const choice = await vscode.window.showInformationMessage(
			vscode.l10n.t('{0} commit(s) prontos para publicar em {1}.', state.ahead, state.upstream), publishNow, later);
		if (choice !== publishNow) { askedFor.set(root, state.head); return; }
	}
	await runPush(context, output, state, token);
}

async function runPush(context, output, state, tokenIfAny) {
	const token = tokenIfAny ?? await context.secrets.get(PUBLISH_KEY);
	// a GitHub remote needs the publishing authorization; without it nothing is pushed and the user is told how to grant it
	if (state.remoteUrl && GITHUB_HTTPS.test(state.remoteUrl) && !token) {
		output.appendLine(`${state.root}: needs publishing authorization`);
		vscode.window.showWarningMessage(vscode.l10n.t('Publicar no GitHub exige a autorização de publicação. Use "Singularity: Gerenciar conta GitHub" → Autorizar publicação.'));
		return;
	}
	const r = await pub.publish(state, { token, published: pushedThisSession });
	output.appendLine(`${state.root}: ${r.code}${r.stderr ? ' | ' + r.stderr.split('\n')[0] : ''}`); // git's first message, no token
	if (r.ok) {
		if (r.code !== 'up-to-date' && r.code !== 'already-published') { vscode.window.setStatusBarMessage(vscode.l10n.t('Singularity: {0}', r.message), 8000); }
	} else {
		vscode.window.showWarningMessage(vscode.l10n.t('Singularity: {0}', r.message));
	}
}

/** Watches the Git metadata of each workspace folder, so commits made by any tool (the editor, a terminal, an agent) are seen. */
function watch(context, output) {
	const timers = new Map();
	const schedule = folder => {
		clearTimeout(timers.get(folder.uri.fsPath));
		timers.set(folder.uri.fsPath, setTimeout(() => { void pub.inspect(folder.uri.fsPath).then(s => s.isRepo && checkRepository(context, output, s.root)).catch(() => { }); }, 1500));
	};
	const attach = folder => {
		const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.git/{HEAD,logs/HEAD,refs/heads/**}'));
		context.subscriptions.push(w, w.onDidChange(() => schedule(folder)), w.onDidCreate(() => schedule(folder)));
	};
	for (const f of vscode.workspace.workspaceFolders || []) { attach(f); }
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(e => { for (const f of e.added) { attach(f); } }));
	context.subscriptions.push({ dispose: () => { for (const t of timers.values()) { clearTimeout(t); } } });
}

function registerPublishing(context, output) {
	context.subscriptions.push(
		vscode.commands.registerCommand('singularity.publish.now', async () => {
			const folder = (vscode.workspace.workspaceFolders || [])[0];
			if (!folder) { vscode.window.showInformationMessage('Abra uma pasta de projeto para publicar.'); return; }
			const s = await pub.inspect(folder.uri.fsPath);
			if (!s.isRepo) { vscode.window.showInformationMessage('A pasta aberta não é um repositório Git.'); return; }
			await checkRepository(context, output, s.root, { explicit: true });
		}),
	);
	watch(context, output);
	for (const f of vscode.workspace.workspaceFolders || []) {
		void pub.inspect(f.uri.fsPath).then(s => s.isRepo && checkRepository(context, output, s.root)).catch(() => { });
	}
}

module.exports = { registerPublishing };
