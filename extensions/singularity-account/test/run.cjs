'use strict';
// Run: node test/run.cjs   (no network: GitHub is replaced by a scripted fake fetch)
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const gh = require('../github.js');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const nls = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
const ext = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const results = [];
const test = async (name, fn) => {
	try { await fn(); results.push(true); console.log('  ok  ' + name); }
	catch (e) { results.push(false); console.log('  FAIL ' + name + ': ' + e.message); }
};

/** A fake fetch that answers from a script of responses, and records every request. */
function scripted(responses) {
	const calls = [];
	const fetchFn = async (url, init) => {
		calls.push({ url, init });
		const next = responses.shift();
		if (!next) { throw new Error('unexpected request: ' + url); }
		const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
		return { ok: (next.status ?? 200) < 300, status: next.status ?? 200, text: async () => body };
	};
	return { fetchFn, calls };
}
const noSleep = async () => {};

(async () => {
	await test('requests a device code with only the public client id and identity scope', async () => {
		const { fetchFn, calls } = scripted([{ body: { device_code: 'DC', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 } }]);
		const code = await gh.requestDeviceCode({ fetchFn, clientId: 'Iv1.example' });
		assert.equal(code.userCode, 'WDJB-MJHT');
		assert.equal(code.intervalMs, 5000);
		assert.equal(calls[0].url, 'https://github.com/login/device/code');
		const body = new URLSearchParams(calls[0].init.body);
		assert.equal(body.get('client_id'), 'Iv1.example');
		assert.equal(body.get('scope'), 'read:user');
		assert.equal(body.has('client_secret'), false, 'no client secret is ever sent');
	});

	await test('refuses to start without a client id, and never uses another product\'s id', async () => {
		await assert.rejects(gh.requestDeviceCode({ fetchFn: scripted([]).fetchFn, clientId: '' }), e => e.code === 'not-configured');
		assert.equal(ext.includes('01ab8ac9400c4e429b23'), false, 'the VS Code OAuth client id is not used');
	});

	await test('polls through authorization_pending and returns the token', async () => {
		const { fetchFn, calls } = scripted([
			{ body: { error: 'authorization_pending' } },
			{ body: { error: 'authorization_pending' } },
			{ body: { access_token: 'gho_test_token_value_0000000000', token_type: 'bearer', scope: 'read:user' } },
		]);
		const r = await gh.pollForToken({ fetchFn, clientId: 'Iv1.example', deviceCode: 'DC', intervalMs: 1000, expiresInMs: 60000, sleep: noSleep, now: () => 0 });
		assert.equal(r.accessToken, 'gho_test_token_value_0000000000');
		assert.equal(calls.length, 3);
		assert.equal(new URLSearchParams(calls[0].init.body).get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
	});

	await test('slow_down widens the wait; expired and denied stop with a typed error', async () => {
		const slept = [];
		const { fetchFn } = scripted([{ body: { error: 'slow_down', interval: 10 } }, { body: { access_token: 'x' } }]);
		await gh.pollForToken({ fetchFn, clientId: 'c', deviceCode: 'd', intervalMs: 1000, expiresInMs: 60000, sleep: async ms => { slept.push(ms); }, now: () => 0 });
		assert.ok(slept[1] >= 15000, 'the next wait honours slow_down: ' + slept.join(','));
		await assert.rejects(gh.pollForToken({ fetchFn: scripted([{ body: { error: 'expired_token' } }]).fetchFn, clientId: 'c', deviceCode: 'd', intervalMs: 1, expiresInMs: 60000, sleep: noSleep, now: () => 0 }), e => e.code === 'expired');
		await assert.rejects(gh.pollForToken({ fetchFn: scripted([{ body: { error: 'access_denied' } }]).fetchFn, clientId: 'c', deviceCode: 'd', intervalMs: 1, expiresInMs: 60000, sleep: noSleep, now: () => 0 }), e => e.code === 'denied');
	});

	await test('cancellation stops polling before the next request', async () => {
		const signal = { cancelled: false };
		const { fetchFn, calls } = scripted([{ body: { error: 'authorization_pending' } }, { body: { access_token: 'never' } }]);
		await assert.rejects(gh.pollForToken({ fetchFn, clientId: 'c', deviceCode: 'd', intervalMs: 1, expiresInMs: 60000, signal, sleep: async () => { signal.cancelled = true; }, now: () => 0 }), e => e.code === 'cancelled');
		assert.equal(calls.length, 0, 'no request after cancellation');
	});

	await test('the account is read with the token in the header and keeps only public fields', async () => {
		const { fetchFn, calls } = scripted([{ body: { login: 'octocat', name: 'The Octocat', avatar_url: 'https://avatars.githubusercontent.com/u/1', id: 1, email: 'private@example.invalid', plan: { name: 'free' } } }]);
		const a = await gh.fetchAccount({ fetchFn, accessToken: 'tok' });
		assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
		assert.deepEqual(Object.keys(a).sort(), ['avatarUrl', 'id', 'login', 'name']);
		assert.equal(JSON.stringify(a).includes('private@example.invalid'), false, 'no email is kept');
	});

	await test('a revoked token is reported as unauthorized so the caller can remove it', async () => {
		await assert.rejects(gh.fetchAccount({ fetchFn: scripted([{ status: 401, body: { message: 'Bad credentials' } }]).fetchFn, accessToken: 'old' }), e => e.code === 'unauthorized');
	});

	await test('the extension never sends the token to a webview, the Hub or the log', async () => {
		const code = ext.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
		assert.equal(/webview|postMessage|singularity-hub|\bhub\.js/.test(code), false);
		const logged = ext.match(/appendLine\([^)]*\)/g) || [];
		assert.ok(logged.length > 0);
		assert.ok(logged.every(l => !/accessToken|result\.access/.test(l)), logged.join('\n'));
	});

	await test('the manifest declares the commands and their localized titles', async () => {
		for (const c of pkg.contributes.commands) {
			assert.ok(ext.includes(`'${c.command}'`), c.command + ' is registered');
			const key = c.title.slice(1, -1);
			assert.ok(key in nls, 'nls key ' + key);
		}
		assert.equal(pkg.contributes.configuration.properties['singularity.account.githubClientId'].scope, 'machine');
	});

	const failed = results.filter(r => !r).length;
	console.log(`${results.length - failed}/${results.length} passed`);
	process.exit(failed ? 1 : 0);
})();
