// Singularity Remote: the phone client. Plain JavaScript, no dependency, no third-party origin, no analytics.
// Data coming from the computer is only ever put on the page with textContent: it is never parsed as HTML.
(function () {
	'use strict';
	const TOKEN_KEY = 'singularity.remote.token';
	const VIEW_KEY = 'singularity.remote.view';
	const $ = id => document.getElementById(id);
	const view = $('view'), tabs = $('tabs'), link = $('link'), toastBox = $('toast');

	const STATUS = { running: ['em execução', 'warn'], waiting: ['aguardando', 'warn'], done: ['concluída', 'ok'], failed: ['falhou', 'bad'], idle: ['ociosa', ''] };
	const EFFORT = { none: 'Nenhum', minimal: 'Mínimo', low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Extra alto', max: 'Máximo', ultra: 'Ultra' };
	const PERMISSIONS = {
		'claude-code': [['', 'Padrão (nega o que pedir aprovação)'], ['plan', 'Somente planejar'], ['acceptEdits', 'Aceitar edições de arquivos']],
		'codex-cli': [['', 'Somente leitura (padrão)'], ['workspace-write', 'Escrever no workspace']]
	};
	const SERVICE_NAME = { opencode: 'OpenCode', 'claude-code': 'Claude Code', 'codex-cli': 'Codex CLI', 'gemini-cli': 'Gemini CLI' };
	const ICONS = {
		home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
		agents: 'M12 3v4m-6 4h12a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2zm3 3v2m6-2v2',
		sessions: 'M4 5h16M4 12h16M4 19h10',
		compare: 'M8 4v16M16 4v16M3 8h5m8 8h5',
		team: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7 1a2.5 2.5 0 1 0 0-5M3 20a6 6 0 0 1 12 0m1-5a5 5 0 0 1 5 5',
		devices: 'M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm4 15h2'
	};
	const SCREENS = [['home', 'Início'], ['agents', 'Agentes'], ['sessions', 'Sessões'], ['compare', 'Comparação'], ['team', 'Equipe'], ['devices', 'Dispositivos']];

	let token = safeGet(TOKEN_KEY);
	let screen = safeGet(VIEW_KEY) || 'home';
	let status, sessions = [], openSession, catalog, comparisons, teams, lastSeq = 0, streaming = false, pollTimer;
	let agentsForm = { workspaceId: '', service: '', model: '', effort: '', permission: '', text: '' };
	let sending = false;

	function safeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
	function safeSet(key, value) { try { if (value === null) { localStorage.removeItem(key); } else { localStorage.setItem(key, value); } } catch { /* storage may be blocked: the app then asks to pair again */ } }

	// ---------- tiny DOM helpers (no innerHTML anywhere) ----------
	function h(tag, attrs, ...children) {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(attrs || {})) {
			if (value === undefined || value === null || value === false) { continue; }
			if (key === 'class') { node.className = value; } else if (key.startsWith('on')) { node.addEventListener(key.slice(2), value); } else if (key === 'text') { node.textContent = value; } else { node.setAttribute(key, value === true ? '' : String(value)); }
		}
		for (const child of children.flat()) { if (child !== undefined && child !== null && child !== false) { node.append(child.nodeType ? child : document.createTextNode(String(child))); } }
		return node;
	}
	// replaceChildren would turn a null into the text "null": only real nodes reach the page
	function show(...nodes) { view.replaceChildren(...nodes.flat().filter(node => node && node.nodeType)); }
	function icon(name) {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', ICONS[name]); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.8'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
		svg.append(path);
		return svg;
	}
	function toast(message) {
		toastBox.textContent = message; toastBox.hidden = false;
		clearTimeout(toast.timer);
		toast.timer = setTimeout(() => { toastBox.hidden = true; }, 4500);
	}
	const chip = (text, kind) => h('span', { class: 'chip ' + (kind || '') }, h('span', { class: 'dot' + (kind ? '' : ' hollow') }), text);
	const statusChip = value => { const [label, kind] = STATUS[value] || [value, '']; return chip(label, kind); };
	const when = value => value ? new Date(value).toLocaleString('pt-BR') : '';
	const modelText = model => model ? (model.providerID === 'opencode-go' ? 'Go · ' : model.providerID === 'opencode' ? 'Zen · ' : '') + model.modelID + (model.variant ? ' · ' + (EFFORT[model.variant] || model.variant) : '') : 'modelo padrão';
	const requestId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40).padEnd(8, '0');

	// ---------- API ----------
	async function api(path, options = {}) {
		const headers = { ...(options.headers || {}) };
		if (token) { headers.Authorization = 'Bearer ' + token; }
		if (options.body !== undefined) { headers['Content-Type'] = 'application/json'; }
		let response;
		try {
			response = await fetch(path, { method: options.method || 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
		} catch {
			link.textContent = 'sem conexão'; link.className = 'chip bad';
			throw new Error('Sem conexão com o computador.');
		}
		if (response.status === 401 && token) { forget(); throw new Error('Este dispositivo não está mais autorizado.'); }
		let data = {};
		try { data = await response.json(); } catch { /* an empty body */ }
		if (!response.ok) { throw new Error(data.error || 'Erro ' + response.status); }
		return data;
	}
	function forget() { token = null; safeSet(TOKEN_KEY, null); stopStream(); render(); }

	// ---------- events: SSE over fetch (so the token stays in a header), with polling as the fallback ----------
	async function startStream() {
		if (streaming || !token) { return; }
		streaming = true;
		try {
			const response = await fetch('/api/events?after=' + lastSeq, { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', credentials: 'omit' });
			if (!response.ok || !response.body) { throw new Error('stream'); }
			link.textContent = 'ao vivo'; link.className = 'chip ok';
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) { break; }
				buffer += decoder.decode(value, { stream: true });
				let index;
				while ((index = buffer.indexOf('\n\n')) >= 0) { handleFrame(buffer.slice(0, index)); buffer = buffer.slice(index + 2); }
			}
		} catch { /* reconnect below */ }
		streaming = false;
		if (token) { link.textContent = 'reconectando'; link.className = 'chip warn'; setTimeout(startStream, 2500); }
	}
	function stopStream() { streaming = false; clearInterval(pollTimer); }
	function handleFrame(frame) {
		let event = '', data = '';
		for (const line of frame.split('\n')) { if (line.startsWith('event: ')) { event = line.slice(7); } else if (line.startsWith('data: ')) { data += line.slice(6); } }
		if (event !== 'hub' || !data) { return; }
		let payload;
		try { payload = JSON.parse(data); } catch { return; }
		if (typeof payload.seq === 'number') { lastSeq = Math.max(lastSeq, payload.seq); }
		if (payload.session) {
			const index = sessions.findIndex(item => item.id === payload.session.id);
			if (index >= 0) { sessions[index] = payload.session; } else { sessions.push(payload.session); }
			if (openSession && openSession.id === payload.session.id) { openSession = payload.session; }
			if (screen === 'sessions' || screen === 'home') { render(); }
		}
	}

	// ---------- shell ----------
	function renderTabs() {
		tabs.hidden = !token;
		tabs.replaceChildren(...SCREENS.map(([key, label]) => h('button', { type: 'button', 'aria-current': screen === key ? 'page' : null, onclick: () => go(key) }, icon(key), label)));
	}
	function go(next) { screen = next; openSession = next === 'sessions' ? openSession : undefined; safeSet(VIEW_KEY, next); render(); }

	async function refresh() {
		if (!token) { return; }
		try {
			status = await api('/api/status');
			sessions = (await api('/api/sessions')).sessions;
			link.textContent = status.hub.connected ? 'ao vivo' : 'Hub desligado'; link.className = 'chip ' + (status.hub.connected ? 'ok' : 'bad');
			if (!agentsForm.workspaceId && status.workspaces[0]) { agentsForm.workspaceId = status.workspaces[0].id; }
		} catch (error) { if (token) { toast(error.message); } }
		render();
	}

	// The conversation follows the text as it grows, as long as the person is at the bottom; scrolling up pauses it and shows a button that goes back down.
	let follow = true;
	const nearBottom = () => document.documentElement.scrollHeight - (window.scrollY + window.innerHeight) < 160;
	const jump = h('button', { class: 'jump', type: 'button', hidden: true, 'aria-label': 'Ir para o fim da conversa', onclick: () => { follow = true; scrollToEnd(true); updateJump(); } }, '↓');
	document.body.appendChild(jump);
	function scrollToEnd(smooth) { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); }
	function updateJump() { jump.hidden = !(screen === 'sessions' && openSession && !follow); }
	window.addEventListener('scroll', () => { if (screen === 'sessions' && openSession) { follow = nearBottom(); updateJump(); } }, { passive: true });
	function afterSessionRender() { if (follow) { scrollToEnd(false); } updateJump(); }

	function render() {
		jump.hidden = true;
		renderTabs();
		if (!token) { return renderPairing(); }
		const screens = { home: renderHome, agents: renderAgents, sessions: renderSessions, compare: renderCompare, team: renderTeam, devices: renderDevices, usage: renderUsage };
		(screens[screen] || renderHome)();
	}

	// ---------- pairing ----------
	let pairing = { stage: 'form', message: '' };
	function renderPairing() {
		$('subtitle').textContent = 'Remote · pareamento';
		const code = h('input', { id: 'code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', inputmode: 'text', maxlength: '9', placeholder: 'ABCD-EFGH', 'aria-label': 'Código de pareamento' });
		const name = h('input', { id: 'device', autocomplete: 'off', maxlength: '40', value: 'Android', 'aria-label': 'Nome do aparelho' });
		if (pairing.stage === 'waiting') {
			show(h('section', { class: 'card pairing' }, h('h2', { text: 'Confirme no computador' }), h('p', { class: 'muted', text: 'No Singularity do Windows aparece uma pergunta de autorização. O código de verificação deve ser:' }), h('div', { class: 'big', text: pairing.fingerprint }), h('p', { class: 'muted', text: 'Só autorize se o código for igual.' }), h('button', { class: 'secondary', type: 'button', onclick: () => { pairing = { stage: 'form', message: '' }; render(); } }, 'Cancelar')));
			return;
		}
		show(h('section', { class: 'card stack' }, h('h2', { text: 'Parear com o computador' }), h('p', { class: 'muted', text: 'No Singularity do Windows use “Parear dispositivo Android” e digite aqui o código mostrado.' }),
			h('div', null, h('label', { for: 'code', text: 'Código' }), code), h('div', null, h('label', { for: 'device', text: 'Nome deste aparelho' }), name),
			pairing.message ? h('p', { class: 'chip bad', role: 'alert', text: pairing.message }) : null,
			h('button', { class: 'primary', type: 'button', onclick: () => startPairing(code.value, name.value) }, 'Parear')));
	}
	async function startPairing(code, deviceName) {
		try {
			const claim = await api('/api/pair/claim', { method: 'POST', body: { code, deviceName } });
			pairing = { stage: 'waiting', fingerprint: claim.fingerprint };
			render();
			const until = Date.now() + 3 * 60 * 1000;
			while (pairing.stage === 'waiting' && Date.now() < until) {
				await new Promise(resolve => setTimeout(resolve, 1500));
				const result = await api('/api/pair/poll', { method: 'POST', body: { claimId: claim.claimId, claimSecret: claim.claimSecret } });
				if (result.status === 'approved') { token = result.token; safeSet(TOKEN_KEY, token); pairing = { stage: 'form', message: '' }; screen = 'home'; await refresh(); startStream(); return; }
				if (result.status === 'denied' || result.status === 'expired') { pairing = { stage: 'form', message: result.status === 'denied' ? 'O computador recusou o pareamento.' : 'O pareamento expirou.' }; render(); return; }
			}
			if (pairing.stage === 'waiting') { pairing = { stage: 'form', message: 'O pareamento expirou.' }; render(); }
		} catch (error) { pairing = { stage: 'form', message: error.message }; render(); }
	}

	// ---------- screens ----------
	function sessionCard(session) {
		return h('article', { class: 'card tap', tabindex: '0', role: 'button', 'aria-label': 'Abrir sessão ' + session.id.slice(0, 8), onclick: () => openSessionView(session.id), onkeydown: event => { if (event.key === 'Enter') { openSessionView(session.id); } } },
			h('div', { class: 'row between' }, h('strong', { text: (SERVICE_NAME[session.harness] || session.harness) + ' · ' + session.workspaceName }), statusChip(session.status)),
			h('div', { class: 'muted small', text: modelText(session.model) }),
			session.prompt ? h('div', { class: 'muted', text: session.prompt.slice(0, 140) }) : null);
	}
	function openSessionView(id) { follow = true; openSession = sessions.find(item => item.id === id); screen = 'sessions'; safeSet(VIEW_KEY, 'sessions'); render(); loadHistory(id); }

	// ---------- usage ----------
	let usage;
	const fmt = value => value >= 1e9 ? (value / 1e9).toFixed(2).replace('.', ',') + ' bi' : value >= 1e6 ? (value / 1e6).toFixed(1).replace('.', ',') + ' mi' : value >= 1e3 ? (value / 1e3).toFixed(1).replace('.', ',') + ' mil' : String(value);
	function tokensLine(label, t) {
		return h('div', { class: 'usage-row' }, h('span', { class: 'usage-label', text: label }),
			h('span', { class: 'usage-value', text: t.messages ? fmt(t.input + t.reasoning) + ' entrada · ' + fmt(t.output) + ' saída' + (t.cacheRead + t.cacheWrite ? ' · ' + fmt(t.cacheRead + t.cacheWrite) + ' cache' : '') + (t.cost ? ' · US$ ' + t.cost.toFixed(2).replace('.', ',') : '') : 'sem uso' }));
	}
	function planBar(window) {
		const bar = h('div', { class: 'meter-fill' });
		bar.style.width = Math.min(100, window.usedPercent) + '%';
		const level = window.usedPercent >= 85 ? 'bad' : window.usedPercent >= 60 ? 'warn' : 'ok';
		return h('div', { class: 'meter ' + level }, h('div', { class: 'row between' }, h('span', { text: window.label }), h('strong', { text: window.usedPercent.toString().replace('.', ',') + '% usado' })),
			h('div', { class: 'meter-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(window.usedPercent), 'aria-label': window.label }, bar),
			window.resetsAt ? h('div', { class: 'muted small', text: 'Renova em ' + new Date(window.resetsAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }) : window.resetsText ? h('div', { class: 'muted small', text: 'Renova ' + window.resetsText }) : null);
	}
	function usageCard(service) {
		return h('article', { class: 'card stack' }, h('strong', { text: service.name }),
			service.plan ? h('div', { class: 'stack' }, service.plan.name ? h('div', { class: 'muted small', text: 'Plano ' + service.plan.name }) : null, ...service.plan.windows.map(planBar)) : null,
			tokensLine('Hoje', service.today), tokensLine('7 dias', service.week), tokensLine('30 dias', service.month),
			service.models.length ? h('div', { class: 'usage-models' }, h('div', { class: 'muted small', text: 'Modelos (30 dias)' }), ...service.models.slice(0, 4).map(item => h('div', { class: 'usage-row' }, h('span', { class: 'usage-label', text: item.model }), h('span', { class: 'usage-value', text: fmt(item.month.input + item.month.reasoning + item.month.output) + ' tokens' })))) : null,
			service.note ? h('p', { class: 'muted small', text: service.note }) : null);
	}
	async function renderUsage() {
		$('subtitle').textContent = 'Remote · uso';
		show(h('button', { class: 'secondary', type: 'button', onclick: () => go('home') }, '← Início'), h('h2', { text: 'Uso e limites' }), h('div', { class: 'empty', text: 'Lendo o computador…' }));
		try { usage = await api('/api/usage'); } catch (error) { toast(error.message); usage = undefined; }
		if (screen !== 'usage') { return; }
		show(h('button', { class: 'secondary', type: 'button', onclick: () => go('home') }, '← Início'), h('h2', { text: 'Uso e limites' }),
			h('p', { class: 'muted small', text: 'Lido neste computador, sem consultar nenhum serviço e sem estimar valores. Tokens de entrada e saída; o cache fica à parte.' }),
			...(usage ? usage.services.map(usageCard) : [h('div', { class: 'empty', text: 'Não foi possível ler o uso.' })]),
			h('button', { class: 'secondary', type: 'button', onclick: () => renderUsage() }, 'Atualizar'));
	}

	function renderHome() {
		$('subtitle').textContent = 'Remote';
		const active = sessions.filter(item => item.status === 'running' || item.status === 'waiting');
		show(
			h('h2', { text: 'Início' }),
			h('section', { class: 'card stack' }, h('div', { class: 'row between' }, h('strong', { text: 'Computador' }), status ? chip(status.hub.connected ? 'Hub conectado' : 'Hub desligado', status.hub.connected ? 'ok' : 'bad') : chip('lendo…')),
				status ? h('div', { class: 'muted', text: 'Aparelho: ' + status.device.name + (status.tailnet ? ' · rede privada' : '') }) : null,
				status ? h('div', { class: 'muted', text: status.workspaces.length ? 'Workspaces: ' + status.workspaces.map(item => item.name).join(', ') : 'Nenhum workspace autorizado: autorize um na IDE.' }) : null),
			h('button', { class: 'secondary', type: 'button', onclick: () => go('usage') }, 'Uso e limites dos planos'),
			h('h3', { text: 'Provedores' }),
			h('section', { class: 'card row' }, ...(status ? status.providers.map(provider => chip(provider.name + (provider.status === 'planned' ? ' · em breve' : provider.status === 'unavailable' ? ' · indisponível' : ''), provider.status === 'available' ? 'ok' : '')) : [])),
			h('h3', { text: 'Em andamento (' + active.length + ')' }),
			...(active.length ? active.map(sessionCard) : [h('div', { class: 'empty', text: 'Nenhum agente em execução.' })]));
	}

	async function loadCatalog() {
		if (!agentsForm.workspaceId || !agentsForm.service) { return; }
		try { catalog = await api('/api/catalog?workspaceId=' + encodeURIComponent(agentsForm.workspaceId) + '&service=' + encodeURIComponent(baseService())); } catch (error) { catalog = undefined; toast(error.message); }
		const provider = visibleProviders()[0];
		const previous = agentsForm.model;
		agentsForm.model = ''; agentsForm.effort = '';
		if (provider && provider.models.length) {
			const preferred = catalog.default && provider.models.find(model => model.id === catalog.default.modelID) || provider.models[0];
			// a choice the person already made survives a reload of the catalog, as long as that model is still offered
			const kept = previous && visibleProviders().some(p => p.models.some(item => JSON.stringify([p.id, item.id]) === previous));
			agentsForm.model = kept ? previous : JSON.stringify([provider.id, preferred.id]);
		}
		render();
	}
	function selectedModel() {
		if (!catalog || !agentsForm.model) { return undefined; }
		const [providerID, modelID] = JSON.parse(agentsForm.model);
		for (const provider of catalog.providers || []) { if (provider.id === providerID) { const model = provider.models.find(item => item.id === modelID); if (model) { return { providerID, ...model }; } } }
		return undefined;
	}
	// OpenCode Go and OpenCode Zen are different plans with different models: they are two entries in the Provedor list.
	const baseService = () => String(agentsForm.service).split(':')[0];
	const tierOf = () => String(agentsForm.service).split(':')[1] || '';
	function visibleProviders() {
		const all = (catalog && catalog.providers) || [];
		const tier = tierOf();
		return tier === 'go' ? all.filter(p => p.id === 'opencode-go') : tier === 'zen' ? all.filter(p => p.id === 'opencode') : all;
	}
	function serviceOptions() {
		return status.providers.flatMap(item => {
			const note = item.status === 'planned' ? ' (em breve)' : item.status === 'unavailable' ? ' (indisponível)' : '';
			const blocked = item.status !== 'available';
			return item.id === 'opencode' ? [['opencode:go', 'OpenCode Go' + note, blocked], ['opencode:zen', 'OpenCode Zen' + note, blocked]] : [[item.id, item.name + note, blocked]];
		});
	}
	const providerLabel = provider => provider.id === 'opencode-go' ? 'Go' : provider.id === 'opencode' ? 'Zen' : provider.name;
	function select(id, label, options, value, onchange) {
		return h('div', null, h('label', { for: id, text: label }), h('select', { id, onchange: event => onchange(event.target.value) }, ...options.map(([val, text, disabled]) => h('option', { value: val, selected: val === value, disabled }, text))));
	}
	function renderAgents() {
		$('subtitle').textContent = 'Remote · agentes';
		if (!status) { show(h('div', { class: 'empty', text: 'Lendo o computador…' })); return; }
		const available = status.providers.filter(item => item.status === 'available');
		if (!agentsForm.service && available[0]) { agentsForm.service = available[0].id === 'opencode' ? 'opencode:go' : available[0].id; loadCatalog(); }
		const model = selectedModel();
		const permissions = PERMISSIONS[baseService()];
		const form = h('section', { class: 'card stack' },
			status.workspaces.length ? select('workspace', 'Workspace autorizado', status.workspaces.map(item => [item.id, item.name]), agentsForm.workspaceId, value => { agentsForm.workspaceId = value; loadCatalog(); }) : h('p', { class: 'muted', text: 'Nenhum workspace autorizado. Use “Workspaces do acesso remoto” na IDE.' }),
			select('service', 'Provedor', serviceOptions(), agentsForm.service, value => { agentsForm.service = value; agentsForm.permission = ''; loadCatalog(); }),
			select('model', 'Modelo', visibleProviders().flatMap(provider => provider.models.map(item => [JSON.stringify([provider.id, item.id]), (visibleProviders().length > 1 ? providerLabel(provider) + ' · ' : '') + item.name])), agentsForm.model, value => { agentsForm.model = value; agentsForm.effort = ''; render(); }),
			select('effort', 'Esforço', [['', 'Padrão do modelo'], ...((model && model.efforts) || []).map(level => [level, EFFORT[level] || level])], agentsForm.effort, value => { agentsForm.effort = value; }),
			permissions ? select('permission', 'Permissões', permissions, agentsForm.permission, value => { agentsForm.permission = value; }) : null,
			h('div', null, h('label', { for: 'task', text: 'Tarefa' }), h('textarea', { id: 'task', maxlength: '16000', placeholder: 'Descreva o que o agente deve fazer…', oninput: event => { agentsForm.text = event.target.value; } }, agentsForm.text)),
			h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'button', disabled: sending || !model || !agentsForm.text.trim() || !agentsForm.workspaceId, onclick: sendTask }, sending ? 'Enviando…' : 'Enviar tarefa')));
		show(h('h2', { text: 'Agentes' }), form);
	}
	async function sendTask() {
		const model = selectedModel();
		if (!model) { return; }
		const text = agentsForm.text.trim();
		sending = true; render();
		try {
			const created = await api('/api/sessions', { method: 'POST', body: { confirm: true, workspaceId: agentsForm.workspaceId, service: baseService(), model: { providerID: model.providerID, modelID: model.id, ...(agentsForm.effort ? { variant: agentsForm.effort } : {}) }, ...(agentsForm.permission ? { permissionMode: agentsForm.permission } : {}) } });
			// one request id per task: if the connection drops and the app retries, the agent still receives the prompt once
			await api('/api/sessions/' + created.session.id + '/prompt', { method: 'POST', headers: { 'X-Request-Id': requestId() }, body: { confirm: true, text } });
			agentsForm.text = '';
			await refresh();
			openSessionView(created.session.id);
		} catch (error) { toast(error.message); }
		sending = false; render();
	}

	let history = { id: '', turns: [] };
	async function loadHistory(id) {
		try { history = { id, turns: (await api('/api/sessions/' + id + '/history')).turns || [] }; } catch { history = { id, turns: [] }; }
		if (openSession && openSession.id === id) { render(); }
	}
	let followUp = '';
	function renderSessions() {
		$('subtitle').textContent = 'Remote · sessões';
		if (openSession) { return renderSessionDetail(); }
		const live = sessions.filter(item => !item.historical), archived = sessions.filter(item => item.historical);
		show(h('h2', { text: 'Sessões' }),
			...(live.length ? live.map(sessionCard) : [h('div', { class: 'empty', text: 'Nenhuma sessão ativa.' })]),
			archived.length ? h('h3', { text: 'Arquivadas' }) : null, ...archived.map(sessionCard));
	}
	function richText(text) {
		return String(text).split(/\*\*(.+?)\*\*/g).map((part, index) => index % 2 ? h('strong', { text: part }) : part);
	}
	function bubble(who, text, live) {
		return h('div', { class: 'bubble ' + who + (live ? ' live' : ''), ...(live ? { 'aria-live': 'polite' } : {}) }, h('div', { class: 'who', text: who === 'user' ? 'Você' : live ? 'Agente · ao vivo' : 'Agente' }), h('div', { class: 'text' }, ...richText(text)));
	}
	function renderSessionDetail() {
		const session = openSession;
		const running = session.status === 'running' || session.status === 'waiting';
		const turns = history.id === session.id ? history.turns : [];
		const prior = session.historical || !session.prompt ? turns : turns.slice(0, -1);
		show(
			h('button', { class: 'secondary', type: 'button', onclick: () => { openSession = undefined; render(); } }, '← Sessões'),
			h('h2', { text: (SERVICE_NAME[session.harness] || session.harness) + ' · ' + session.workspaceName }),
			h('div', { class: 'row' }, statusChip(session.status), chip(modelText(session.model)), session.permissionMode ? chip(session.permissionMode) : null),
			session.summary ? h('p', { class: 'chip warn', role: 'status', text: session.summary }) : null,
			h('div', { class: 'chat' },
				...prior.flatMap(turn => [bubble('user', turn.prompt), turn.result ? bubble('agent', turn.result) : null]),
				session.prompt ? bubble('user', session.prompt) : null,
				session.result ? bubble('agent', session.result, running) : (running ? h('div', { class: 'bubble agent typing', 'aria-live': 'polite', text: 'O agente está trabalhando…' }) : null)),
			running ? h('div', { class: 'chatbar' }, h('button', { class: 'danger stop', type: 'button', onclick: () => interrupt(session) }, 'Interromper tarefa')) : null,
			!running && !session.historical ? h('form', { class: 'chatbar', onsubmit: event => { event.preventDefault(); sendFollowUp(session); } }, h('textarea', { id: 'follow', rows: '1', maxlength: '16000', placeholder: 'Escreva uma instrução…', 'aria-label': 'Nova instrução', oninput: event => { followUp = event.target.value; event.target.style.height = 'auto'; event.target.style.height = Math.min(event.target.scrollHeight, 140) + 'px'; } }, followUp), h('button', { class: 'send', type: 'submit', 'aria-label': 'Enviar' }, '↑')) : null,
			session.historical ? h('p', { class: 'muted', text: session.resumable ? 'Sessão arquivada. Reabra-a na IDE do computador para continuar.' : 'Sessão arquivada.' }) : null);
		afterSessionRender();
	}
	async function interrupt(session) {
		try { await api('/api/sessions/' + session.id + '/interrupt', { method: 'POST', body: { confirm: true } }); toast('Interrupção enviada.'); } catch (error) { toast(error.message); }
	}
	async function sendFollowUp(session) {
		const text = followUp.trim();
		if (!text) { return; }
		try { await api('/api/sessions/' + session.id + '/prompt', { method: 'POST', headers: { 'X-Request-Id': requestId() }, body: { confirm: true, text } }); followUp = ''; follow = true; await refresh(); loadHistory(session.id); } catch (error) { toast(error.message); }
	}

	// ---------- comparison ----------
	async function renderCompare() {
		$('subtitle').textContent = 'Remote · comparação';
		show(h('h2', { text: 'Comparação' }), h('div', { class: 'empty', text: 'Lendo…' }));
		try { comparisons = (await api('/api/comparisons')).comparisons; } catch (error) { toast(error.message); comparisons = []; }
		if (screen !== 'compare') { return; }
		show(h('h2', { text: 'Comparação' }), ...(comparisons.length ? comparisons.map(comparisonCard) : [h('div', { class: 'empty', text: 'Nenhuma comparação neste workspace.' })]));
	}
	function comparisonCard(comparison) {
		return h('article', { class: 'card stack' }, h('div', { class: 'row between' }, h('strong', { text: comparison.workspaceName }), comparison.team ? chip('equipe') : chip('comparação')), h('div', { class: 'muted', text: String(comparison.prompt || '').slice(0, 160) }), h('div', { class: 'muted small', text: when(comparison.createdAt) }),
			...(comparison.participants || []).map(participant => h('div', { class: 'row between' }, h('span', { text: (SERVICE_NAME[participant.service] || participant.service) + (participant.role ? ' · ' + participant.role : '') + (comparison.selected === participant.id ? ' ★' : '') }), h('span', { class: 'row' }, statusChip(participant.status), participant.status === 'done' || participant.status === 'ready' ? h('button', { class: 'secondary', type: 'button', onclick: () => showDiff(comparison, participant) }, 'Diff') : null))));
	}
	async function showDiff(comparison, participant) {
		try {
			const data = await api('/api/comparisons/' + comparison.id + '/' + participant.id + '/diff?workspaceId=' + encodeURIComponent(comparison.workspaceId));
			const text = String(data.diff || '') + String(data.additions || '');
			const lines = text.split('\n').slice(0, 2000).map(line => h('span', { class: line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : '' }, line + '\n'));
			show(h('button', { class: 'secondary', type: 'button', onclick: () => render() }, '← Comparação'), h('h2', { text: 'Alterações de ' + (SERVICE_NAME[participant.service] || participant.service) }), data.files ? h('div', { class: 'code', text: String(data.files) }) : null, h('div', { class: 'diff', tabindex: '0', 'aria-label': 'Diff' }, ...(lines.length ? lines : [h('span', { text: 'Sem alterações.' })])));
		} catch (error) { toast(error.message); }
	}

	// ---------- team ----------
	const TEAM_STATE = { preparing: 'preparando', running: 'em execução', snapshotting: 'registrando', paused: 'pausada', 'awaiting-validation': 'aguardando validação', completed: 'concluída', failed: 'falhou', cancelled: 'cancelada', exhausted: 'ciclos esgotados', unrecoverable: 'não recuperável' };
	const ROLE = { implementer: 'Implementador', reviewer: 'Revisor', tester: 'Testador', validation: 'Validação' };
	async function renderTeam() {
		$('subtitle').textContent = 'Remote · equipe';
		show(h('h2', { text: 'Equipe' }), h('div', { class: 'empty', text: 'Lendo…' }));
		try { teams = (await api('/api/teams')).teams; } catch (error) { toast(error.message); teams = []; }
		if (screen !== 'team') { return; }
		show(h('h2', { text: 'Equipe' }), ...(teams.length ? teams.map(teamCard) : [h('div', { class: 'empty', text: 'Nenhum fluxo de equipe neste workspace.' })]));
	}
	function teamCard(team) {
		const kind = ['completed'].includes(team.state) ? 'ok' : ['failed', 'unrecoverable', 'exhausted'].includes(team.state) ? 'bad' : 'warn';
		return h('article', { class: 'card stack' }, h('div', { class: 'row between' }, h('strong', { text: team.workspaceName }), chip(TEAM_STATE[team.state] || team.state, kind)),
			h('div', { class: 'muted', text: String(team.task || '').slice(0, 160) }),
			h('div', { class: 'row' }, chip('etapa: ' + (ROLE[team.phase] || team.phase)), chip('ciclo ' + team.cycle + ' de ' + (team.maxCorrections + 1))),
			h('div', { class: 'row' }, ...(team.roles || []).map(role => chip((ROLE[role.role] || role.role || '') + ' ' + (SERVICE_NAME[role.service] || role.service)))),
			h('ul', { class: 'timeline' }, ...(team.steps || []).map(step => h('li', { class: step.status === 'done' ? 'done' : step.status === 'failed' ? 'failed' : 'current' }, (ROLE[step.role] || step.role) + ' · versão ' + step.version + ' · ' + step.status))),
			...(team.versions || []).map(version => h('div', { class: 'card' }, h('strong', { text: 'Versão ' + version.number + (version.stale ? ' (desatualizada)' : '') }),
				version.review ? h('div', { class: 'muted', text: 'Revisão: ' + (version.review.verdict === 'approve' ? 'aprovada' : 'pede alterações') + ' — ' + version.review.summary }) : null,
				...((version.review && version.review.issues) || []).slice(0, 8).map(issue => h('div', { class: 'muted small', text: '• ' + issue.severity + ' ' + issue.file + (issue.line ? ':' + issue.line : '') + ' — ' + issue.message })),
				version.testPlan ? h('div', { class: 'muted', text: 'Testes (parecer do agente): ' + (version.testPlan.verdict === 'approve' ? 'sem pendências' : 'pendências') + ' — ' + version.testPlan.summary }) : null,
				version.validation ? h('div', { class: 'muted', text: 'Validação independente: ' + String(version.validation.status || version.validation.result || 'registrada') }) : null)),
			team.error ? h('p', { class: 'chip bad', text: team.error }) : null);
	}

	// ---------- devices ----------
	async function renderDevices() {
		$('subtitle').textContent = 'Remote · dispositivos';
		let device = status && status.device;
		try { device = await api('/api/device'); } catch { /* shown from status */ }
		show(h('h2', { text: 'Dispositivos' }),
			h('section', { class: 'card stack' }, h('strong', { text: device ? device.name : 'Este aparelho' }), h('div', { class: 'muted', text: device ? 'Pareado em ' + when(device.createdAt) + (device.lastSeen ? ' · visto em ' + when(device.lastSeen) : '') : '' }),
				h('p', { class: 'muted', text: 'Para revogar outros aparelhos, use “Dispositivos pareados” na IDE do computador. Encerrar a conexão aqui desautoriza este aparelho; é preciso parear de novo.' }),
				h('div', { class: 'actions' }, h('button', { class: 'danger', type: 'button', onclick: logout }, 'Encerrar conexão deste aparelho'))),
			h('section', { class: 'card stack' }, h('strong', { text: 'Tema' }), h('div', { class: 'actions two' }, h('button', { class: 'secondary', type: 'button', onclick: () => setTheme('dark') }, 'Escuro'), h('button', { class: 'secondary', type: 'button', onclick: () => setTheme('light') }, 'Claro'))));
	}
	function setTheme(name) { document.documentElement.setAttribute('data-theme', name); safeSet('singularity.remote.theme', name); }
	async function logout() {
		try { await api('/api/logout', { method: 'POST', body: {} }); } catch { /* the token may already be gone */ }
		forget();
	}

	// ---------- start ----------
	const theme = safeGet('singularity.remote.theme');
	if (theme === 'dark' || theme === 'light') { document.documentElement.setAttribute('data-theme', theme); }
	if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) { navigator.serviceWorker.register('/sw.js').catch(() => undefined); }
	pollTimer = setInterval(() => { if (token && !document.hidden) { void refresh(); } }, 15000);
	document.addEventListener('visibilitychange', () => { if (!document.hidden && token) { void refresh(); } });
	render();
	if (token) { void refresh().then(startStream); }

})();
