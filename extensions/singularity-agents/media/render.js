// Singularity Agents panel: the pure part. No DOM and no VS Code dependency, so the webview (media/main.js) and the Node
// tests share it.
//
//   catalog = { services: [{ id, name, status: 'available'|'unavailable'|'planned', reason? }], service,
//               providers: [{ id, name, models: [{ id, name, efforts: [string] }] }], default?: { providerID, modelID },
//               hiddenModels, unavailable? }                       (from the Hub: read from the service itself)
//   prefs   = { service?, providerID?, modelID?, variant? }         (what the user chose; may be stale)
//   state   = { hub: { status, detail? }, sessions: [{ id, harness, status, summary?, workspace?, result?, model? }], events? }
(function (root) {
	var HUB_LABEL = { disconnected: 'não conectado', connecting: 'conectando', connected: 'conectado', error: 'com erro' };
	var SESSION_LABEL = { running: 'em execução', waiting: 'aguardando', done: 'concluída', failed: 'falhou', idle: 'ociosa' };
	var EFFORT_LABEL = { none: 'Nenhum', minimal: 'Mínimo', low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Extra alto', max: 'Máximo' };
	var SERVICE_NOTE = { available: '', unavailable: ' (indisponível)', planned: ' (em breve)' };

	function esc(value) {
		return String(value === undefined || value === null ? '' : value)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	/** Effort levels are the model's own ids. Known ones get a readable name; any other id is shown as the service gave it. */
	function effortLabel(id) {
		return Object.prototype.hasOwnProperty.call(EFFORT_LABEL, id) ? EFFORT_LABEL[id] : String(id);
	}

	// Each status has its own shape, so state never depends on color alone.
	function statusGlyph(kind) {
		switch (kind) {
			case 'connected':
			case 'running':
				return '<svg class="gl" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="currentColor"/></svg>';
			case 'waiting':
				return '<svg class="gl" viewBox="0 0 14 14" aria-hidden="true"><path d="M5 3v8M9 3v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
			case 'done':
				return '<svg class="gl" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.5l2.8 2.8L11 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
			case 'failed':
			case 'error':
				return '<svg class="gl" viewBox="0 0 14 14" aria-hidden="true"><path d="M4 4l6 6M10 4l-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
			default: // disconnected, connecting, idle: hollow circle
				return '<svg class="gl" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
		}
	}

	var BRAND_MARK = '<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.8" fill="none" stroke="currentColor" stroke-width="2"/><g transform="rotate(-14 12 12)"><ellipse cx="12" cy="12" rx="10.8" ry="1.5" fill="currentColor"/></g></svg>';

	function find(list, id) {
		for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } }
		return undefined;
	}

	/** The integration catalog includes models from multiple inference backends. Keep both ids in every option. */
	function resolve(catalog, prefs) {
		prefs = prefs || {};
		var services = (catalog && catalog.services) || [];
		var selectable = services.filter(function (s) { return s.status === 'available'; });
		var service = (find(selectable, prefs.service) || selectable[0] || {}).id;
		var providers = catalog && catalog.service === service ? (catalog.providers || []) : [];
		var models = providers.flatMap(function (provider) {
			return provider.models.map(function (model) {
				return { ...model, providerID: provider.id, providerName: provider.name, key: JSON.stringify([provider.id, model.id]) };
			});
		});
		var def = (catalog && catalog.default) || {};
		var choose = function (choice) {
			return models.find(function (model) { return model.providerID === choice.providerID && model.id === choice.modelID; });
		};
		var model = choose(prefs) || choose(def) || models[0];
		var efforts = model ? model.efforts : [];
		var effort = efforts.includes(prefs.variant) ? prefs.variant : '';
		return { services, service, models, model, efforts, effort, canSend: !!(service && model) };
	}

	function serviceName(catalog, id) {
		var s = catalog && catalog.services ? find(catalog.services, id) : undefined;
		return s ? s.name : (id === 'opencode' ? 'OpenCode' : String(id));
	}

	/** "Provider name · Model name" for a model a session reports, using the catalog names when they are known. */
	function modelLabel(catalog, model) {
		if (!model) { return 'modelo padrão do serviço'; }
		var provider = catalog && catalog.providers ? find(catalog.providers, model.providerID) : undefined;
		var known = provider ? find(provider.models, model.modelID) : undefined;
		return (provider ? provider.name : model.providerID) + ' · ' + (known ? known.name : model.modelID);
	}

	function folderName(path) {
		var parts = String(path || '').replace(/[\\/]+$/, '').split(/[\\/]/);
		return parts[parts.length - 1] || String(path || '');
	}

	// Model output stays escaped, including code and any incomplete fence during streaming.
	function renderResponse(result) {
		return String(result).split(/^ {0,3}```[^\r\n]*\r?$/m).map(function (part, i) {
			if (i % 2) { return '<pre><code>' + esc(part.replace(/^\r?\n|\r?\n$/g, '')) + '</code></pre>'; }
			return part.trim() ? '<div class="response-text">' + esc(part.trim()) + '</div>' : '';
		}).join('');
	}

	function renderSession(s, catalog, profile) {
		var name = profile?.name?.trim() || 'Você';
		var avatar = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(profile?.avatar)
			? '<img src="' + esc(profile.avatar) + '" alt="">' : '';
		var initial = Array.from(name)[0].toLocaleUpperCase();
		var label = s.historical ? 'histórico' : s.recovery === 'unrecoverable' ? 'não recuperável' : SESSION_LABEL[s.status] || esc(s.status);
		var id = esc(s.id);
		var effort = s.model ? '<span class="effort">' + esc(s.model.variant ? effortLabel(s.model.variant) : 'Padrão do modelo') + '</span>' : '';
		return '<li class="session target" data-id="' + id + '" data-status="' + esc(s.status) + '">' +
			'<div class="row"><span class="svc">' + esc(serviceName(catalog, s.harness)) + '</span>' +
			'<span class="state state-' + esc(s.status) + '">' + statusGlyph(s.status) + '<span>' + label + '</span></span></div>' +
			'<div class="meta"><span class="model" title="' + esc(s.model ? s.model.providerID + '/' + s.model.modelID : '') + '">' + esc(modelLabel(catalog, s.model)) + '</span>' + effort + '</div>' +
			(s.createdAt ? '<div class="workspace">' + esc(new Date(s.createdAt).toLocaleString()) + (s.updatedAt ? ' · ' + esc(new Date(s.updatedAt).toLocaleString()) : '') + '</div>' : '') +
			(s.workspace ? '<div class="workspace" title="' + esc(s.workspace) + '">' + esc(folderName(s.workspace)) + '</div>' : '') +
			(s.prompt ? '<section class="message message-user submitted"><span class="avatar" aria-hidden="true"><span>' + esc(initial) + '</span>' + avatar + '</span><div class="message-body"><h2>' + esc(name) + '</h2><p class="bubble">' + esc(s.prompt) + '</p></div></section>' : '') +
			(s.result || s.summary ? '<section class="message message-agent"><span class="avatar" aria-hidden="true">' + BRAND_MARK + '</span><div class="message-body">' +
				'<h2>' + esc(modelLabel(catalog, s.model).split(' · ').at(-1)) + '</h2><div class="bubble">' +
				(s.result ? '<div class="result" aria-label="Resultado">' + renderResponse(s.result) + '</div>' : '') +
				(s.summary ? '<div class="summary" role="status">' + esc(s.summary) + '</div>' : '') + '</div></div></section>' : '') +
			'</li>';
	}

	function isActive(session) {
		return session.status === 'running' || session.status === 'waiting';
	}

	function renderNavigation(sessions, catalog, targetId) {
		if (!sessions.length) {
			return '<div class="empty"><p class="lead">Nenhuma sessão</p><p>As sessões correspondentes serão exibidas aqui.</p></div>';
		}
		return '<ul class="sessions">' + sessions.map(function (s) {
			var id = esc(s.id);
			var unavailable = s.historical || s.recovery === 'unrecoverable';
			var title = s.recovery === 'unrecoverable' ? 'Sessão não recuperável' : 'Sessão ' + esc(s.id.slice(0, 8));
			var active = isActive(s);
			return '<li class="session' + (s.id === targetId ? ' selected' : '') + '" data-id="' + id + '">' +
				'<div class="session-card-heading"><strong>' + title + '</strong><span class="state state-' + esc(s.status) + '">' +
				statusGlyph(s.status) + esc(s.historical ? 'histórico' : SESSION_LABEL[s.status] || s.status) + '</span></div>' +
				'<div class="session-card-meta">' + esc(modelLabel(catalog, s.model)) + '</div>' +
				(s.workspace ? '<div class="session-card-meta">' + esc(folderName(s.workspace)) + '</div>' : '') +
				'<div class="session-card-actions"><button type="button" class="session-link" data-action="use" data-id="' + id +
				'"' + (s.id === targetId ? ' aria-current="true"' : '') + '>Abrir</button>' +
				(!active && !unavailable ? '<button type="button" data-action="continue" data-id="' + id + '">Continuar</button>' : '') +
				(s.historical ? '<button type="button" data-action="deleteHistory" data-id="' + id + '">Excluir histórico</button>' : '') +
				(!unavailable ? '<details class="session-menu"><summary aria-label="Opções da sessão">…</summary>' +
				'<button type="button" data-action="stop" data-id="' + id + '">Encerrar sessão</button></details>' : '') + '</div></li>';
		}).join('') + '</ul>';
	}

	function renderTarget(state, catalog, targetId, transcript, profile) {
		var session = state.sessions.find(function (s) { return s.id === targetId; });
		if (!session) { return welcome(); }
		var turns = transcript || [];
		var prior = session.historical || !session.prompt ? turns : turns.slice(0, -1);
		var history = prior.map(function (turn) {
			return '<li class="history-turn"><p><strong>Você</strong></p><div class="response-text">' + esc(turn.prompt) + '</div>' +
				(turn.result ? '<p><strong>Agente</strong></p><div class="response-text">' + esc(turn.result) + '</div>' : '') + '</li>';
		}).join('');
		return '<ul class="sessions">' + history + renderSession(session, catalog, profile) + '</ul>';
	}

	function hubLine(state) {
		var status = state && state.hub && HUB_LABEL[state.hub.status] ? state.hub.status : 'disconnected';
		return '<span class="state state-' + status + '">' + statusGlyph(status) + '</span><span class="k">Hub</span><span class="v">' + HUB_LABEL[status] + '</span>';
	}

	function welcome() {
		return '<section class="welcome"><div class="orbit">' + BRAND_MARK + '</div>' +
			'<h2>Crie uma tarefa para um agente</h2><p>Use agentes de IA para implementar funcionalidades, corrigir problemas, refatorar o código ou planejar o desenvolvimento do seu projeto.</p></section>';
	}

	/** The composer is mounted once; streaming only changes the session above it. */
	function shell() {
		return '<header class="hd">' + BRAND_MARK + '<div class="heading"><h1>AGENTES</h1><p>Desenvolva e gerencie tarefas com agentes de IA.</p></div>' +
			'<div class="header-actions"><span id="hub" class="hubline" aria-live="polite"></span>' +
			'<button type="button" data-action="openSettings">Configurações</button></div></header>' +
			'<main class="list" aria-label="Tarefa do agente"><div id="sessions"></div></main>' +
			'<form id="composer" class="composer" aria-label="Nova tarefa">' +
			'<div class="target-row"><span id="target" class="target-label"></span><button type="button" id="new" data-action="new" hidden>Nova sessão</button>' +
			'<button class="workspace-control" type="button" id="ws" data-action="pickWorkspace"></button></div>' +
			'<label for="prompt">Tarefa</label><textarea id="prompt" rows="3" maxlength="16000" placeholder="Descreva o que deseja desenvolver…"></textarea>' +
			'<div class="toolbar"><div class="selectors">' +
			'<div class="field"><label for="service">Provedor</label><select id="service"></select></div>' +
			'<div class="field"><label for="model">Modelo</label><select id="model"></select></div>' +
			'<div class="field"><label for="effort">Esforço</label><select id="effort"></select></div></div>' +
			'<div class="actions">' +
			'<button type="submit" id="send" class="primary" title="Enviar (Ctrl+Enter)">Enviar <span aria-hidden="true">➤</span></button></div></div>' +
			'<p id="note" class="note" role="status"></p></form>';
	}

	var api = {
		isActive: isActive, renderNavigation: renderNavigation, renderTarget: renderTarget, shell: shell, hubLine: hubLine, resolve: resolve, effortLabel: effortLabel,
		modelLabel: modelLabel, serviceName: serviceName, folderName: folderName, esc: esc, SERVICE_NOTE: SERVICE_NOTE
	};
	if (typeof module !== 'undefined' && module.exports) { module.exports = api; } else { root.SingularityAgentsRender = api; }
})(typeof window !== 'undefined' ? window : this);
