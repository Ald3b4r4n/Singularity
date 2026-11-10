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
test('contributes a secondary side bar container with a webview view, both named "Sessões"', () => {
	const container = pkg.contributes.viewsContainers.secondarySidebar[0];
	assert.strictEqual(container.id, 'singularityAgents');
	assert.ok(fs.existsSync(path.join(root, container.icon)), 'container icon exists');
	const view = pkg.contributes.views[container.id][0];
	assert.strictEqual(view.type, 'webview');
	assert.ok(read('extension.js').includes(`'${view.id}'`), 'view id is registered in extension.js');
	assert.strictEqual(nls['container.title'], 'Sessões');
	assert.strictEqual(nls['view.name'], 'Sessões');
});

test('the execution policy of the implementer is chosen in the IDE, with an explicit confirmation for the modes that run commands', () => {
	const P = require('../executionPolicy.js'), code = read('executionPolicy.js');
	assert.deepStrictEqual(Object.keys(P.MODES), ['restricted', 'development', 'autonomous']);
	assert.strictEqual(P.describe(undefined).mode, 'restricted', 'no policy reads as restricted');
	assert.strictEqual(P.describe({ mode: 'whatever', external: true }).mode, 'restricted');
	assert.ok(/Implementador: Restrito/.test(P.describe({ mode: 'restricted', external: false }).text));
	assert.ok(/Desenvolvimento \+ publicação/.test(P.describe({ mode: 'development', external: true }).text));
	assert.ok(!/publicação/.test(P.describe({ mode: 'autonomous', external: false }).text));
	for (const mode of ['development', 'autonomous']) {
		assert.ok(/com a sua conta do Windows/.test(P.warning(mode, false)), 'says whose account runs the commands');
		assert.ok(/continuam não autorizadas/.test(P.warning(mode, false)) && /não uma garantia/.test(P.warning(mode, false)), 'says the external block is not a guarantee');
		assert.ok(/git push, deploy/.test(P.warning(mode, true)));
		assert.ok(/Revisor e o Testador continuam sem terminal/.test(P.warning(mode, true)));
	}
	assert.ok(/uma pasta não é uma barreira de segurança/.test(P.warning('development', false)), 'a working copy is not presented as a sandbox');
	assert.ok(/sem pedir aprovação/.test(P.warning('autonomous', false)));
	assert.ok(code.includes("showWarningMessage(") && code.includes('modal: true') && code.includes("if (answer !== accept) { return; }"), 'a mode that runs commands is never set without the modal answer');
	assert.ok(code.includes("confirm: true") && (code.match(/policy\.set/g) || []).length === 1, 'one place sets the policy, and it sends the confirmation');
	assert.ok(pkg.contributes.commands.some(c => c.command === 'singularity.agents.executionPolicy'));
});

test('every contributed command is registered, and every %key% exists in package.nls.json', () => {
	const source = read('extension.js') + read('remote.js') + read('executionPolicy.js');
	for (const c of pkg.contributes.commands) { assert.ok(source.includes(`'${c.command}'`), `${c.command} registered`); }
	const keys = [...JSON.stringify(pkg).matchAll(/"%([^%"]+)%"/g)].map(m => m[1]);
	assert.ok(keys.length > 0);
	for (const k of keys) { assert.ok(k in nls, `missing nls key ${k}`); }
});

