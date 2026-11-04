'use strict';
// Publishing commits to the remote of the current branch, in three modes:
//   manual     - nothing is pushed automatically (the user pushes with Git, or with the command);
//   assisted   - when local commits are ahead of the upstream, the IDE asks whether to push;
//   automatic  - after a commit, the IDE pushes to the upstream. Only for repositories listed explicitly.
//
// Rules (enforced here, not in the UI):
//   - the target is the upstream of the current branch. A repository without an upstream is reported, never fixed silently;
//   - remotes are never added, renamed or re-pointed; origin is not assumed to belong to the signed-in account;
//   - the upstream is fetched before deciding, so a divergence made elsewhere is seen before anything is pushed;
//   - no force push: a non-fast-forward is reported as a conflict, and nothing is retried with force;
//   - a commit is pushed once per session: a second attempt for the same commit is skipped;
//   - only commits are pushed; the working tree is never part of a push;
//   - offline and authentication failures are reported as such; nothing loops.
//   - the account token, when used, reaches only the one git process, through the environment, never the command line or a log.
//
// Git is driven with argument arrays (no shell). Credentials are supplied per process with a helper that replaces the
// user's own helpers for that command only, so the user's Git configuration is not changed.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const TOKEN_ENV = 'SINGULARITY_PUBLISH_TOKEN';
const TOKEN_HELPER = '!f() { echo username=x-access-token; echo password=$' + TOKEN_ENV + '; }; f';
const GITHUB_HTTPS = /^https:\/\/github\.com\//i;

