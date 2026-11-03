'use strict';
// Run: node --test test/oauth-config.test.cjs   (no network)
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('fs'), path = require('path');
const gh = require('../github.js');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));
const nls = JSON.parse(read('package.nls.json'));
const ext = read('extension.js');
const publishing = read('publishing.js');
const code = s => s.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

/** A fetch that records requests and answers with the given responses, in order. */
function scripted(responses) {
	const calls = [];
	const fetchFn = async (url, init) => {
		calls.push({ url, init });
		const next = responses.shift();
		const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
		const headers = new Map(Object.entries(next.headers || {}));
		return { ok: (next.status ?? 200) < 300, status: next.status ?? 200, text: async () => body, headers: { get: k => headers.get(k) ?? null } };
	};
	return { fetchFn, calls };
}

describe('official OAuth configuration', () => {
	it('the official public client id is the default, in code and in the manifest', () => {
		assert.equal(gh.DEFAULT_CLIENT_ID, 'Ov23li7YnPUKuiSrwRCh');
		assert.equal(pkg.contributes.configuration.properties['singularity.account.githubClientId'].default, 'Ov23li7YnPUKuiSrwRCh');
	});

	it('no client secret exists in the product: not in the code, the manifest or the strings', () => {
		const all = [code(read('github.js')), code(ext), code(publishing), JSON.stringify(pkg), JSON.stringify(nls)].join('\n');
		assert.equal(/client_secret|clientSecret|CLIENT_SECRET/.test(all), false);
	});

	it('the device flow sends the client id and no secret', async () => {
		const { fetchFn, calls } = scripted([{ body: { device_code: 'd', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 } }]);
		await gh.requestDeviceCode({ fetchFn, clientId: gh.DEFAULT_CLIENT_ID, scopes: gh.IDENTITY_SCOPES });
		const body = new URLSearchParams(calls[0].init.body);
		assert.equal(body.get('client_id'), 'Ov23li7YnPUKuiSrwRCh');
		assert.equal(body.get('scope'), 'read:user');
		assert.equal(body.has('client_secret'), false);
	});

	it('the publishing authorization asks for repo, separately from identity', async () => {
		assert.equal(gh.PUBLISH_SCOPES, 'repo');
		assert.notEqual(gh.PUBLISH_SCOPES, gh.IDENTITY_SCOPES);
		const { fetchFn, calls } = scripted([{ body: { device_code: 'd', user_code: 'X', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 } }]);
		await gh.requestDeviceCode({ fetchFn, clientId: gh.DEFAULT_CLIENT_ID, scopes: gh.PUBLISH_SCOPES });
		assert.equal(new URLSearchParams(calls[0].init.body).get('scope'), 'repo');
	});

	it('the account read reports the scopes GitHub granted, from the x-oauth-scopes header', async () => {
		const { fetchFn } = scripted([{ body: { login: 'octocat', id: 1, name: 'O' }, headers: { 'x-oauth-scopes': 'read:user, repo' } }]);
		const a = await gh.fetchAccount({ fetchFn, accessToken: 't' });
		assert.deepEqual(a.scopes, ['read:user', 'repo']);
	});

	it('without the header, the scopes are empty (never assumed)', async () => {
		const { fetchFn } = scripted([{ body: { login: 'octocat', id: 1 } }]);
		assert.deepEqual((await gh.fetchAccount({ fetchFn, accessToken: 't' })).scopes, []);
	});
});

describe('tokens are used only where they belong', () => {
	it('publishing reads only the publish token, never the identity token', () => {
		assert.equal(/singularity\.github\.token'/.test(code(publishing)), false);
		assert.ok(code(publishing).includes("'singularity.github.publishToken'"));
	});

	it('a GitHub remote is never pushed without the publishing authorization', () => {
		assert.ok(/needs publishing authorization/.test(code(publishing)));
	});

	it('an authorization approved by another account, or without repo, is discarded', () => {
		assert.ok(/outra conta|different account/.test(ext));
		assert.ok(/includes\('repo'\)/.test(ext));
	});

	it('the identity sign-in never requests repo', () => {
		assert.equal(gh.IDENTITY_SCOPES.includes('repo'), false);
	});

	it('nothing leaves the extension host toward the webview, the Hub, or the log', () => {
		const c = code(ext) + code(publishing);
		assert.equal(/webview|postMessage|singularity-hub|\bhub\.js/.test(c), false);
		const logged = (ext + publishing).match(/appendLine\([^;]*\)/g) || [];
		assert.ok(logged.every(l => !/accessToken|publishToken|\btoken\b/.test(l)), logged.join('\n'));
	});

	it('commands for publishing authorization are declared and registered', () => {
		for (const id of ['singularity.account.authorizePublish', 'singularity.account.revokePublish']) {
			assert.ok(pkg.contributes.commands.some(c => c.command === id), id);
			assert.ok(ext.includes(`'${id}'`), id);
		}
	});
});