test('the command palette entry reads "Singularity: Abrir Agentes"', () => {
	const open = pkg.contributes.commands.find(c => c.command === 'singularity.agents.open');
	assert.strictEqual(`${open.category}: ${nls['command.open']}`, 'Singularity: Abrir Agentes');
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

test('the model selector includes each inference backend and preserves the catalog default', () => {
	const sel = R.resolve(catalog, {});
	assert.deepStrictEqual(sel.models.map(m => [m.providerID, m.id]), [['opencode', 'plain'], ['opencode', 'thinker'], ['vercel', 'alpha'], ['vercel', 'beta']]);
	assert.strictEqual(sel.model.providerID, 'vercel');
	assert.strictEqual(sel.model.id, 'beta');
	assert.strictEqual(sel.canSend, true);
	const duplicate = { ...catalog, providers: [{ id: 'another', models: [{ id: 'beta', name: 'Beta', efforts: ['low'] }] }, ...catalog.providers] };
	assert.equal(R.resolve(duplicate, { providerID: 'another', modelID: 'beta' }).model.providerID, 'another');
	assert.equal(new Set(R.resolve(duplicate, {}).models.map(m => m.key)).size, 5);
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

test('without a catalog nothing can be sent and no option is invented', () => {
	for (const empty of [undefined, null, {}, { services: [], providers: [] }]) {
		const sel = R.resolve(empty, { providerID: 'vercel', modelID: 'alpha' });
		assert.strictEqual(sel.canSend, false);
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

test('one composer: one prompt box, one send button, three selectors, and no second conversation area', () => {
	assert.strictEqual((shell.match(/<textarea/g) || []).length, 1);
	assert.strictEqual((shell.match(/type="submit"/g) || []).length, 1);
	for (const id of ['service', 'model', 'effort']) { assert.ok(new RegExp(`<select id="${id}"`).test(shell), id); }
	const labels = text(shell);
	for (const label of ['Provedor', 'Modelo', 'Esforço', 'Enviar']) { assert.ok(labels.includes(label), label); }
	assert.ok(!/<textarea/.test(R.renderTarget({ hub: { status: 'connected' }, sessions: [{ id: '1', harness: 'opencode', status: 'idle', workspace: 'C:\\w' }] }, catalog)), 'sessions carry no prompt box of their own');
});

test('every control has its own label (a label that wraps two controls would focus the wrong one)', () => {
	for (const id of ['service', 'model', 'effort', 'prompt']) {
		assert.ok(new RegExp(`<label for="${id}">[^<]+</label>`).test(shell), `label for #${id}`);
	}
	for (const wrapped of shell.match(/<label\b[^>]*>[\s\S]*?<\/label>/g) || []) {
		assert.ok(!/<(select|input|textarea)\b/.test(wrapped), 'a label must not wrap a control: ' + wrapped.slice(0, 60));
	}
});

test('Singularity is the orchestrator: no "Harness:" label, and no Copilot or Chat wording', () => {
	const everything = shell + R.renderTarget({ sessions: [] }) + read('media/main.js') + read('extension.js');
	assert.ok(!/Harness:/i.test(everything), 'the user never sees "Harness: OpenCode"');
	assert.ok(!/copilot/i.test(shell + read('media/main.js')), 'no Copilot wording in the page');
});

test('empty state shows the welcome message and the Hub state is independent', () => {
	const empty = R.renderTarget({ sessions: [] });
	assert.match(empty, /Crie uma tarefa para um agente/);
	assert.doesNotMatch(empty, /<button/);
	assert.match(R.hubLine({ hub: { status: 'weird' } }), /não conectado/);
	assert.match(R.hubLine({ hub: { status: 'connected' } }), /state-connected/);
});

test('each session shows its service, the model it really runs, the effort, the workspace and its state', () => {
	const html = R.renderTarget({ hub: { status: 'connected' }, sessions: [{
		id: 's1', harness: 'opencode', status: 'running', workspace: 'C:\\work\\project', prompt: 'a real task', result: 'partial output',
		model: { providerID: 'vercel', modelID: 'alpha', variant: 'high' }
	}] }, catalog, 's1');
	const t = text(html);
	assert.ok(/OpenCode/.test(t) && /em execução/.test(t) && /Vercel · Alpha/.test(t) && /Alto/.test(t) && /project/.test(t) && /partial output/.test(t) && /a real task/.test(t), t);
	assert.match(html, /class="session target"/);
	assert.doesNotMatch(html, /data-action="stop"/);
	assert.ok(/<svg class="gl"/.test(html), 'the state has a shape as well as a color');
});

test('a session without a known model says so instead of inventing one', () => {
	assert.ok(text(R.renderTarget({ hub: { status: 'connected' }, sessions: [{ id: 's', harness: 'opencode', status: 'idle' }] }, catalog, 's')).includes('modelo padrão do serviço'));
	assert.strictEqual(R.modelLabel(catalog, { providerID: 'zzz', modelID: 'yyy' }), 'zzz · yyy');
});

test('everything that comes from state is escaped', () => {
	const html = R.renderTarget({ hub: { status: 'connected' }, sessions: [{
		id: '"><img src=x onerror=alert(1)>', harness: '<b>x</b>', status: 'waiting', workspace: '<w>', summary: '<i>s</i>', result: '<script>unsafe</script>',
		model: { providerID: '<p>', modelID: '<m>', variant: '<v>' }
	}], events: [{ sessionId: '"><img src=x onerror=alert(1)>', name: '<e>' }] }, undefined, '"><img src=x onerror=alert(1)>');
	assert.match(html, /&lt;script&gt;unsafe/);
	assert.ok(!/<img|<script|<b>|<w>|<i>|<m>|<v>|<e>/.test(html), html);
});

test('fenced code in a response stays readable and escaped while streaming', () => {
	const session = { id: 's', harness: 'opencode', status: 'running', prompt: 'Uma tarefa', result: 'Resposta\n```python\nprint("<script>")' };
	const html = R.renderTarget({ sessions: [session] }, catalog, 's');
	assert.match(html, /message-user/);
	assert.match(html, /message-agent/);
	assert.match(html, /<pre><code>print\(&quot;&lt;script&gt;&quot;\)<\/code><\/pre>/);
	assert.doesNotMatch(html, /<script>/);
});

test('the user bubble displays the public profile and falls back without a safe avatar', () => {
	const state = { sessions: [{ id: 's', harness: 'opencode', status: 'done', prompt: 'Oi' }] };
	const render = profile => R.renderTarget(state, catalog, 's', [], profile);
	assert.match(render({ name: 'Ana & Rui', avatar: 'data:image/png;base64,AAAA' }), /Ana &amp; Rui/);
	assert.match(render({ name: 'Ana', avatar: 'data:image/png;base64,AAAA' }), /<img src="data:image\/png;base64,AAAA"/);
	assert.doesNotMatch(render({ name: 'Ana', avatar: 'data:image/svg+xml;base64,AAAA' }), /<img/);
	assert.match(render(), /<h2>Você<\/h2>/);
});

test('internal events stay out of the conversation', () => {
	const html = R.renderTarget({ hub: { status: 'connected' }, sessions: [{ id: 's1', harness: 'opencode', status: 'running' }], events: [{ sessionId: 's1', name: 'session.execution.started' }, { sessionId: 'other', name: 'unrelated' }] }, catalog, 's1');
	assert.doesNotMatch(html, /session.execution.started|unrelated/);
});

test('the page keeps what is typed: the composer is drawn once and sessions are drawn apart', () => {
	const main = read('media/main.js').replace(/\/\/.*$/gm, '');
	assert.ok(/app\.innerHTML = R\.shell\(\)/.test(main));
	assert.ok(!/composer\.innerHTML|prompt\.innerHTML|prompt\.value = ''(?![\s\S]*'sent')/.test(main) || /data\.type === 'sent'/.test(main));
	assert.ok(/el\.sessions\.innerHTML = /.test(main), 'only the sessions are redrawn');
	assert.match(main, /setState\(\{ targetId, draft: el.prompt.value, drafts:/);
	assert.match(main, /let state = \{ hub: \{ status: 'disconnected' \}/);
});

test('the session in use survives an update that does not list it yet, and a send never creates a session silently', () => {
	const main = read('media/main.js');
	assert.ok(main.includes('targetSeen') && main.includes('targetSeen && connected()'), 'the session in use is dropped only if it was seen and the Hub is connected');
	const ext = read('extension.js');
	assert.ok(ext.includes('if (id && (!existing || existing.historical || existing.recovery))') && ext.includes('não existe mais no Hub'), 'a missing session in use is an error, never a new session');
});

test('the right view only navigates; the central editor shows the selected result', () => {
	const state = { sessions: [{ id: 's1', harness: 'opencode', status: 'done', workspace: 'C:/demo', result: 'first result' }, { id: 's2', harness: 'opencode', status: 'idle', result: 'other result' }] };
	assert.match(R.renderNavigation(state.sessions, catalog, 's1'), /aria-current="true"/);
	assert.doesNotMatch(R.renderNavigation(state.sessions, catalog, 's1'), /textarea|first result|other result/);
	assert.match(R.renderTarget(state, catalog, 's1'), /first result/);
	assert.doesNotMatch(R.renderTarget(state, catalog, 's1'), /other result/);
});

// --- Claude Code as a second provider ---
const claudeCatalog = {
	services: [
		{ id: 'opencode', name: 'OpenCode', status: 'available' },
		{ id: 'claude-code', name: 'Claude Code', status: 'available' },
		{ id: 'codex-cli', name: 'Codex CLI', status: 'planned' },
		{ id: 'gemini-cli', name: 'Gemini CLI', status: 'planned' },
	],
	service: 'claude-code',
	providers: [{ id: 'claude-code', name: 'Claude Code', models: ['fable', 'opus', 'sonnet'].map(id => ({ id, name: id[0].toUpperCase() + id.slice(1), efforts: ['low', 'medium', 'high', 'xhigh', 'max'] })) }],
	default: { providerID: 'claude-code', modelID: 'sonnet' },
	hiddenModels: 0,
};

test('Claude Code is selectable when the Hub says it is available; Codex CLI and Gemini CLI stay "em breve"', () => {
	const sel = R.resolve(claudeCatalog, { service: 'claude-code' });
	assert.strictEqual(sel.service, 'claude-code');
	assert.deepStrictEqual(sel.services.map(s => [s.id, s.status]), [['opencode', 'available'], ['claude-code', 'available'], ['codex-cli', 'planned'], ['gemini-cli', 'planned']]);
	assert.strictEqual(R.SERVICE_NOTE.planned, ' (em breve)');
	assert.deepStrictEqual(sel.models.map(m => m.id), ['fable', 'opus', 'sonnet']);
	assert.strictEqual(sel.model.id, 'sonnet');
	assert.deepStrictEqual(sel.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
	assert.strictEqual(sel.canSend, true);
});

test('switching provider shows the models and efforts of that provider only', () => {
	assert.deepStrictEqual(R.resolve({ ...catalog, services: claudeCatalog.services }, { service: 'opencode' }).models.map(m => m.id), ['plain', 'thinker', 'alpha', 'beta']);
	// the catalog on hand belongs to the other provider: nothing is offered until the Hub answers for the chosen one
	const waiting = R.resolve({ ...catalog, services: claudeCatalog.services }, { service: 'claude-code' });
	assert.strictEqual(waiting.service, 'claude-code');
	assert.deepStrictEqual(waiting.models, []);
	assert.strictEqual(waiting.canSend, false);
});

test('a Claude Code session is labelled with its provider, its real model and its permissions', () => {
	const state = { hub: { status: 'connected' }, sessions: [{ id: 'c1', harness: 'claude-code', status: 'done', workspace: 'C:/w', permissionMode: 'acceptEdits', model: { providerID: 'claude-code', modelID: 'claude-sonnet-5-5', variant: 'low' } }] };
	const html = text(R.renderTarget(state, claudeCatalog, 'c1'));
	assert.match(html, /Claude Code/);
	assert.match(html, /claude-sonnet-5-5/);
	assert.match(html, /Baixo/);
	assert.match(html, /Permissões: Aceitar edições de arquivos/);
	// the other provider's catalog is the one on hand: names still resolve
	assert.match(text(R.modelLabel(catalog, state.sessions[0].model)), /Claude Code · claude-sonnet-5-5/);
	assert.doesNotMatch(R.renderTarget({ ...state, sessions: [{ ...state.sessions[0], harness: 'opencode' }] }, catalog, 'c1'), /Permissões/);
});

test('an archived Claude Code session can be reopened; an OpenCode one cannot, and neither can one that never started', () => {
	const archived = { id: 'a1', harness: 'claude-code', status: 'idle', historical: true, resumable: true, workspace: 'C:/w' };
	assert.match(R.renderNavigation([archived], claudeCatalog, undefined, 'C:/w'), /data-action="reopen" data-id="a1"/);
	assert.doesNotMatch(R.renderNavigation([{ ...archived, harness: 'opencode' }], claudeCatalog), /reopen/);
	assert.doesNotMatch(R.renderNavigation([{ ...archived, resumable: false }], claudeCatalog), /reopen/);
	assert.doesNotMatch(R.renderNavigation([{ ...archived, historical: false }], claudeCatalog), /reopen/);
});

test('the composer offers permissions only where the provider has them, never a bypass, and a session never changes provider', () => {
	assert.match(R.shell(), /id="permission-field" hidden/);
	assert.deepStrictEqual(R.PERMISSIONS.map(p => p.value), ['', 'plan', 'acceptEdits']);
	assert.ok(!R.PERMISSIONS.some(p => /bypass|auto|dontAsk|skip/i.test(p.value + p.label)));
	const ext = read('extension.js');
	assert.ok(ext.includes('existing.harness !== service') && ext.includes('outro provedor'), 'a send never moves a session to another provider');
	assert.ok(ext.includes("value === 'plan' || value === 'acceptEdits'"), 'only the two safe modes can be requested from the panel');
	const main = read('media/main.js');
	assert.ok(main.includes('crossed'), 'the composer blocks a send to a session of another provider');
});

// --- Codex CLI as the third provider ---
const codexCatalog = {
	services: [
		{ id: 'opencode', name: 'OpenCode', status: 'available' },
		{ id: 'claude-code', name: 'Claude Code', status: 'available' },
		{ id: 'codex-cli', name: 'Codex CLI', status: 'available' },
		{ id: 'gemini-cli', name: 'Gemini CLI', status: 'planned' },
	],
	service: 'codex-cli',
	providers: [{ id: 'codex-cli', name: 'Codex CLI', models: [
		{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
		{ id: 'gpt-6-luna', name: 'GPT-6-Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
	] }],
	default: { providerID: 'codex-cli', modelID: 'gpt-6.1-sol' },
	hiddenModels: 0,
};

test('Codex CLI is selectable when the Hub says it is available; only Gemini CLI stays "em breve"', () => {
	const sel = R.resolve(codexCatalog, { service: 'codex-cli' });
	assert.strictEqual(sel.service, 'codex-cli');
	assert.deepStrictEqual(sel.services.map(s => [s.id, s.status]), [['opencode', 'available'], ['claude-code', 'available'], ['codex-cli', 'available'], ['gemini-cli', 'planned']]);
	assert.deepStrictEqual(sel.models.map(m => m.id), ['gpt-6.1-sol', 'gpt-6-luna']);
	assert.deepStrictEqual(sel.efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], "the efforts are the model own levels, down to the last one");
	assert.strictEqual(R.resolve(codexCatalog, { providerID: 'codex-cli', modelID: 'gpt-6-luna' }).efforts.includes('ultra'), false);
	assert.strictEqual(R.effortLabel('ultra'), 'Ultra');
});

test('each provider has its own permission choices, none with a bypass; a stale choice falls back to the default', () => {
	assert.deepStrictEqual(R.permissionOptions('codex-cli').map(p => p.value), ['', 'workspace-write']);
	assert.deepStrictEqual(R.permissionOptions('claude-code').map(p => p.value), ['', 'plan', 'acceptEdits']);
	assert.deepStrictEqual(R.permissionOptions('opencode'), []);
	for (const service of ['codex-cli', 'claude-code']) {
		assert.ok(!R.permissionOptions(service).some(p => /bypass|danger|full-access|dontAsk|auto/i.test(p.value + p.label)));
	}
	assert.strictEqual(R.validPermission('codex-cli', 'acceptEdits'), '');
	assert.strictEqual(R.validPermission('claude-code', 'workspace-write'), '');
	assert.strictEqual(R.validPermission('codex-cli', 'workspace-write'), 'workspace-write');
	const ext = read('extension.js');
	assert.ok(ext.includes("service === 'codex-cli' && value === 'workspace-write'"), 'only the one safe Codex mode can be requested from the panel');
	assert.ok(!/danger-full-access|bypass/i.test(ext.replace(/\/\/.*$/gm, '')), 'the panel never names a bypass');
});

test('a Codex CLI session is labelled with its provider, the requested model, the effort and its sandbox', () => {
	const state = { hub: { status: 'connected' }, sessions: [
		{ id: 'x1', harness: 'codex-cli', status: 'done', workspace: 'C:/w', permissionMode: 'workspace-write', model: { providerID: 'codex-cli', modelID: 'gpt-6-luna', variant: 'low' } },
		{ id: 'x2', harness: 'codex-cli', status: 'idle', workspace: 'C:/w', permissionMode: 'read-only', model: { providerID: 'codex-cli', modelID: 'gpt-6-luna' } },
	] };
	assert.match(text(R.renderTarget(state, codexCatalog, 'x1')), /Codex CLI · GPT-6-Luna/);
	assert.match(text(R.renderTarget(state, codexCatalog, 'x1')), /Permissões: Escrever no workspace/);
	assert.match(text(R.renderTarget(state, codexCatalog, 'x2')), /Permissões: Somente leitura/);
	assert.match(R.modelLabel(catalog, { providerID: 'codex-cli', modelID: 'gpt-x' }), /Codex CLI · gpt-x/);
});

test('an archived Codex CLI session can be reopened when its conversation exists', () => {
	const archived = { id: 'k1', harness: 'codex-cli', status: 'idle', historical: true, resumable: true, workspace: 'C:/w' };
	assert.match(R.renderNavigation([archived], codexCatalog, undefined, 'C:/w'), /data-action="reopen" data-id="k1"/);
	assert.doesNotMatch(R.renderNavigation([{ ...archived, resumable: false }], codexCatalog), /reopen/);
});

test('the page never touches settings, headers or keys', () => {
	const code = (read('media/main.js') + read('media/render.js') + read('extension.js')).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
	assert.ok(!/\.settings\b|\.headers\b|apiKey|api_key|secret/i.test(code));
});

console.log(`ok: ${n} checks`);
