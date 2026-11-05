import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyProviderFailure, connectionFacts, pluginActivationFailure, providerDiagnostic } from '../providerDiagnostics';

test('diagnostics distinguish plugin activation, generic 503, local authentication and quota', async () => {
 const blocked = await pluginActivationFailure(new Response(JSON.stringify({ _tag: 'ServiceUnavailableError', message: 'Location plugins did not finish activating' }), { status: 503 }));
 assert.equal(classifyProviderFailure(503, blocked), 'plugins');
 assert.equal(classifyProviderFailure(503, false), 'catalog'); assert.equal(classifyProviderFailure(429), 'rate-limit');
 for (const status of [401, 403]) { assert.equal(classifyProviderFailure(status), 'local-authentication'); }
 assert.equal(classifyProviderFailure(), 'startup');
 assert.equal(providerDiagnostic('plugins').cause, 'activation-phase');
});
test('untrusted errors, huge bodies, credential IDs, labels and private paths never enter diagnostics', async () => {
 const secret = 'sk_FAKE_DO_NOT_EXPOSE';
 assert.equal(await pluginActivationFailure(new Response(JSON.stringify({ _tag: 'ServiceUnavailableError', message: secret }), { status: 503 })), false);
 assert.equal(await pluginActivationFailure(new Response('x'.repeat(17000), { status: 503 })), false);
 assert.equal(await pluginActivationFailure(new Response('invalid json', { status: 503 })), false);
 const facts = connectionFacts({ data: [{ id: 'opencode-go', settings: { apiKey: secret }, connections: [{ type: 'credential', id: secret, label: secret }] }, { id: secret, connections: [{ type: 'credential' }] }] });
 assert.deepEqual(facts, [{ id: 'opencode-go', authentication: 'configured' }]);
 const value = JSON.stringify(providerDiagnostic('ready', { integrations: facts, authentication: 'configured' }));
 assert(!value.includes(secret)); assert(!value.includes('apiKey')); assert(!value.includes('connections'));
 assert.equal(providerDiagnostic('ready', { authentication: 'unknown' }).authentication, 'unknown');
 assert.equal(connectionFacts({ data: [{ id: 'opencode-go', connections: [] }] })[0].authentication, 'not-configured');
 assert.equal(connectionFacts({ data: [{ id: 'opencode-go', connections: [{ type: 'env', name: secret }] }] })[0].authentication, 'unknown');
});

import { profileEnvironment, ISOLATED_CONFIG } from '../providerProfiles';
import { OpenCodeSessions } from '../opencode';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('isolated overlay changes only plugins, preserves the inherited environment and refuses an existing inline override', () => {
 const inherited = { XDG_CONFIG_HOME: 'normal', OPENCODE_GO_API_KEY: 'FAKE_PRIVATE', REGION: 'unchanged' };
 const isolated = profileEnvironment('isolated', inherited);
 assert.equal(inherited.XDG_CONFIG_HOME, isolated.XDG_CONFIG_HOME); assert.equal(isolated.OPENCODE_GO_API_KEY, inherited.OPENCODE_GO_API_KEY);
 assert.equal(isolated.REGION, inherited.REGION); assert(!('OPENCODE_CONFIG_CONTENT' in inherited));
 assert.deepEqual(JSON.parse(ISOLATED_CONFIG), { plugins: ['-*', 'opencode.*'] });
 assert.throws(() => profileEnvironment('isolated', { OPENCODE_CONFIG_CONTENT: '{"privacy":"keep"}' }), /segurança/);
 assert.equal(profileEnvironment('normal', inherited), inherited);
});
test('profile choice requires consent, confirmed plugin failure, catalogue and official connection metadata', async () => {
 class Fixture extends OpenCodeSessions {
  authenticated = false;
  override async diagnose(_directory?: string, _refresh = false, profile?: 'normal' | 'isolated') {
   return profile === 'isolated' ? providerDiagnostic('ready', { profile, version: '2.2.5', authentication: this.authenticated ? 'configured' : 'unknown' }) : providerDiagnostic('plugins', { version: '2.2.5' });
  }
 }
 const directory = mkdtempSync(join(tmpdir(), 'sing-profile-')), f = new Fixture(() => {});
 await assert.rejects(f.selectProfile(directory, 'isolated', false), /explicitamente/);
 assert.equal((await f.selectProfile(directory, 'isolated', true)).selected, false);
 f.authenticated = true; assert.equal((await f.selectProfile(directory, 'isolated', true)).profile, 'isolated');
 assert.equal((await f.selectProfile(directory, 'normal', true)).profile, 'normal');
});
