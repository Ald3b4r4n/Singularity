// Run: node test/run.cjs
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const nls = JSON.parse(read('package.nls.json'));
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// --- manifest ---
test('contributes a secondary side bar container with a webview view, both named "Agentes"', () => {
	const container = pkg.contributes.viewsContainers.secondarySidebar[0];
	assert.strictEqual(container.id, 'singularityAgents');
	assert.ok(fs.existsSync(path.join(root, container.icon)), 'container icon exists');
	const view = pkg.contributes.views[container.id][0];
	assert.strictEqual(view.type, 'webview');
	assert.ok(read('extension.js').includes(`'${view.id}'`), 'view id is registered in extension.js');
	assert.strictEqual(nls['container.title'], 'Agentes');
	assert.strictEqual(nls['view.name'], 'Agentes');
});

test('every contributed command is registered, and every %key% exists in package.nls.json', () => {
	const source = read('extension.js');
	for (const c of pkg.contributes.commands) { assert.ok(source.includes(`'${c.command}'`), `${c.command} registered`); }
	const keys = [...JSON.stringify(pkg).matchAll(/"%([^%"]+)%"/g)].map(m => m[1]);
	assert.ok(keys.length > 0);
	for (const k of keys) { assert.ok(k in nls, `missing nls key ${k}`); }
});

test('the command palette entry reads "Singularity: Abrir painel de agentes"', () => {
	const open = pkg.contributes.commands.find(c => c.command === 'singularity.agents.open');
	assert.strictEqual(`${open.category}: ${nls['command.open']}`, 'Singularity: Abrir painel de agentes');
});

