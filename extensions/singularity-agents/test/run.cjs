// Run: node test/run.cjs
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const nls = JSON.parse(read('package.nls.json'));
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// --- manifest ---
test('contributes a secondary side bar container with a webview view', () => {
	const container = pkg.contributes.viewsContainers.secondarySidebar[0];
	assert.strictEqual(container.id, 'singularityAgents');
	assert.ok(fs.existsSync(path.join(root, container.icon)), 'container icon exists');
	const view = pkg.contributes.views[container.id][0];
	assert.strictEqual(view.type, 'webview');
	assert.ok(read('extension.js').includes(`'${view.id}'`), 'view id is registered in extension.js');
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
	const files = ['extension.js', 'hub.js', 'hubClient.js', 'media/render.js', 'media/main.js', 'media/agents.css'];
	for (const f of files) {
		const text = read(f)
			.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '');
		assert.ok(!/https?:\/\//.test(text), `${f} contains a URL`);
		assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|require\(['"](?:https?|net|child_process)['"]\))/.test(text), `${f} uses network or process APIs`);
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
	const off = c.onDidChange(() => { });
	assert.strictEqual(typeof off, 'function');
	let rejected = false;
	await c.connect().catch(() => { rejected = true; });
	assert.ok(rejected);
});

// --- rendering ---
const { render } = require('../media/render.js');
const empty = render({ hub: { status: 'disconnected' }, sessions: [] });

test('empty state: header, hub status, explanation, and nothing invented', () => {
	assert.ok(empty.includes('SINGULARITY AGENTS'));
	assert.ok(empty.includes('não conectado'));
	assert.ok(empty.includes('Singularity Hub não conectado'));
	assert.ok(empty.includes('Quando estiver disponível, seus agentes e sessões aparecerão aqui.'));
	assert.ok(empty.includes('<span class="count">0</span>'));
	assert.ok(!/<li\b/.test(empty), 'no session items');
	assert.ok(!/\d+\s?%/.test(empty), 'no progress percentages');
	assert.ok(!/(Pausar|Parar|Aprovar|Recusar|Executar|Iniciar)/.test(empty), 'no simulated controls');
	assert.strictEqual((empty.match(/<button/g) || []).length, 1, 'only the settings button');
	assert.ok(!/state-connected|state-running/.test(empty), 'no "connected" look when disconnected');
});

test('status is carried by shape and text, not only by color', () => {
	for (const s of ['connected', 'running', 'waiting', 'done', 'failed', 'idle']) {
		const html = render({ hub: { status: 'connected' }, sessions: [{ id: 'x', harness: 'h', status: s }] });
		assert.ok(/<svg class="gl"/.test(html.split('class="session"')[1] || ''), `${s} has a glyph`);
	}
	assert.notStrictEqual(render({ hub: { status: 'connected' }, sessions: [] }), empty);
});

test('session data is rendered from state and escaped', () => {
	const html = render({ hub: { status: 'connected' }, sessions: [{ id: '1', harness: 'opencode', title: '<img src=x onerror=alert(1)>', status: 'waiting' }] });
	assert.ok(html.includes('opencode') && html.includes('aguardando aprovação'));
	assert.ok(!html.includes('<img'), 'title is escaped');
	assert.ok(html.includes('<span class="count">1</span>'));
});

test('unknown hub status falls back to disconnected', () => {
	assert.ok(render({ hub: { status: 'weird' }, sessions: [] }).includes('não conectado'));
});

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('connected hub with zero sessions reads "Hub conectado" and "SESSÕES 0"', () => {
	const t = text(render({ hub: { status: 'connected' }, sessions: [] }));
	assert.ok(/Hub conectado/.test(t), t);
	assert.ok(/SESSÕES 0/.test(t), t);
	assert.ok(!/não conectado/.test(t), 'no "not connected" text while connected');
});

test('the webview never restores remembered state, so a stale "connected" cannot be shown', () => {
	const main = read('media/main.js').replace(/\/\/.*$/gm, '');
	assert.ok(!/getState\(|setState\(/.test(main));
});

test('the real client never exposes credentials and degrades to an error state without the Hub package', () => {
	const { RealHubClient } = require('../hubClient.js');
	const c = new RealHubClient({});
	const s = JSON.stringify(c.getState());
	assert.ok(!/token|bearer|authorization/i.test(s), s);
	assert.ok(['disconnected', 'error'].includes(c.getState().hub.status));
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

console.log(`ok: ${n} checks`);