function git(cwd, args, { env = {}, timeoutMs = 120000 } = {}) {
	return new Promise(resolve => {
		execFile('git', args, {
			cwd,
			windowsHide: true,
			timeout: timeoutMs,
			maxBuffer: 4 * 1024 * 1024,
			env: {
				PATH: process.env.PATH || process.env.Path || '',
				SystemRoot: process.env.SystemRoot, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
				TEMP: process.env.TEMP, TMP: process.env.TMP,
				GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
				...env,
			},
		}, (err, stdout, stderr) => {
			resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

/** Credential arguments for one git process. Nothing is stored on disk. */
function authFor(url, token) {
	if (token && url && GITHUB_HTTPS.test(url)) {
		return { args: ['-c', 'credential.helper=', '-c', `credential.helper=${TOKEN_HELPER}`], env: { [TOKEN_ENV]: token } };
	}
	return { args: [], env: {} };
}

function classify(stderr, code) {
	const s = stderr.toLowerCase();
	if (/non-fast-forward|fetch first|\[rejected\]/.test(s)) { return 'rejected'; }
	if (/authentication failed|could not read username|invalid username or password|returned error: 40[13]/.test(s)) { return 'auth'; }
	if (/could not resolve host|failed to connect|unable to access|network is unreachable|connection (timed out|refused)|timed out/.test(s)) { return 'offline'; }
	if (/does not appear to be a git repository|could not read from remote|repository not found/.test(s)) { return 'remote-error'; }
	return code === 0 ? 'pushed' : 'error';
}

/**
 * The repository the folder belongs to, its branch, its upstream and the commits that are not published yet.
 * With { fetch: true } the upstream remote is fetched first (no merge, the working tree is not touched). A failed fetch
 * (offline, no permission) is recorded in fetchError and the state is based on what was already known.
 */
async function inspect(folder, { fetch = false, token } = {}) {
	const top = await git(folder, ['rev-parse', '--show-toplevel']);
	if (top.code !== 0) { return { isRepo: false }; }
	const root = top.stdout.trim();
	const branch = (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || undefined;
	const head = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).stdout.trim() || undefined;
	if (!branch || !head) { return { isRepo: true, root, branch, head, hasUpstream: false, reason: 'detached-or-empty' }; }
	const up = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
	if (up.code !== 0) { return { isRepo: true, root, branch, head, hasUpstream: false, reason: 'no-upstream' }; }
	const upstream = up.stdout.trim(); // e.g. origin/main
	const remoteName = upstream.split('/')[0];
	const remoteBranch = upstream.slice(remoteName.length + 1);
	const remoteUrl = (await git(root, ['remote', 'get-url', remoteName])).stdout.trim() || undefined;
	let fetchError;
	if (fetch) {
		const a = authFor(remoteUrl, token);
		const f = await git(root, [...a.args, 'fetch', '--quiet', '--no-tags', remoteName], { env: a.env, timeoutMs: 60000 });
		if (f.code !== 0) { fetchError = classify(f.stderr, f.code); }
	}
	const ahead = Number((await git(root, ['rev-list', '--count', `${upstream}..HEAD`])).stdout.trim() || 0);
	const behind = Number((await git(root, ['rev-list', '--count', `HEAD..${upstream}`])).stdout.trim() || 0);
	return { isRepo: true, root, branch, head, hasUpstream: true, upstream, remoteName, remoteBranch, remoteUrl, ahead, behind, fetchError };
}

/** What the IDE should do now, given the repository state and the mode configured for it. Pure. */
function decide(mode, state) {
	if (!state.isRepo) { return { action: 'none', reason: 'not-a-repository' }; }
	if (!state.hasUpstream) { return { action: 'report', reason: state.reason === 'no-upstream' ? 'no-upstream' : 'no-branch' }; }
	if (state.ahead === 0) { return { action: 'none', reason: 'up-to-date' }; }
	// the fetch failed (offline, no permission): the remote state is unknown, so nothing is pushed or offered on stale knowledge
	if (state.fetchError && mode !== 'manual') { return { action: 'report', reason: 'fetch-failed' }; }
	if (state.behind > 0) { return { action: 'report', reason: 'diverged' }; }
	if (mode === 'manual') { return { action: 'none', reason: 'manual' }; }
	if (mode === 'assisted') { return { action: 'ask', reason: 'ahead' }; }
	if (mode === 'automatic') { return { action: 'push', reason: 'ahead' }; }
	return { action: 'none', reason: 'unknown-mode' };
}

/** The mode for a repository: automatic only when the repository is listed; otherwise manual or assisted. */
function modeFor(root, { defaultMode = 'manual', automaticRepositories = [] } = {}) {
	// Compare real locations: one folder can be spelled with a Windows 8.3 short name (ANTONI~1), a long name, or other separators.
	const norm = p => {
		let real;
		try { real = fs.realpathSync.native(p); } catch { real = path.resolve(p); }
		return real.replace(/[\\/]+$/, '').toLowerCase();
	};
	if (automaticRepositories.some(p => norm(p) === norm(root))) { return 'automatic'; }
	return defaultMode === 'assisted' ? 'assisted' : 'manual';
}

/**
 * Pushes the current branch to its upstream, without force. `token` (optional) is used only for this process.
 * `published` is a Set of commit ids already pushed in this session: a commit is never pushed twice.
 */
async function publish(state, { token, published = new Set() } = {}) {
	if (!state.isRepo || !state.hasUpstream) { return { ok: false, code: 'no-upstream', message: 'Este branch não tem upstream configurado.' }; }
	if (state.ahead === 0) { return { ok: true, code: 'up-to-date', message: 'Nada a publicar.' }; }
	if (state.behind > 0) { return { ok: false, code: 'rejected', message: 'O remoto tem commits que você não tem localmente. Nada foi enviado; resolva a divergência pelo Git (não há force-push).' }; }
	if (published.has(state.head)) { return { ok: true, code: 'already-published', message: 'Este commit já foi publicado nesta sessão.' }; }
	const a = authFor(state.remoteUrl, token);
	// no --force and no --force-with-lease: a rejected push is reported
	const r = await git(state.root, [...a.args, 'push', state.remoteName, `${state.branch}:${state.remoteBranch}`], { env: a.env });
	const code = classify(r.stderr, r.code);
	if (code === 'pushed') {
		published.add(state.head);
		return { ok: true, code, message: `${state.ahead} commit(s) publicado(s) em ${state.upstream}.` };
	}
	const messages = {
		rejected: 'O remoto tem commits que você não tem localmente. Nada foi enviado; resolva a divergência pelo Git (não há force-push).',
		auth: 'O GitHub recusou a autenticação. Entre novamente na conta do Singularity ou verifique a permissão do token.',
		offline: 'Sem conexão com o remoto. Os commits continuam locais e serão publicados no próximo commit ou comando.',
		'remote-error': 'O remoto não pôde ser acessado. Verifique a URL do remoto.',
		error: 'O push falhou. Detalhes no canal de saída Singularity Publish.',
	};
	return { ok: false, code, message: messages[code], stderr: r.stderr.slice(0, 2000) };
}

module.exports = { inspect, decide, modeFor, publish, classify, git, authFor, TOKEN_ENV, TOKEN_HELPER };