test('no network code, no remote URLs and a strict CSP', () => {
	const files = ['extension.js', 'selection.js', 'hub.js', 'hubClient.js', 'media/render.js', 'media/main.js', 'media/agents.css'];
	for (const f of files) {
		const code = read(f)
			.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '');
		assert.ok(!/https?:\/\//.test(code), `${f} contains a URL`);
		assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|require\(['"](?:https?|net|child_process)['"]\))/.test(code), `${f} uses network or process APIs`);
	}
	const ext = read('extension.js');
	assert.ok(ext.includes("default-src 'none'"));
	assert.ok(!ext.includes('unsafe-inline') && !ext.includes('unsafe-eval'));
});

// --- hub seam ---
test('the placeholder Hub client is disconnected, empty and refuses to connect', async () => {
	const { DisconnectedHubClient } = require('../hub.js');
	const c = new DisconnectedHubClient();
	assert.strictEqual(c.getState().hub.status, 'disconnected');
	assert.deepStrictEqual([...c.getState().sessions], []);
	assert.ok(Object.isFrozen(c.getState()));
	assert.strictEqual(typeof c.onDidChange(() => { }), 'function');
	let rejected = false;
	await c.connect().catch(() => { rejected = true; });
	assert.ok(rejected);
});

test('the real client never exposes credentials and degrades to an error state without the Hub package', () => {
	const { RealHubClient } = require('../hubClient.js');
	const c = new RealHubClient({});
	assert.ok(!/token|bearer|authorization/i.test(JSON.stringify(c.getState())));
	assert.ok(['disconnected', 'error'].includes(c.getState().hub.status));
	assert.strictEqual(typeof c.catalog, 'function', 'the client can ask the Hub for the catalog');
	c.dispose();
});

test('hub commands and settings are declared and registered', () => {
	const ids = pkg.contributes.commands.map(c => c.command);
	for (const id of ['singularity.hub.start', 'singularity.hub.stop']) {
		assert.ok(ids.includes(id) && read('extension.js').includes(`'${id}'`), id);
	}
	assert.ok('singularity.agents.hub.autoStart' in pkg.contributes.configuration.properties);
	assert.strictEqual(pkg.contributes.configuration.properties['singularity.agents.hub.nodePath'].scope, 'machine');
});

// --- the choice of service, provider, model and effort ---
const R = require('../media/render.js');
const catalog = {
	services: [
		{ id: 'opencode', name: 'OpenCode', status: 'available' },
		{ id: 'claude-code', name: 'Claude Code', status: 'planned' },
		{ id: 'codex-cli', name: 'Codex CLI', status: 'planned' },
		{ id: 'gemini-cli', name: 'Gemini CLI', status: 'planned' },
	],
	service: 'opencode',
	providers: [
		{ id: 'opencode', name: 'Default / OpenCode', models: [
			{ id: 'plain', name: 'Plain', efforts: [] },
			{ id: 'thinker', name: 'Thinker', efforts: ['low', 'medium', 'high', 'xhigh'] },
		] },
		{ id: 'vercel', name: 'Vercel', models: [
			{ id: 'alpha', name: 'Alpha', efforts: ['none', 'high'] },
			{ id: 'beta', name: 'Beta', efforts: ['minimal', 'max', 'custom-level'] },
		] },
	],
	default: { providerID: 'vercel', modelID: 'beta' },
	hiddenModels: 0,
};

test('only a service with a working adapter is selectable; planned services are listed but never chosen', () => {
	const sel = R.resolve(catalog, { service: 'claude-code' });
	assert.strictEqual(sel.service, 'opencode');
	assert.deepStrictEqual(sel.services.map(s => s.status), ['available', 'planned', 'planned', 'planned']);
	assert.strictEqual(R.resolve({ services: [{ id: 'opencode', name: 'OpenCode', status: 'unavailable' }], providers: [] }, {}).service, undefined);
	assert.strictEqual(R.resolve({ services: [{ id: 'opencode', name: 'OpenCode', status: 'unavailable' }], providers: [] }, {}).canSend, false);
});

test('providers come from the catalog, and the default model is preselected when nothing was chosen', () => {
	const sel = R.resolve(catalog, {});
	assert.deepStrictEqual(sel.providers.map(p => p.id), ['opencode', 'vercel']);
	assert.strictEqual(sel.provider.id, 'vercel');
	assert.strictEqual(sel.model.id, 'beta');
	assert.strictEqual(sel.canSend, true);
});

test('changing the provider updates the models; a model of another provider is never kept', () => {
	const sel = R.resolve(catalog, { service: 'opencode', providerID: 'opencode', modelID: 'alpha' });
	assert.strictEqual(sel.provider.id, 'opencode');
	assert.deepStrictEqual(sel.models.map(m => m.id), ['plain', 'thinker']);
	assert.strictEqual(sel.model.id, 'plain', 'alpha belongs to vercel: it falls back to the first model of the provider');
});

test('changing the model updates the effort options; the levels are the model\'s own', () => {
	assert.deepStrictEqual(R.resolve(catalog, { providerID: 'opencode', modelID: 'thinker' }).efforts, ['low', 'medium', 'high', 'xhigh']);
	assert.deepStrictEqual(R.resolve(catalog, { providerID: 'vercel', modelID: 'alpha' }).efforts, ['none', 'high']);
});

test('a model without effort control offers none, and a stale effort is cleared, never invented', () => {
	const plain = R.resolve(catalog, { providerID: 'opencode', modelID: 'plain', variant: 'high' });
	assert.deepStrictEqual(plain.efforts, []);
	assert.strictEqual(plain.effort, '');
	const stale = R.resolve(catalog, { providerID: 'vercel', modelID: 'alpha', variant: 'max' });
	assert.strictEqual(stale.effort, '', 'alpha has no "max"');
	assert.strictEqual(R.resolve(catalog, { providerID: 'vercel', modelID: 'alpha', variant: 'high' }).effort, 'high');
});

test('effort labels: known levels are named, any other level is shown as the service gave it', () => {
	assert.deepStrictEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(R.effortLabel), ['Nenhum', 'Mínimo', 'Baixo', 'Médio', 'Alto', 'Extra alto', 'Máximo']);
	assert.strictEqual(R.effortLabel('custom-level'), 'custom-level');
	assert.strictEqual(R.effortLabel('constructor'), 'constructor', 'no prototype lookup');
});

test('filtering the models never hides the selected one', () => {
	const sel = R.resolve(catalog, { providerID: 'vercel', modelID: 'beta' }, 'alp');
	assert.deepStrictEqual(sel.models.map(m => m.id), ['alpha', 'beta']);
	assert.strictEqual(sel.totalModels, 2);
});

test('without a catalog nothing can be sent and no option is invented', () => {
	for (const empty of [undefined, null, {}, { services: [], providers: [] }]) {
		const sel = R.resolve(empty, { providerID: 'vercel', modelID: 'alpha' });
		assert.strictEqual(sel.canSend, false);
		assert.deepStrictEqual(sel.providers, []);
		assert.deepStrictEqual(sel.models, []);
	}
});

test('the model choice sent to the Hub is reduced to three short strings', () => {
	const { selectionOf, same } = require('../selection.js');
	assert.deepStrictEqual(selectionOf({ providerID: 'a', modelID: 'b', variant: 'high', apiKey: 'x', settings: {} }), { providerID: 'a', modelID: 'b', variant: 'high' });
	assert.deepStrictEqual(selectionOf({ providerID: 'a', modelID: 'b', variant: '' }), { providerID: 'a', modelID: 'b' });
	for (const bad of [undefined, null, 'x', {}, { providerID: 'a' }, { providerID: 'a', modelID: 'b'.repeat(300) }]) { assert.strictEqual(selectionOf(bad), undefined); }
	assert.ok(same({ providerID: 'a', modelID: 'b' }, { providerID: 'a', modelID: 'b', variant: '' }));
	assert.ok(!same({ providerID: 'a', modelID: 'b', variant: 'low' }, { providerID: 'a', modelID: 'b', variant: 'high' }));
	assert.ok(!same(undefined, { providerID: 'a', modelID: 'b' }));
});

// --- the page ---
const shell = R.shell();

test('one composer: one prompt box, one send button, four selectors, and no second conversation area', () => {
	assert.strictEqual((shell.match(/<textarea/g) || []).length, 1);
	assert.strictEqual((shell.match(/type="submit"/g) || []).length, 1);
	for (const id of ['service', 'provider', 'model', 'effort']) { assert.ok(new RegExp(`<select id="${id}"`).test(shell), id); }
	const labels = text(shell);
	for (const label of ['Serviço de agentes', 'Provedor', 'Modelo', 'Esforço', 'Workspace', 'Cancelar tarefa', 'Enviar']) { assert.ok(labels.includes(label), label); }
	assert.ok(!/<textarea/.test(R.renderSessions({ hub: { status: 'connected' }, sessions: [{ id: '1', harness: 'opencode', status: 'idle', workspace: 'C:\\w' }] }, catalog)), 'sessions carry no prompt box of their own');
});

test('every control has its own label (a label that wraps two controls would focus the wrong one)', () => {
	for (const id of ['service', 'provider', 'model', 'effort', 'prompt']) {
		assert.ok(new RegExp(`<label for="${id}">[^<]+</label>`).test(shell), `label for #${id}`);
	}
	for (const wrapped of shell.match(/<label\b[^>]*>[\s\S]*?<\/label>/g) || []) {
		assert.ok(!/<(select|input|textarea)\b/.test(wrapped), 'a label must not wrap a control: ' + wrapped.slice(0, 60));
	}
});

test('Singularity is the orchestrator: no "Harness:" label, and no Copilot or Chat wording', () => {
	const everything = shell + R.render({ hub: { status: 'connected' }, sessions: [] }) + read('media/main.js') + read('extension.js');
	assert.ok(!/Harness:/i.test(everything), 'the user never sees "Harness: OpenCode"');
	assert.ok(!/copilot/i.test(shell + read('media/main.js')), 'no Copilot wording in the page');
});

test('empty state: header, hub status and an honest explanation, nothing invented', () => {
	const off = R.render({ hub: { status: 'disconnected' }, sessions: [] }, undefined, undefined);
	assert.ok(off.includes('não conectado'));
	assert.ok(off.includes('Quando estiver disponível, suas sessões aparecerão aqui.'));
	assert.ok(!/<li\b/.test(off), 'no session items');
	assert.ok(!/\d+\s?%/.test(off), 'no progress percentages');
	assert.ok(!/state-connected|state-running/.test(off), 'no "connected" look when disconnected');
	const on = text(R.render({ hub: { status: 'connected' }, sessions: [] }));
	assert.ok(/Hub conectado/.test(on) && /Nenhuma sessão/.test(on) && !/não conectado/.test(on));
	assert.ok(R.render({ hub: { status: 'weird' }, sessions: [] }).includes('não conectado'), 'unknown status falls back to disconnected');
});

test('each session shows its service, the model it really runs, the effort, the workspace and its state', () => {
	const html = R.renderSessions({ hub: { status: 'connected' }, sessions: [{
		id: 's1', harness: 'opencode', status: 'running', workspace: 'C:\\work\\project', result: 'partial output',
		model: { providerID: 'vercel', modelID: 'alpha', variant: 'high' }
	}] }, catalog, 's1');
	const t = text(html);
	assert.ok(/OpenCode/.test(t) && /em execução/.test(t) && /Vercel · Alpha/.test(t) && /Alto/.test(t) && /project/.test(t) && /partial output/.test(t), t);
	assert.match(html, /class="session target"/);
	assert.match(html, /data-action="interrupt" data-id="s1">/, 'a running session can be cancelled');
	assert.match(html, /data-action="stop" data-id="s1"/);
	assert.ok(/<svg class="gl"/.test(html), 'the state has a shape as well as a color');
});

test('a session without a known model says so instead of inventing one', () => {
	assert.ok(text(R.renderSessions({ hub: { status: 'connected' }, sessions: [{ id: 's', harness: 'opencode', status: 'idle' }] }, catalog)).includes('modelo padrão do serviço'));
	assert.strictEqual(R.modelLabel(catalog, { providerID: 'zzz', modelID: 'yyy' }), 'zzz · yyy');
});

test('everything that comes from state is escaped', () => {
	const html = R.renderSessions({ hub: { status: 'connected' }, sessions: [{
		id: '"><img src=x onerror=alert(1)>', harness: '<b>x</b>', status: 'waiting', workspace: '<w>', summary: '<i>s</i>', result: '<script>unsafe</script>',
		model: { providerID: '<p>', modelID: '<m>', variant: '<v>' }
	}], events: [{ sessionId: '"><img src=x onerror=alert(1)>', name: '<e>' }] }, undefined);
	assert.ok(!/<img|<script|<b>|<w>|<i>|<p>|<m>|<v>|<e>/.test(html), html);
});

test('only another session\'s events are left out of a session', () => {
	const html = R.renderSessions({ hub: { status: 'connected' }, sessions: [{ id: 's1', harness: 'opencode', status: 'running' }], events: [{ sessionId: 's1', name: 'session.execution.started' }, { sessionId: 'other', name: 'unrelated' }] }, catalog);
	assert.ok(/session.execution.started/.test(html) && !/unrelated/.test(html));
});

test('the page keeps what is typed: the composer is drawn once and sessions are drawn apart', () => {
	const main = read('media/main.js').replace(/\/\/.*$/gm, '');
	assert.ok(/app\.innerHTML = R\.shell\(\)/.test(main));
	assert.ok(!/composer\.innerHTML|prompt\.innerHTML|prompt\.value = ''(?![\s\S]*'sent')/.test(main) || /data\.type === 'sent'/.test(main));
	assert.ok(/el\.sessions\.innerHTML = /.test(main), 'only the sessions are redrawn');
	assert.ok(!/getState\(|setState\(/.test(main), 'the webview never restores remembered state, so a stale "connected" cannot be shown');
});

test('the session in use survives an update that does not list it yet, and a send never creates a session silently', () => {
	const main = read('media/main.js');
	assert.ok(main.includes('targetSeen') && main.includes('targetSeen && connected()'), 'the session in use is dropped only if it was seen and the Hub is connected');
	const ext = read('extension.js');
	assert.ok(ext.includes('if (id && !existing)') && ext.includes('não existe mais no Hub'), 'a missing session in use is an error, never a new session');
});

test('the page never touches settings, headers or keys', () => {
	const code = (read('media/main.js') + read('media/render.js') + read('extension.js')).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
	assert.ok(!/\.settings\b|\.headers\b|apiKey|api_key|secret/i.test(code));
});

console.log(`ok: ${n} checks`);
