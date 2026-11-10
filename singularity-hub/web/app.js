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
	let status, sessions = [], openSession, catalog, comparisons = [], teams = [], lastSeq = 0, streaming = false, pollTimer;
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
			const lost = new Error('Sem conexão com o computador.'); lost.network = true; throw lost;
		}
		if (response.status === 401 && token) { forget(); throw new Error('Este dispositivo não está mais autorizado.'); }
		let data = {};
		try { data = await response.json(); } catch { /* an empty body */ }
		if (!response.ok) { const failure = new Error(data.error || 'Erro ' + response.status); failure.status = response.status; failure.state = data.state; throw failure; }
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
	function go(next) { if (next === screen) { compareView = undefined; teamView = undefined; armed = ''; } screen = next; openSession = next === 'sessions' ? openSession : undefined; safeSet(VIEW_KEY, next); render(); }

	async function refresh() {
		if (!token) { return; }
		try {
			status = await api('/api/status');
			sessions = (await api('/api/sessions')).sessions;
			link.textContent = status.hub.connected ? 'ao vivo' : 'Hub desligado'; link.className = 'chip ' + (status.hub.connected ? 'ok' : 'bad');
			if (!agentsForm.workspaceId && status.workspaces[0]) { agentsForm.workspaceId = status.workspaces[0].id; }
		} catch (error) { if (token) { toast(error.message); } }
		if (!typing()) { render(); }
	}
	/** A periodic refresh must never rebuild the screen under a field the person is using: it would close the Android keyboard. */
	function typing() { const active = document.activeElement; return !!active && view.contains(active) && /^(TEXTAREA|INPUT|SELECT)$/.test(active.tagName); }

	// The conversation follows the text as it grows, as long as the person is at the bottom; scrolling up pauses it and shows a button that goes back down.
	let follow = true;
	const nearBottom = () => document.documentElement.scrollHeight - (window.scrollY + window.innerHeight) < 160;
	const jump = h('button', { class: 'jump', type: 'button', hidden: true, 'aria-label': 'Ir para o fim da conversa', onclick: () => { follow = true; scrollToEnd(true); updateJump(); } }, '↓');
	document.body.appendChild(jump);
	function scrollToEnd(smooth) { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); }
	/** A conversation is on screen: an open session, or an open team. Both follow the newest line and offer the way back down. */
	const inChat = () => !!document.querySelector('#view .chat');
	function updateJump() { jump.hidden = !(inChat() && !follow); }
	window.addEventListener('scroll', () => { if (inChat()) { follow = nearBottom(); updateJump(); } }, { passive: true });
	function afterSessionRender() { if (follow) { scrollToEnd(false); } updateJump(); }

	function render() {
		jump.hidden = true;
		if (screen !== 'compare' && screen !== 'team') { stopPolling(); }
		renderTabs();
		if (!token) { return renderPairing(); }
		const screens = { home: renderHome, agents: renderAgents, sessions: renderSessions, compare: renderCompare, team: renderTeam, devices: renderDevices, usage: renderUsage };
		// a screen that fails to draw must say so, never leave the previous one standing
		Promise.resolve().then(() => (screens[screen] || renderHome)()).catch(error => { toast('Não foi possível abrir esta tela: ' + (error && error.message ? error.message : error)); });
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
	function inText(at) {
		const minutes = Math.max(0, Math.round((at - Date.now()) / 60000)), days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60);
		return days ? days + ' d ' + hours + ' h' : hours ? hours + ' h ' + (minutes % 60) + ' min' : minutes + ' min';
	}
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
			window.resetsAt ? h('div', { class: 'muted small', text: 'Renova em ' + inText(window.resetsAt) + ' · ' + new Date(window.resetsAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }) : window.resetsText ? h('div', { class: 'muted small', text: 'Renova ' + window.resetsText }) : null);
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
		const control = h('select', { ...(id ? { id } : {}), onchange: event => onchange(event.target.value) }, ...options.map(([val, text, disabled]) => h('option', { value: val, selected: val === value, disabled }, text)));
		return id ? h('div', null, h('label', { for: id, text: label }), control) : h('label', { class: 'field' }, h('span', { text: label }), control);
	}
	let providersTimer;
	function providersRetry() { if (providersTimer) { return; } providersTimer = setTimeout(() => { providersTimer = undefined; if (screen === 'agents') { refresh(); } }, 4000); }
	function renderAgents() {
		$('subtitle').textContent = 'Remote · agentes';
		if (!status) { show(h('div', { class: 'empty', text: 'Lendo o computador…' })); return; }
		// The computer did not tell which providers exist yet (it may have just started): say so and ask again, instead of empty selectors.
		if (!status.providers.length) { providersRetry(); show(h('h2', { text: 'Agentes' }), h('div', { class: 'empty', role: 'status', text: status.hub.connected ? 'O computador ainda não informou os provedores. Tentando de novo…' : 'O Singularity Hub do computador está desligado.' }), h('button', { class: 'secondary', type: 'button', onclick: () => refresh() }, 'Tentar agora')); return; }
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
			h('div', null, h('label', { for: 'task', text: 'Tarefa' }), h('textarea', { id: 'task', maxlength: '16000', placeholder: 'Descreva o que o agente deve fazer…', oninput: event => { agentsForm.text = event.target.value; const button = document.getElementById('send-task'); if (button) { button.disabled = sending || !selectedModel() || !agentsForm.text.trim() || !agentsForm.workspaceId; } } }, agentsForm.text)),
			h('div', { class: 'actions' }, h('button', { id: 'send-task', class: 'primary', type: 'button', disabled: sending || !model || !agentsForm.text.trim() || !agentsForm.workspaceId, onclick: sendTask }, sending ? 'Enviando…' : 'Enviar tarefa')));
		show(h('h2', { text: 'Agentes' }), form);
	}
	async function sendTask() {
		const model = selectedModel();
		if (!model) { return; }
		const text = agentsForm.text.trim();
		sending = true; render();
		try {
			const created = await api('/api/sessions', { method: 'POST', body: { confirm: true, workspaceId: agentsForm.workspaceId, service: baseService(), model: { providerID: model.providerID, modelID: model.id, ...(agentsForm.effort ? { variant: agentsForm.effort } : {}) }, ...(agentsForm.permission ? { permissionMode: agentsForm.permission } : {}) } });
			// the session exists now; the instruction goes through the pending send, so a retry keeps the same request id
			await refresh();
			openSessionView(created.session.id);
			sending = false;
			await startSend(created.session.id, text);
			return;
		} catch (error) { toast(error.message); }
		sending = false; render();
	}

	// ---------- sending: one request id per operation ----------
	// An instruction, a new comparison, a new team or a control (cancel, resume, select, validate) is ONE operation with ONE request id,
	// made when the person taps and reused by every retry of that same operation (a dropped connection, a reload, a second tap). The
	// computer registers it before anything is started, so a retry can never make it happen twice.
	const PENDING_KEY = 'singularity.remote.pending';
	const PENDING_FIELDS = ['kind', 'action', 'scope', 'path', 'body', 'text', 'requestId', 'status', 'message'];
	let pendingSend = (() => { try { const saved = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); return saved && typeof saved.path === 'string' && typeof saved.requestId === 'string' && typeof saved.scope === 'string' && saved.body && typeof saved.body === 'object' ? { ...saved, busy: false } : undefined; } catch { return undefined; } })();
	function savePending() { try { if (pendingSend) { localStorage.setItem(PENDING_KEY, JSON.stringify(Object.fromEntries(PENDING_FIELDS.map(key => [key, pendingSend[key]])))); } else { localStorage.removeItem(PENDING_KEY); } } catch { /* storage may be unavailable */ } }
	function startOp(spec) { pendingSend = { ...spec, requestId: requestId(), status: 'sending', message: 'Enviando…', busy: false }; savePending(); return dispatchPending(); }
	function startSend(sessionId, text) { return startOp({ kind: 'prompt', action: 'prompt', scope: sessionId, path: '/api/sessions/' + sessionId + '/prompt', text, body: { confirm: true, text } }); }
	const DONE = { prompt: ['Tarefa recebida.', 'Tarefa já registrada.'], comparison: ['Comparação iniciada.', 'Comparação já registrada.'], team: ['Equipe iniciada.', 'Equipe já registrada.'], control: ['Feito.', 'Já registrado.'] };
	async function finishPending(pending, result) {
		pendingSend = undefined; savePending(); armed = '';
		if (pending.kind === 'prompt') { followUp = ''; agentsForm.text = ''; follow = true; await refresh(); loadHistory(pending.scope); return; }
		const ref = result.ref || (result.comparison && result.comparison.id) || (result.team && result.team.id);
		if (pending.kind === 'comparison') { compareForm.open = false; compareForm.text = ''; if (ref) { compareView = { id: ref, workspaceId: pending.scope }; } comparisons = []; }
		if (pending.kind === 'team') { teamForm.open = false; teamForm.text = ''; if (ref) { follow = true; teamView = { id: ref, workspaceId: pending.scope }; } teams = []; }
		if (pending.kind === 'control') { if (compareView) { compareView.data = undefined; } if (teamView) { teamView.data = undefined; } }
		render();
	}
	async function dispatchPending() {
		const pending = pendingSend;
		if (!pending || pending.busy) { return; }
		pending.busy = true; pending.status = 'sending'; pending.message = 'Enviando…'; render();
		try {
			const result = await api(pending.path, { method: 'POST', headers: { 'X-Request-Id': pending.requestId }, body: pending.body });
			if (result.state === 'processing') { pending.status = 'waiting'; pending.message = 'Aguardando confirmação…'; pending.busy = false; savePending(); render(); setTimeout(() => { if (pendingSend === pending) { dispatchPending(); } }, 2000); return; }
			toast((DONE[pending.kind] || DONE.control)[result.duplicate ? 1 : 0]);
			await finishPending(pending, result);
			return;
		} catch (error) {
			pending.busy = false;
			if (error.network) { pending.status = 'waiting'; pending.message = 'Sem conexão: o envio será conferido quando a conexão voltar. Nada será feito duas vezes.'; }
			else if (error.state === 'unknown') { pending.status = 'unknown'; pending.message = 'Não foi possível confirmar se isto chegou ao computador.'; }
			else if (error.state === 'conflict') { pending.status = 'conflict'; pending.message = 'Este envio já foi usado para outra operação. Faça de novo.'; }
			else if (error.state === 'blocked') { pending.status = 'blocked'; pending.message = error.message; }
			else { pending.status = 'failed'; pending.message = error.message + ' Nada foi iniciado; pode tentar de novo.'; }
			savePending();
		}
		if (pendingSend === pending) { pending.busy = false; }
		render();
	}
	async function resolvePending(decision) {
		const pending = pendingSend;
		if (!pending) { return; }
		const path = pending.kind === 'prompt' ? '/api/sessions/' + pending.scope + '/requests/' + pending.requestId : '/api/operations/' + pending.action + '/' + pending.scope + '/' + pending.requestId;
		try {
			await api(path, { method: 'POST', body: { confirm: true, action: decision } });
			if (decision === 'discard') { pendingSend = undefined; savePending(); toast('Envio descartado.'); render(); return; }
			await dispatchPending();
		} catch (error) { toast(error.message); }
	}
	function discardLocal() { pendingSend = undefined; savePending(); render(); }
	/** The banner of the operation that is going on or that needs a decision, for the screens it belongs to. */
	function pendingBanner(belongs) {
		const pending = pendingSend;
		if (!pending || (belongs && !belongs(pending))) { return null; }
		const buttons = pending.status === 'unknown'
			? [h('button', { class: 'secondary', type: 'button', onclick: dispatchPending }, 'Verificar de novo'), h('button', { class: 'secondary', type: 'button', onclick: () => resolvePending('retry') }, 'Reenviar mesmo assim'), h('button', { class: 'secondary', type: 'button', onclick: () => resolvePending('discard') }, 'Descartar')]
			: pending.status === 'conflict' || pending.status === 'blocked' ? [h('button', { class: 'secondary', type: 'button', onclick: discardLocal }, 'Entendi')]
			: pending.status === 'sending' ? []
			// a send that the computer refused before starting anything can be dropped by the person: there is nothing on the computer to undo
			: pending.status === 'failed' ? [h('button', { class: 'secondary', type: 'button', onclick: dispatchPending }, 'Tentar de novo'), h('button', { class: 'secondary', type: 'button', onclick: discardLocal }, 'Descartar')]
			: [h('button', { class: 'secondary', type: 'button', onclick: dispatchPending }, 'Tentar de novo')];
		return h('section', { class: 'card stack pending ' + pending.status, role: 'status', 'aria-live': 'polite' },
			h('strong', { text: pending.status === 'unknown' ? 'Estado do envio desconhecido' : pending.status === 'sending' ? 'Enviando' : pending.status === 'waiting' ? 'Aguardando confirmação' : 'Envio pendente' }),
			h('div', { class: 'muted small', text: pending.message }), h('div', { class: 'muted small clamp', text: String(pending.text || '').slice(0, 140) }),
			buttons.length ? h('div', { class: 'row' }, ...buttons) : null);
	}
	window.addEventListener('online', () => { if (pendingSend && pendingSend.status === 'waiting') { dispatchPending(); } });

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
			pendingBanner(item => item.kind === 'prompt' && item.scope === session.id),
			!running && !session.historical ? h('form', { class: 'chatbar', onsubmit: event => { event.preventDefault(); sendFollowUp(session); } }, h('textarea', { id: 'follow', rows: '1', maxlength: '16000', placeholder: 'Escreva uma instrução…', 'aria-label': 'Nova instrução', oninput: event => { followUp = event.target.value; event.target.style.height = 'auto'; event.target.style.height = Math.min(event.target.scrollHeight, 140) + 'px'; } }, followUp), h('button', { class: 'send', type: 'submit', 'aria-label': 'Enviar', disabled: !!pendingSend }, '↑')) : null,
			session.historical ? h('p', { class: 'muted', text: session.resumable ? 'Sessão arquivada. Reabra-a na IDE do computador para continuar.' : 'Sessão arquivada.' }) : null);
		afterSessionRender();
	}
	async function interrupt(session) {
		try { await api('/api/sessions/' + session.id + '/interrupt', { method: 'POST', body: { confirm: true } }); toast('Interrupção enviada.'); } catch (error) { toast(error.message); }
	}
	async function sendFollowUp(session) {
		const text = followUp.trim();
		if (!text) { return; }
		if (pendingSend) { return dispatchPending(); }
		await startSend(session.id, text);
	}

	// ---------- multi-agent: comparisons and teams, started and followed from the phone ----------
	// The phone chooses agents, models and efforts from the real catalog and confirms. The computer runs them in isolated Git worktrees;
	// nothing is applied to the project from here (applying and undoing stay in the Windows IDE).
	const catalogs = new Map();
	const compareForm = { open: false, workspaceId: '', text: '', count: 2, agents: [{ service: 'opencode:go', model: '', effort: '' }, { service: 'opencode:go', model: '', effort: '' }, { service: 'opencode:go', model: '', effort: '' }] };
	const teamForm = { open: false, workspaceId: '', text: '', maxCorrections: 2, roles: { implementer: { service: 'opencode:go', model: '', effort: '' }, reviewer: { service: 'opencode:go', model: '', effort: '' }, tester: { service: 'opencode:go', model: '', effort: '' } } };
	let compareView, teamView, armed = '', liveTimer;
	const MODEL_NAME = model => model ? (model.providerID === 'opencode-go' ? 'Go · ' : model.providerID === 'opencode' ? 'Zen · ' : '') + model.modelID + (model.variant ? ' · ' + (EFFORT[model.variant] || model.variant) : '') : 'modelo padrão';

	function serviceChoices() { return (status ? status.providers : []).filter(item => item.status === 'available').flatMap(item => item.id === 'opencode' ? [['opencode:go', 'OpenCode Go'], ['opencode:zen', 'OpenCode Zen']] : [[item.id, item.name]]); }
	const catalogErrors = new Map(); let catalogTimer;
	const catalogKey = (workspaceId, key) => workspaceId + '|' + String(key).split(':')[0];
	/** A failed catalog read is asked again after a few seconds, with the state on screen: never at once (that would be a loop of requests). */
	function scheduleCatalogRetry() { if (catalogTimer) { return; } catalogTimer = setTimeout(() => { catalogTimer = undefined; if (screen === 'compare' || screen === 'team') { render(); } }, 5200); }
	async function ensureCatalog(workspaceId, key) {
	const cacheKey = catalogKey(workspaceId, key), base = String(key).split(':')[0];
	if (!workspaceId || catalogs.has(cacheKey)) { return; }
	const failed = catalogErrors.get(cacheKey);
	if (failed && Date.now() - failed.at < 5000) { scheduleCatalogRetry(); return; }
	catalogs.set(cacheKey, 'loading');
	try { catalogs.set(cacheKey, await api('/api/catalog?workspaceId=' + encodeURIComponent(workspaceId) + '&service=' + encodeURIComponent(base))); catalogErrors.delete(cacheKey); }
	catch (error) { catalogs.delete(cacheKey); catalogErrors.set(cacheKey, { at: Date.now(), message: error.message }); scheduleCatalogRetry(); }
	render();
	}
	function modelsFor(workspaceId, key) {
		const catalog = catalogs.get(workspaceId + '|' + String(key).split(':')[0]);
		if (!catalog || catalog === 'loading') { return undefined; }
		const tier = String(key).split(':')[1];
		const providers = (catalog.providers || []).filter(p => tier === 'go' ? p.id === 'opencode-go' : tier === 'zen' ? p.id === 'opencode' : true);
		return providers.flatMap(p => p.models.map(m => ({ ...m, providerID: p.id, key: JSON.stringify([p.id, m.id]) })));
	}
	/** The real choice behind an agent picker, or undefined while the catalog is still loading or nothing is chosen. */
	function choiceOf(workspaceId, agent) {
		const models = modelsFor(workspaceId, agent.service);
		const model = models && models.find(item => item.key === agent.model);
		return model ? { service: String(agent.service).split(':')[0], model: { providerID: model.providerID, modelID: model.id, ...(agent.effort ? { variant: agent.effort } : {}) } } : undefined;
	}
	/** Once the catalog of an agent's provider is known, an agent with nothing chosen gets a sensible default (never an invented model). */
	function applyDefault(workspaceId, agent, preferred) {
		const models = modelsFor(workspaceId, agent.service);
		if (models && models.length && !models.some(item => item.key === agent.model)) { const pick = (preferred && models.find(item => preferred.test(item.id))) || models[0]; agent.model = pick.key; agent.effort = ''; }
	}
	function agentPicker(workspaceId, agent, title, preferred) {
		applyDefault(workspaceId, agent, preferred);
		const models = modelsFor(workspaceId, agent.service);
		const model = models && models.find(item => item.key === agent.model);
		return h('fieldset', { class: 'agent' }, h('legend', { text: title }),
			select('', 'Provedor', serviceChoices().map(([value, label]) => [value, label]), agent.service, value => { agent.service = value; agent.model = ''; agent.effort = ''; ensureCatalog(workspaceId, value); render(); }),
			select('', 'Modelo', models ? models.map(item => [item.key, item.name || item.id]) : [['', catalogErrors.has(catalogKey(workspaceId, agent.service)) ? 'O computador não respondeu. Tentando de novo…' : 'Carregando…']], agent.model, value => { agent.model = value; agent.effort = ''; render(); }),
			select('', 'Esforço', [['', 'Padrão do modelo'], ...((model && model.efforts) || []).map(level => [level, EFFORT[level] || level])], agent.effort, value => { agent.effort = value; }));
	}
	function workspaceField(form) {
		if (!status || !status.workspaces.length) { return h('p', { class: 'muted', text: 'Nenhum workspace autorizado. Use “Workspaces do acesso remoto” na IDE.' }); }
		if (!form.workspaceId || !status.workspaces.some(item => item.id === form.workspaceId)) { form.workspaceId = status.workspaces[0].id; }
		return select('', 'Workspace autorizado', status.workspaces.map(item => [item.id, item.name]), form.workspaceId, value => { form.workspaceId = value; catalogs.clear(); catalogErrors.clear(); render(); });
	}
	function textField(form, label, max) {
		return h('div', null, h('label', { text: label }), h('textarea', { maxlength: String(max), placeholder: 'Descreva o que os agentes devem fazer…', oninput: event => { form.text = event.target.value; const button = document.getElementById('start-op'); if (button) { button.disabled = !(form.text.trim() && form.canStart && form.canStart()); } } }, form.text));
	}
	const stopPolling = () => { if (liveTimer) { clearInterval(liveTimer); liveTimer = undefined; } };
	function poll(fn, ms = 3000) { stopPolling(); let busy = false; liveTimer = setInterval(async () => { if (busy || document.hidden || pendingSend || typing()) { return; } busy = true; try { await fn(); } finally { busy = false; } }, ms); }
	/** Two taps for what cannot be undone: the first arms the button, the second does it. */
	function armedButton(key, label, danger, action) {
		return h('button', { class: danger ? 'danger' : 'secondary', type: 'button', onclick: () => { if (armed === key) { armed = ''; action(); } else { armed = key; render(); } } }, armed === key ? 'Toque de novo para confirmar' : label);
	}
	const duration = (from, to) => { if (!from) { return ''; } const seconds = Math.max(0, Math.round(((to || Date.now()) - from) / 1000)); return seconds >= 3600 ? Math.floor(seconds / 3600) + ' h ' + Math.floor((seconds % 3600) / 60) + ' min' : seconds >= 60 ? Math.floor(seconds / 60) + ' min ' + (seconds % 60) + ' s' : seconds + ' s'; };
	const ACTIVE_PARTICIPANT = ['preparing', 'running', 'waiting'];

	// ----- comparison -----
	function compareStartForm() {
		const form = compareForm;
		const wid = form.workspaceId || (status && status.workspaces[0] && status.workspaces[0].id) || '';
		const agents = form.agents.slice(0, form.count);
		const PREFERRED = [/muse-spark-1\.3.*contributor/, /deepseek-v4\.1-flash$/, /muse-spark-1\.3.*contributor/];
		agents.forEach((agent, index) => { ensureCatalog(wid, agent.service); applyDefault(wid, agent, PREFERRED[index]); });
		const choices = agents.map(agent => choiceOf(wid, agent));
		const distinct = new Set(choices.filter(Boolean).map(choice => JSON.stringify(choice))).size === choices.length;
		form.canStart = () => !!wid && choices.every(Boolean) && distinct;
		const ready = !!form.text.trim() && form.canStart();
		return h('section', { class: 'card stack form' }, h('strong', { text: 'Nova comparação' }), workspaceField(form), textField(form, 'Tarefa', 16000),
			h('div', { class: 'actions two' }, ...[2, 3].map(n => h('button', { class: form.count === n ? 'primary' : 'secondary', type: 'button', 'aria-pressed': String(form.count === n), onclick: () => { form.count = n; render(); } }, n + ' agentes'))),
			...agents.map((agent, index) => agentPicker(wid, agent, 'Agente ' + (index + 1), PREFERRED[index])),
			choices.every(Boolean) && !distinct ? h('p', { class: 'chip warn', text: 'Escolha agentes ou modelos diferentes.' }) : null,
			h('p', { class: 'muted small', text: 'Ao confirmar, ' + form.count + ' agentes começam a trabalhar no computador, cada um em uma cópia isolada do projeto. Nada é aplicado ao projeto principal.' }),
			h('div', { class: 'actions two' }, h('button', { class: 'secondary', type: 'button', onclick: () => { form.open = false; render(); } }, 'Fechar'),
				h('button', { id: 'start-op', class: 'primary', type: 'button', disabled: !ready, onclick: () => form.text.trim() && form.canStart() && startOp({ kind: 'comparison', action: 'comparison.create', scope: form.workspaceId, path: '/api/comparisons', text: form.text.trim(), body: { confirm: true, workspaceId: form.workspaceId, text: form.text.trim(), participants: choices } }) }, 'Confirmar e iniciar')));
	}
	async function renderCompare() {
		$('subtitle').textContent = 'Remote · comparação';
		if (compareView) { return renderCompareDetail(); }
		stopPolling();
		const draw = () => show(h('div', { class: 'row between' }, h('h2', { text: 'Comparação' }), compareForm.open ? null : h('button', { class: 'primary', type: 'button', onclick: () => { compareForm.open = true; render(); } }, 'Nova comparação')),
			pendingBanner(item => item.kind === 'comparison' && !staleRefusal(item, compareForm)),
			compareForm.open ? compareStartForm() : null,
			...(comparisons.filter(item => !item.team).length ? comparisons.filter(item => !item.team).map(comparisonCard) : [h('div', { class: 'empty', text: 'Nenhuma comparação ainda. Toque em “Nova comparação”.' })]));
		if (!comparisons.length) { show(h('h2', { text: 'Comparação' }), h('div', { class: 'empty', text: 'Lendo…' })); }
		const load = async () => { try { const next = (await api('/api/comparisons')).comparisons; if (JSON.stringify(next) !== JSON.stringify(comparisons)) { comparisons = next; if (screen === 'compare' && !compareView && !compareForm.open) { draw(); } } } catch (error) { if (!comparisons.length) { toast(error.message); } } };
		await load();
		if (screen !== 'compare' || compareView) { return; }
		draw();
		poll(load, 2000);
	}
	function comparisonCard(comparison) {
		const running = (comparison.participants || []).filter(p => ACTIVE_PARTICIPANT.includes(p.status)).length;
		return h('article', { class: 'card tap stack', tabindex: '0', role: 'button', onclick: () => { compareView = { id: comparison.id, workspaceId: comparison.workspaceId }; render(); }, onkeydown: event => { if (event.key === 'Enter') { compareView = { id: comparison.id, workspaceId: comparison.workspaceId }; render(); } } },
			h('div', { class: 'row between' }, h('strong', { text: comparison.workspaceName }), chip(running ? running + ' em execução' : 'concluída', running ? 'warn' : 'ok')),
			h('div', { class: 'muted clamp2', text: String(comparison.prompt || '') }), h('div', { class: 'muted small', text: when(comparison.createdAt) }),
			h('div', { class: 'row' }, ...(comparison.participants || []).map(p => chip(MODEL_NAME(p.model)))));
	}
	async function renderCompareDetail() {
		const view = compareView;
		const load = async () => {
			try { const next = await api('/api/comparisons/' + view.id + '?workspaceId=' + encodeURIComponent(view.workspaceId)); if (compareView === view && JSON.stringify(next) !== JSON.stringify(view.data)) { view.data = next; if (screen === 'compare') { drawCompareDetail(view); } } } catch (error) { if (!view.data) { toast(error.message); compareView = undefined; render(); } }
		};
		if (view.data) { drawCompareDetail(view); } else { show(h('div', { class: 'empty', text: 'Lendo…' })); }
		await load();
		poll(load, 1500);
	}
	function drawCompareDetail(view) {
		const comparison = view.data;
		const active = (comparison.participants || []).some(p => ACTIVE_PARTICIPANT.includes(p.status));
		show(h('button', { class: 'secondary', type: 'button', onclick: () => { compareView = undefined; stopPolling(); armed = ''; render(); } }, '← Comparação'),
			h('h2', { text: 'Comparação' }), h('p', { class: 'muted clamp3', text: comparison.prompt }), h('div', { class: 'muted small', text: comparison.workspaceName + ' · ' + when(comparison.createdAt) }),
			pendingBanner(item => item.kind === 'control'),
			...(comparison.participants || []).map((participant, index) => h('article', { class: 'card stack' },
				h('div', { class: 'row between' }, h('strong', { text: 'Agente ' + (index + 1) + (comparison.selected === participant.id ? ' ★ para revisão' : '') }), statusChip(participant.status)),
				h('div', { class: 'muted small', text: (SERVICE_NAME[participant.service] || participant.service) + ' · ' + MODEL_NAME(participant.model) }),
				participant.startedAt ? h('div', { class: 'muted small', text: 'Duração: ' + duration(participant.startedAt, participant.endedAt) }) : null,
				participant.error ? h('p', { class: 'chip bad', text: participant.error }) : null,
				h('div', { class: 'row' },
					h('button', { class: 'secondary', type: 'button', onclick: () => showResponse({ id: comparison.id, workspaceId: comparison.workspaceId }, participant) }, ACTIVE_PARTICIPANT.includes(participant.status) ? 'Ver ao vivo' : 'Ver resposta'),
					['done', 'ready'].includes(participant.status) ? h('button', { class: 'secondary', type: 'button', onclick: () => showDiff({ id: comparison.id, workspaceId: comparison.workspaceId }, participant) }, 'Ver alterações') : null,
					['done', 'ready'].includes(participant.status) && comparison.selected !== participant.id ? armedButton('select-' + participant.id, 'Selecionar para revisão', false, () => startOp({ kind: 'control', action: 'comparisons.select', scope: comparison.id, path: '/api/comparisons/' + comparison.id + '/select', text: 'Selecionar solução', body: { confirm: true, workspaceId: comparison.workspaceId, participantId: participant.id } })) : null,
					ACTIVE_PARTICIPANT.includes(participant.status) ? armedButton('cancel-' + participant.id, 'Cancelar este agente', true, () => startOp({ kind: 'control', action: 'comparisons.cancel', scope: comparison.id, path: '/api/comparisons/' + comparison.id + '/cancel', text: 'Cancelar agente', body: { confirm: true, workspaceId: comparison.workspaceId, participantId: participant.id } })) : null))),
			active ? armedButton('cancel-all', 'Cancelar a comparação', true, () => startOp({ kind: 'control', action: 'comparisons.cancel', scope: comparison.id, path: '/api/comparisons/' + comparison.id + '/cancel', text: 'Cancelar comparação', body: { confirm: true, workspaceId: comparison.workspaceId } })) : null,
			h('p', { class: 'muted small', text: 'Aplicar a solução ao projeto e desfazer ficam na IDE do computador.' }),
			h('button', { class: 'secondary', type: 'button', onclick: () => { compareView.data = undefined; renderCompareDetail(); } }, 'Atualizar'));
	}
	/** What an agent answered (and, while it works, what it has written so far), its usage and its changes. Refreshes by itself while it is working. */
	async function showResponse(ref, participant) {
		stopPolling();
		const draw = data => {
			const p = data.participant || participant, working = ACTIVE_PARTICIPANT.includes(p.status);
			show(h('button', { class: 'secondary', type: 'button', onclick: () => render() }, '← Voltar'),
				h('h2', { text: 'Resposta de ' + (SERVICE_NAME[p.service] || p.service) }),
				h('div', { class: 'row' }, statusChip(p.status), chip(MODEL_NAME(p.model)), data.durationMs ? chip(duration(Date.now() - data.durationMs, Date.now())) : null),
				data.usage ? h('div', { class: 'muted small', text: [data.usage.inputTokens ? fmt(data.usage.inputTokens) + ' tokens de entrada' : '', data.usage.outputTokens ? fmt(data.usage.outputTokens) + ' de saída' : '', data.usage.costUsd ? 'US$ ' + data.usage.costUsd.toFixed(2).replace('.', ',') : ''].filter(Boolean).join(' · ') }) : null,
				data.error ? h('p', { class: 'chip bad', text: data.error }) : null,
				Array.isArray(data.activity) && data.activity.length ? h('div', { class: 'feed' }, ...activityNodes({ activity: data.activity, text: data.result })) : h('div', { class: 'bubble agent' + (working ? ' live' : '') }, h('div', { class: 'who', text: working ? 'Agente · ao vivo' : 'Agente' }), h('div', { class: 'text' }, ...richText(data.result || (working ? 'Trabalhando… a resposta aparece aqui.' : 'O agente não deixou resposta escrita.')))),
				data.files ? h('div', { class: 'code', text: String(data.files) }) : null,
				['done', 'ready'].includes(p.status) ? h('button', { class: 'secondary', type: 'button', onclick: () => showDiff(ref, p) }, 'Ver as alterações') : null);
			return working;
		};
		let first = true;
		const load = async () => {
			try { const working = draw(await api('/api/comparisons/' + ref.id + '/' + participant.id + '/diff?workspaceId=' + encodeURIComponent(ref.workspaceId))); if (!working) { stopPolling(); } }
			catch (error) { if (first) { toast(error.message); render(); } }
			first = false;
		};
		await load();
		if (ACTIVE_PARTICIPANT.includes(participant.status)) { poll(load, 1000); }
	}
	async function showDiff(comparison, participant) {
		stopPolling();
		try {
			const data = await api('/api/comparisons/' + comparison.id + '/' + participant.id + '/diff?workspaceId=' + encodeURIComponent(comparison.workspaceId));
			const text = String(data.diff || '') + String(data.additions || '');
			const lines = text.split('\n').slice(0, 2000).map(line => h('span', { class: line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : '' }, line + '\n'));
			show(h('button', { class: 'secondary', type: 'button', onclick: () => render() }, '← Voltar'), h('h2', { text: 'Alterações de ' + (SERVICE_NAME[participant.service] || participant.service) }), data.files ? h('div', { class: 'code', text: String(data.files) }) : null, h('div', { class: 'diff', tabindex: '0', 'aria-label': 'Diff' }, ...(lines.length ? lines : [h('span', { text: 'Sem alterações.' })])));
		} catch (error) { toast(error.message); }
	}

	// ----- team -----
	function teamStartForm() {
		const form = teamForm;
		const wid = form.workspaceId || (status && status.workspaces[0] && status.workspaces[0].id) || '';
		const roles = [['implementer', 'Implementador', /muse-spark-1\.3.*contributor/], ['reviewer', 'Revisor', /deepseek-v4\.1-flash$/], ['tester', 'Testador', /muse-spark-1\.3.*contributor/]];
		roles.forEach(([key, , preferred]) => { ensureCatalog(wid, form.roles[key].service); applyDefault(wid, form.roles[key], preferred); });
		const choices = roles.map(([key]) => choiceOf(wid, form.roles[key]));
		form.canStart = () => !!wid && choices.every(Boolean);
		const ready = !!form.text.trim() && form.canStart();
		return h('section', { class: 'card stack form' }, h('strong', { text: 'Nova equipe' }), workspaceField(form), textField(form, 'Tarefa da equipe', 7000),
			...roles.map(([key, title, preferred]) => agentPicker(wid, form.roles[key], title, preferred)),
			select('', 'Ciclos de correção', [['0', 'Nenhum'], ['1', 'Até 1'], ['2', 'Até 2']], String(form.maxCorrections), value => { form.maxCorrections = Number(value); }),
			h('p', { class: 'muted small', text: 'O implementador escreve, o revisor aponta problemas e o testador planeja os testes; cada um com o próprio modelo. A validação independente só roda com um perfil de teste cadastrado na IDE Windows.' }),
			h('p', { class: 'muted small', text: 'Ao confirmar, os agentes começam a trabalhar no computador em cópias isoladas. Nada é aplicado ao projeto principal.' }),
			h('div', { class: 'actions two' }, h('button', { class: 'secondary', type: 'button', onclick: () => { form.open = false; render(); } }, 'Fechar'),
				h('button', { id: 'start-op', class: 'primary', type: 'button', disabled: !ready, onclick: () => form.text.trim() && form.canStart() && startOp({ kind: 'team', action: 'team.start', scope: form.workspaceId, path: '/api/teams', text: form.text.trim(), body: { confirm: true, workspaceId: form.workspaceId, text: form.text.trim(), maxCorrections: form.maxCorrections, roles: { implementer: choices[0], reviewer: choices[1], tester: choices[2] } } }) }, 'Confirmar e iniciar')));
	}
	const TEAM_STATE = { preparing: 'preparando', running: 'em execução', snapshotting: 'registrando', paused: 'pausada', 'awaiting-validation': 'aguardando validação', completed: 'concluída', failed: 'falhou', cancelled: 'cancelada', exhausted: 'ciclos esgotados', unrecoverable: 'não recuperável' };
	const ROLE = { implementer: 'Implementador', reviewer: 'Revisor', tester: 'Testador', validation: 'Validação' };
	const TEAM_ACTIVE = ['preparing', 'running', 'snapshotting', 'paused', 'awaiting-validation'];
	const teamKind = state => state === 'completed' ? 'ok' : ['failed', 'unrecoverable', 'exhausted'].includes(state) ? 'bad' : 'warn';
	/** A send the computer refused before starting anything, for a workspace other than the one the form is now set to, is no longer relevant: it is not shown over the new form. */
	const staleRefusal = (item, form) => item.status === 'failed' && form.open && !!form.workspaceId && item.scope !== form.workspaceId;
	async function renderTeam() {
		$('subtitle').textContent = 'Remote · equipe';
		if (teamView) { return renderTeamDetail(); }
		stopPolling();
		const draw = () => show(h('div', { class: 'row between' }, h('h2', { text: 'Equipe' }), teamForm.open ? null : h('button', { class: 'primary', type: 'button', onclick: () => { teamForm.open = true; render(); } }, 'Nova equipe')),
			pendingBanner(item => (item.kind === 'team' && !staleRefusal(item, teamForm)) || (item.kind === 'control' && /^teams\./.test(item.action || ''))),
			teamForm.open ? teamStartForm() : null,
			...(teams.length ? teams.map(teamCard) : [h('div', { class: 'empty', text: 'Nenhuma equipe ainda. Toque em “Nova equipe”.' })]));
		if (!teams.length) { show(h('h2', { text: 'Equipe' }), h('div', { class: 'empty', text: 'Lendo…' })); }
		const load = async () => { try { const next = (await api('/api/teams')).teams; if (JSON.stringify(next) !== JSON.stringify(teams)) { teams = next; if (screen === 'team' && !teamView && !teamForm.open && !teamMenu) { draw(); } } } catch (error) { if (!teams.length) { toast(error.message); } } };
		await load();
		if (screen !== 'team' || teamView) { return; }
		draw();
		poll(load, 2000);
	}
	let teamMenu = '';
	const teamOp = (team, action, label) => startOp({ kind: 'control', action: 'teams.' + action, scope: team.id, path: '/api/teams/' + team.id + '/' + action, text: label, body: { confirm: true, workspaceId: team.workspaceId } });
	function teamCard(team) {
		const open = () => { follow = true; teamMenu = ''; armed = ''; teamView = { id: team.id, workspaceId: team.workspaceId }; render(); };
		const working = ['preparing', 'running', 'snapshotting'].includes(team.state);
		return h('article', { class: 'card tap stack', tabindex: '0', role: 'button', onclick: open, onkeydown: event => { if (event.key === 'Enter' && event.target === event.currentTarget) { open(); } } },
			h('div', { class: 'row between nowrap' }, h('strong', { text: team.workspaceName }),
				h('div', { class: 'row nowrap' }, chip(TEAM_STATE[team.state] || team.state, teamKind(team.state)),
					h('button', { class: 'more', type: 'button', 'aria-label': 'Ações desta equipe', 'aria-expanded': teamMenu === team.id ? 'true' : 'false', onclick: event => { event.stopPropagation(); teamMenu = teamMenu === team.id ? '' : team.id; armed = ''; render(); } }, '⋮'))),
			teamMenu === team.id ? h('div', { class: 'menu', role: 'menu', onclick: event => event.stopPropagation() },
				h('button', { class: 'secondary', type: 'button', onclick: open }, 'Abrir a conversa'),
				team.comparisonId && (team.versions || []).length ? h('button', { class: 'secondary', type: 'button', onclick: () => { teamMenu = ''; showTeamDiff(team); } }, 'Ver os arquivos que a equipe alterou') : null,
				working ? armedButton('cancel-' + team.id, 'Cancelar a equipe', true, () => { teamMenu = ''; teamOp(team, 'cancel', 'Cancelar a equipe'); })
					: armedButton('delete-' + team.id, 'Excluir a equipe', true, () => { teamMenu = ''; teamOp(team, 'delete', 'Excluir a equipe'); })) : null,
			h('div', { class: 'muted clamp2', text: String(team.task || '').split('\n\nInstrução adicional do usuário:\n')[0] }),
			h('div', { class: 'muted small', text: (ROLE[team.phase] || team.phase) + ' · ciclo ' + (team.cycle + 1) + (team.createdAt ? ' · ' + duration(team.createdAt, team.finishedAt) : '') }));
	}
	async function renderTeamDetail() {
		const view = teamView;
		const load = async () => {
			try {
				const next = await api('/api/teams/' + view.id + '?workspaceId=' + encodeURIComponent(view.workspaceId));
				if (teamView === view && JSON.stringify(next) !== JSON.stringify(view.data)) { view.data = next; if (screen === 'team') { drawTeamDetail(view); } }
				if (!view.profiles) { view.profiles = (await api('/api/validation-profiles?workspaceId=' + encodeURIComponent(view.workspaceId))).profiles; if (teamView === view && screen === 'team') { drawTeamDetail(view); } }
			} catch (error) { if (/indispon/i.test(error.message) && teamView === view) { teamView = undefined; stopPolling(); render(); return; } if (!view.data) { toast(error.message); teamView = undefined; render(); } }
		};
		if (view.data) { drawTeamDetail(view); } else { show(h('div', { class: 'empty', text: 'Lendo…' })); }
		await load();
		void liveLoad(view);
		poll(async () => { await load(); await liveLoad(view); }, 1500);
	}
	/** What the agent of the running step is writing right now, shown without any tap. Updated in place so the screen is not rebuilt under a finger. */
	async function liveLoad(view) {
		const team = view.data;
		const step = team && (team.steps || []).filter(item => item.status === 'sent' || item.status === 'intent').at(-1);
		if (!step || !team.comparisonId || !TEAM_ACTIVE.includes(team.state) || team.state === 'paused') { if (view.live) { view.live = undefined; if (teamView === view && screen === 'team') { drawTeamDetail(view); } } return; }
		try {
			if (!view.participants || view.participantsOf !== team.comparisonId) { view.participants = (await api('/api/comparisons/' + team.comparisonId + '?workspaceId=' + encodeURIComponent(team.workspaceId))).participants || []; view.participantsOf = team.comparisonId; }
			const participant = view.participants.find(item => item.role === step.role);
			if (!participant) { return; }
			const data = await api('/api/comparisons/' + team.comparisonId + '/' + participant.id + '/diff?workspaceId=' + encodeURIComponent(team.workspaceId));
			if (teamView !== view) { return; }
			const fresh = !view.live || view.live.role !== step.role;
			view.live = { role: step.role, text: String(data.result || ''), activity: Array.isArray(data.activity) ? data.activity : [], seenAt: Date.now(), idleMs: typeof data.idleMs === 'number' ? data.idleMs : undefined, files: String(data.files || '').split('\n').filter(Boolean).length + String(data.untracked || '').split('\n').filter(Boolean).length };
			const feed = document.getElementById('team-live'), line = document.getElementById('team-status');
			if (feed && !fresh) { feed.replaceChildren(...activityNodes(view.live)); if (line) { line.textContent = teamStatus(view); } afterSessionRender(); }
			else if (screen === 'team') { drawTeamDetail(view); }
		} catch { /* the next tick tries again */ }
	}
	const TOOL = { read: 'Lendo', write: 'Escrevendo', edit: 'Editando', patch: 'Editando', multiedit: 'Editando', glob: 'Procurando arquivos', grep: 'Buscando no código', list: 'Listando', bash: 'Executando', shell: 'Executando', todowrite: 'Planejando', todoread: 'Planejando', webfetch: 'Consultando a web', websearch: 'Pesquisando na web', task: 'Delegando' };
	/** What an agent did, in order: its reasoning, each tool with the file it touched, and the text it wrote. */
	function activityNodes(live) {
		const items = live.activity || [];
		if (!items.length) { return [live.text ? bubble('agent', live.text, true) : h('div', { class: 'bubble agent typing', 'aria-live': 'polite', text: 'O agente está começando…' })]; }
		const nodes = items.map(item => item.kind === 'thinking' ? h('div', { class: 'act think' }, h('div', { class: 'who', text: item.status === 'completed' ? 'Raciocínio' : 'Raciocinando…' }), h('div', { class: 'text', text: item.text || '' }))
			: item.kind === 'tool' ? h('div', { class: 'act tool' }, h('span', { class: 'mark ' + (item.status === 'completed' ? 'ok' : item.status === 'error' ? 'bad' : 'run'), text: item.status === 'completed' ? '✓' : item.status === 'error' ? '✕' : '…' }), h('span', { class: 'what', text: TOOL[String(item.tool).toLowerCase()] || item.tool }), item.detail ? h('span', { class: 'detail', text: item.detail }) : null)
			: bubble('agent', item.text || '', true));
		const last = items.at(-1);
		if (last && last.kind === 'tool' && last.status === 'completed') { nodes.push(h('div', { class: 'bubble agent typing', text: 'Pensando no próximo passo…' })); }
		return nodes;
	}
	/** One sentence that says what is happening right now, so nobody has to guess whether the team is working, waiting or stuck. */
	function teamStatus(view) {
		const team = view.data, live = view.live;
		if (TEAM_ACTIVE.includes(team.state) && team.state !== 'paused') {
			if (!live) { return team.state === 'awaiting-validation' ? 'Aguardando a validação independente.' : (ROLE[team.phase] || 'Equipe') + ': preparando…'; }
			const idle = live.idleMs === undefined ? undefined : live.idleMs + (Date.now() - live.seenAt);
			const quiet = idle !== undefined && idle > 90000;
			return ROLE[live.role] + ' trabalhando' + (idle === undefined ? '' : quiet ? ' · sem novidade há ' + duration(Date.now() - idle, Date.now()) + ' (o modelo pode estar raciocinando)' : ' · ativo agora') + (live.files ? ' · ' + live.files + ' arquivo(s) alterado(s)' : '');
		}
		return ({ paused: 'Pausada: nenhum agente está trabalhando.', completed: 'Concluída.', cancelled: 'Cancelada.', failed: 'Falhou.', exhausted: 'Os ciclos de correção acabaram sem aprovação.', unrecoverable: 'Não pode ser recuperada.' })[team.state] || '';
	}
	function drawTeamDetail(view) {
		const team = view.data;
		const control = (key, label, danger, action, extra) => armedButton(key, label, danger, () => startOp({ kind: 'control', action: 'teams.' + action, scope: team.id, path: '/api/teams/' + team.id + '/' + action, text: label, body: { confirm: true, workspaceId: team.workspaceId, ...(extra || {}) } }));
		const running = TEAM_ACTIVE.includes(team.state);
		const profiles = view.profiles || [];
		view.profileId = view.profileId && profiles.some(p => p.id === view.profileId) ? view.profileId : (profiles[0] && profiles[0].id) || '';
		const lastVersion = (team.versions || []).at(-1), lastStep = (team.steps || []).at(-1), lastStepFailed = !!lastStep && ['failed', 'cancelled', 'intent'].includes(lastStep.status);
		const canReply = ['completed', 'awaiting-validation', 'exhausted'].includes(team.state) && !!(team.versions || []).length;
		show(h('div', { class: 'row between nowrap' }, h('button', { class: 'secondary back', type: 'button', onclick: () => { teamView = undefined; stopPolling(); armed = ''; render(); } }, '← Equipes'), chip(TEAM_STATE[team.state] || team.state, teamKind(team.state))),
			running ? h('p', { class: 'statusline', id: 'team-status', role: 'status', text: teamStatus(view) }) : null,
			h('details', { class: 'teaminfo' }, h('summary', { text: 'Quem está nesta equipe' }),
				...(team.roles || []).map((role, index) => h('div', { class: 'muted small', text: ['Implementador', 'Revisor', 'Testador'][index] + ': ' + (SERVICE_NAME[role.service] || role.service) + ' · ' + MODEL_NAME(role.model) })),
				h('div', { class: 'muted small', text: 'Ciclo ' + (team.cycle + 1) + ' de até ' + (team.maxCorrections + 1) + (team.createdAt ? ' · ' + duration(team.createdAt, team.finishedAt) + ' no total' : '') }),
				h('div', { class: 'muted small', text: 'Os agentes trabalham em cópias isoladas. Aplicar a solução ao projeto e desfazer ficam na IDE do computador.' })),
			pendingBanner(item => item.kind === 'control'),
			team.error && team.state !== 'exhausted' ? h('p', { class: 'chip bad', text: team.error }) : null,
			team.state === 'paused' && lastStepFailed ? h('p', { class: 'muted small', text: 'A etapa falhou e, por segurança, a equipe nunca reenvia um pedido por conta própria. Volte à lista e exclua esta equipe pelo “⋮” para criar outra.' }) : null,
			h('div', { class: 'chat' },
				bubble('user', String(team.task).split('\n\nInstrução adicional do usuário:\n')[0]),
				...(team.steps || []).flatMap((step, index) => {
					const current = index === team.steps.length - 1 && !!view.live && view.live.role === step.role && ['sent', 'intent'].includes(step.status);
					const asked = (team.followUps || []).filter(item => item.at <= (step.startedAt || 0) && item.at > (index ? team.steps[index - 1].startedAt || 0 : 0));
					const version = (team.versions || []).find(item => item.number === step.version);
					const opinion = step.status === 'done' && version ? (step.role === 'reviewer' ? version.review : step.role === 'tester' ? version.testPlan : undefined) : undefined;
					return [
						...asked.map(item => bubble('user', item.text)),
						h('div', { class: 'stephead ' + (step.status === 'done' ? 'done' : step.status === 'failed' ? 'failed' : 'current'), text: (ROLE[step.role] || step.role) + ' · versão ' + step.version + ' · ' + ({ intent: 'preparando', sent: 'em execução', done: 'concluída', failed: 'falhou', cancelled: 'cancelada' }[step.status] || step.status) + (step.startedAt ? ' · ' + duration(step.startedAt, step.endedAt) : '') }),
						step.error ? h('p', { class: 'chip bad', text: step.error }) : null,
						current ? h('div', { class: 'feed', id: 'team-live' }, ...activityNodes(view.live)) : null,
						!current && ['sent', 'intent'].includes(step.status) && running ? h('div', { class: 'bubble agent typing', text: 'O agente está trabalhando…' }) : null,
						!current && step.result && step.role === 'implementer' ? bubble('agent', step.result) : null,
						opinion ? h('div', { class: 'bubble agent opinion' },
							h('div', { class: 'who', text: step.role === 'reviewer' ? 'Revisão · ' + (opinion.verdict === 'approve' ? 'aprovada' : 'pede alterações') : 'Testes (parecer do agente) · ' + (opinion.verdict === 'approve' ? 'sem pendências' : 'pendências') }),
							h('div', { class: 'text', text: opinion.summary }),
							...(opinion.issues || []).slice(0, 10).map(issue => h('div', { class: 'muted small', text: '• ' + issue.severity + ' ' + issue.file + (issue.line ? ':' + issue.line : '') + ' — ' + issue.message })),
							...(step.role === 'tester' ? (opinion.scenarios || []).slice(0, 6).map(item => h('div', { class: 'muted small', text: '◦ ' + item })) : [])) : null,
						step.role === 'tester' && version && version.validation ? h('div', { class: 'stephead done', text: 'Validação independente · ' + String(version.validation.status || version.validation.state || version.validation.result || 'registrada') }) : null
					];
				}),
				...(team.steps && team.steps.length ? [] : [h('div', { class: 'bubble agent typing', text: 'Preparando a primeira etapa…' })]),
				team.state === 'exhausted' ? h('div', { class: 'stephead failed', text: 'Os ciclos de correção acabaram. Responda abaixo para a equipe continuar.' }) : null,
				team.state === 'completed' ? h('div', { class: 'stephead done', text: 'Equipe concluída. Responda abaixo se quiser mudar algo.' }) : null,
				lastVersion && team.comparisonId && !running ? h('div', { class: 'row links' },
					h('button', { class: 'link', type: 'button', onclick: () => showTeamDiff(team) }, 'Ver os arquivos alterados'),
					team.state === 'completed' && !team.chosen ? control('choose', 'Marcar para revisão na IDE', false, 'choose') : null,
					team.chosen ? h('span', { class: 'chip ok', text: 'Marcada para revisão na IDE' }) : null) : null,
				team.state === 'paused' && !lastStepFailed ? control('resume', 'Retomar a equipe', false, 'resume') : null),
			team.state === 'awaiting-validation' ? h('section', { class: 'card stack' }, h('strong', { text: 'Validação independente' }),
				profiles.length ? [select('', 'Perfil de teste cadastrado na IDE', profiles.map(p => [p.id, p.label]), view.profileId, value => { view.profileId = value; }),
					h('p', { class: 'muted small', text: 'Roda o comando cadastrado no Windows para este perfil; o celular não escolhe nem vê o comando.' }),
					armedButton('validate', 'Rodar a validação', false, () => startOp({ kind: 'control', action: 'teams.validate', scope: team.id, path: '/api/teams/' + team.id + '/validate', text: 'Validação independente', body: { confirm: true, workspaceId: team.workspaceId, profileId: view.profileId } }))]
					: h('p', { class: 'muted', text: 'A equipe aguarda testes independentes, mas nenhum perfil de teste está cadastrado para este workspace. Cadastre um em “Singularity: Perfis de teste do acesso remoto” na IDE do Windows; o celular não pode informar um comando.' })) : null,
			running && team.state !== 'paused' && team.state !== 'awaiting-validation' ? h('div', { class: 'chatbar' }, h('span', { class: 'grow' }), armedButton('cancel', 'Interromper a equipe', true, () => teamOp(team, 'cancel', 'Cancelar a equipe'))) : null,
			canReply ? h('form', { class: 'chatbar', onsubmit: event => { event.preventDefault(); const text = (view.reply || '').trim(); if (!text || pendingSend) { return; } view.reply = ''; follow = true; startOp({ kind: 'control', action: 'teams.instruct', scope: team.id, path: '/api/teams/' + team.id + '/instruct', text: 'Nova instrução para a equipe', body: { confirm: true, workspaceId: team.workspaceId, text } }); } },
				h('textarea', { rows: '1', maxlength: '3000', placeholder: 'Responda à equipe…', 'aria-label': 'Nova instrução para a equipe', oninput: event => { view.reply = event.target.value; event.target.style.height = 'auto'; event.target.style.height = Math.min(event.target.scrollHeight, 140) + 'px'; } }, view.reply || ''),
				h('button', { class: 'send', type: 'submit', 'aria-label': 'Enviar instrução', disabled: !!pendingSend }, '↑')) : null,
			canReply ? h('p', { class: 'muted small', text: 'A resposta vai para o Implementador sobre a versão atual; o Revisor e o Testador avaliam de novo.' }) : null);
		afterSessionRender();
	}
	async function showTeamDiff(team) {
		try {
			const group = await api('/api/comparisons/' + team.comparisonId + '?workspaceId=' + encodeURIComponent(team.workspaceId));
			const implementer = (group.participants || []).find(p => p.role === 'implementer') || (group.participants || [])[0];
			if (!implementer) { toast('Ainda não há alterações para mostrar.'); return; }
			await showDiff({ id: team.comparisonId, workspaceId: team.workspaceId }, implementer);
		} catch (error) { toast(error.message); }
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
