'use strict';
// GitHub sign-in for the Singularity IDE, using the OAuth device flow (RFC 8628), which needs only a public client id:
// there is no client secret and no redirect URI, so nothing secret ships in the product and no callback scheme is needed.
//
// The client id must belong to a GitHub OAuth App registered for Singularity (see docs/github-account.md). This module
// never uses the id of another product. Tokens are returned to the caller and never logged, displayed or sent anywhere
// except as the Authorization header of requests to the GitHub API.

const DEVICE_CODE_PATH = '/login/device/code';
const TOKEN_PATH = '/login/oauth/access_token';
const DEFAULT_LOGIN_BASE = 'https://github.com';
const DEFAULT_API_BASE = 'https://api.github.com';

/** Scopes requested at sign-in. Only identity: publishing asks for more, separately, when the user authorizes it. */
const IDENTITY_SCOPES = 'read:user';
/** Scope needed to push commits (classic OAuth App: "repo" covers private and public repositories). */
const PUBLISH_SCOPES = 'repo';
/** Public client id of the official Singularity OAuth App (Ald3b4r4n). Not a secret: device flow needs no secret. */
const DEFAULT_CLIENT_ID = 'Ov23li7YnPUKuiSrwRCh';

class GitHubAuthError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

/** Starts the flow. Returns what the user must do: open `verificationUri` and type `userCode`. */
async function requestDeviceCode({ fetchFn, clientId, scopes = IDENTITY_SCOPES, loginBase = DEFAULT_LOGIN_BASE }) {
	if (!clientId) {
		throw new GitHubAuthError('not-configured', 'A conta GitHub não está configurada nesta build (falta o client id do aplicativo OAuth).');
	}
	const body = new URLSearchParams({ client_id: clientId, scope: scopes });
	const res = await fetchFn(loginBase + DEVICE_CODE_PATH, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body });
	const json = await readJson(res, 'device code');
	if (!res.ok || !json.device_code) {
		throw new GitHubAuthError('device-code-failed', json.error_description || json.error || `HTTP ${res.status}`);
	}
	return {
		deviceCode: json.device_code,
		userCode: json.user_code,
		verificationUri: json.verification_uri,
		expiresInMs: (json.expires_in ?? 900) * 1000,
		intervalMs: (json.interval ?? 5) * 1000,
	};
}

/**
 * Polls until the user approves, denies, or the code expires. `signal` (an object with `cancelled: boolean`) lets the UI
 * stop polling. `sleep` and `now` are injectable for tests.
 */
async function pollForToken({ fetchFn, clientId, deviceCode, intervalMs, expiresInMs, loginBase = DEFAULT_LOGIN_BASE, signal = { cancelled: false }, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now }) {
	const deadline = now() + expiresInMs;
	let interval = intervalMs;
	for (; ;) {
		if (signal.cancelled) { throw new GitHubAuthError('cancelled', 'Entrada cancelada.'); }
		if (now() > deadline) { throw new GitHubAuthError('expired', 'O código expirou. Tente entrar novamente.'); }
		await sleep(interval);
		if (signal.cancelled) { throw new GitHubAuthError('cancelled', 'Entrada cancelada.'); }
		const body = new URLSearchParams({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
		const res = await fetchFn(loginBase + TOKEN_PATH, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body });
		const json = await readJson(res, 'token');
		if (json.access_token) {
			return { accessToken: json.access_token, tokenType: json.token_type, scope: json.scope };
		}
		switch (json.error) {
			case 'authorization_pending': break;
			case 'slow_down': interval = Math.max(interval, (json.interval ?? 0) * 1000) + 5000; break;
			case 'expired_token': throw new GitHubAuthError('expired', 'O código expirou. Tente entrar novamente.');
			case 'access_denied': throw new GitHubAuthError('denied', 'A autorização foi negada no GitHub.');
			default: throw new GitHubAuthError('token-failed', json.error_description || json.error || `HTTP ${res.status}`);
		}
	}
}

/** The signed-in account: login, display name and avatar. Only these fields are kept; the token is passed separately. */
async function fetchAccount({ fetchFn, accessToken, apiBase = DEFAULT_API_BASE }) {
	const res = await fetchFn(apiBase + '/user', { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${accessToken}`, 'User-Agent': 'singularity-ide' } });
	const json = await readJson(res, 'user');
	if (res.status === 401) { throw new GitHubAuthError('unauthorized', 'O GitHub recusou o token (revogado ou expirado).'); }
	if (!res.ok || typeof json.login !== 'string') { throw new GitHubAuthError('user-failed', json.message || `HTTP ${res.status}`); }
	// the scopes the token actually has, as reported by GitHub (classic tokens); empty when not reported
	const header = res.headers && typeof res.headers.get === 'function' ? res.headers.get('x-oauth-scopes') : undefined;
	const scopes = typeof header === 'string' ? header.split(',').map(s => s.trim()).filter(Boolean) : [];
	return { login: json.login, name: json.name || json.login, avatarUrl: typeof json.avatar_url === 'string' ? json.avatar_url : undefined, id: json.id, scopes };
}

async function readJson(res, what) {
	const text = await res.text();
	let json;
	try { json = text ? JSON.parse(text) : {}; } catch { throw new GitHubAuthError('bad-response', `Resposta inválida do GitHub (${what}).`); }
	return json;
}

module.exports = { requestDeviceCode, pollForToken, fetchAccount, GitHubAuthError, IDENTITY_SCOPES, PUBLISH_SCOPES, DEFAULT_CLIENT_ID, DEFAULT_LOGIN_BASE, DEFAULT_API_BASE };
