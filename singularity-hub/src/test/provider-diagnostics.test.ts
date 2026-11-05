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
});
