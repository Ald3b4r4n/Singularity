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

	/**
	 * Turns what the user chose into a consistent selection and the options of every selector.
	 * Service -> provider -> model -> effort: each level offers only what the level above allows, and a stale choice falls back
	 * to something that exists (the catalog default, then the first entry); an effort that the model does not offer becomes
	 * "the model's own default" (empty), never an invented level.
	 * `filter` narrows the model list by text but never hides the selected model.
	 */
	function resolve(catalog, prefs, filter) {
		prefs = prefs || {};
		var services = (catalog && catalog.services) || [];
		var selectable = services.filter(function (s) { return s.status === 'available'; });
		var service = (find(selectable, prefs.service) || selectable[0] || {}).id;
		var providers = catalog && catalog.service === service ? (catalog.providers || []) : [];
		var def = (catalog && catalog.default) || {};
		var provider = find(providers, prefs.providerID) || find(providers, def.providerID) || providers[0];
		var models = provider ? provider.models : [];
		var model = find(models, prefs.modelID) || (provider && provider.id === def.providerID ? find(models, def.modelID) : undefined) || models[0];
		var efforts = model ? model.efforts : [];
		var effort = efforts.indexOf(prefs.variant) >= 0 ? prefs.variant : '';
		var needle = String(filter || '').trim().toLowerCase();
		var shown = needle
			? models.filter(function (m) { return m === model || m.name.toLowerCase().indexOf(needle) >= 0 || m.id.toLowerCase().indexOf(needle) >= 0; })
			: models;
		return {
			services: services, service: service, providers: providers, provider: provider, models: shown, totalModels: models.length,
			model: model, efforts: efforts, effort: effort, canSend: !!(service && provider && model)
		};
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

	function renderSession(s, events, catalog, isTarget) {
		var label = SESSION_LABEL[s.status] || esc(s.status);
		var id = esc(s.id);
		var busy = s.status === 'running' || s.status === 'waiting';
		var effort = s.model && s.model.variant ? '<span class="effort" title="Esforço">' + esc(effortLabel(s.model.variant)) + '</span>' : '';
		return '<li class="session' + (isTarget ? ' target' : '') + '" data-id="' + id + '" data-status="' + esc(s.status) + '">' +
			'<div class="row"><span class="svc">' + esc(serviceName(catalog, s.harness)) + '</span>' +
			'<span class="state state-' + esc(s.status) + '">' + statusGlyph(s.status) + '<span>' + label + '</span></span></div>' +
			'<div class="meta"><span class="model" title="' + esc(s.model ? s.model.providerID + '/' + s.model.modelID : '') + '">' + esc(modelLabel(catalog, s.model)) + '</span>' + effort + '</div>' +
			(s.workspace ? '<div class="workspace" title="' + esc(s.workspace) + '">' + esc(folderName(s.workspace)) + '</div>' : '') +
			(s.summary ? '<div class="summary" role="status">' + esc(s.summary) + '</div>' : '') +
			(s.result ? '<pre class="result" aria-label="Resultado">' + esc(s.result) + '</pre>' : '') +
			(events.length ? '<ol class="events" aria-label="Eventos">' + events.slice(-3).map(function (e) { return '<li>' + esc(e.name) + '</li>'; }).join('') + '</ol>' : '') +
			'<div class="session-actions">' +
			(isTarget ? '<span class="using">Em uso no compositor</span>' : '<button type="button" data-action="use" data-id="' + id + '">Usar esta sessão</button>') +
			'<button type="button" data-action="interrupt" data-id="' + id + '"' + (busy ? '' : ' disabled') + '>Cancelar tarefa</button>' +
			'<button type="button" data-action="stop" data-id="' + id + '">Encerrar</button></div>' +
			'</li>';
	}

	function renderSessions(state, catalog, targetId) {
		var sessions = (state && state.sessions) || [];
		var hub = (state && state.hub) || { status: 'disconnected' };
		if (!sessions.length) {
			return hub.status === 'connected'
				? '<div class="empty"><p class="lead">Nenhuma sessão</p><p>Escolha o serviço, o modelo e o esforço abaixo e descreva a tarefa. A sessão é criada ao enviar.</p></div>'
				: '<div class="empty"><p class="lead">Singularity Hub ' + esc(HUB_LABEL[hub.status] || 'não conectado') + '</p>' +
				'<p>Quando estiver disponível, suas sessões aparecerão aqui.</p>' + (hub.detail ? '<p class="detail">' + esc(hub.detail) + '</p>' : '') + '</div>';
		}
		return '<ul class="sessions">' + sessions.map(function (s) {
			return renderSession(s, ((state && state.events) || []).filter(function (e) { return e.sessionId === s.id; }), catalog, s.id === targetId);
		}).join('') + '</ul>';
	}

	function renderNavigation(state, catalog, targetId, workspace) {
		return (workspace ? '<p class="nav-workspace">' + esc(folderName(workspace)) + '</p>' : '') +
			'<h2 class="nav-heading">Sessões recentes</h2>' +
			(!state.sessions.length ? '<div class="empty"><p class="lead">Nenhuma sessão</p><p>As sessões dos agentes serão exibidas aqui.</p></div>' :
				'<ul class="sessions">' + state.sessions.map(function (s) {
					var id = esc(s.id);
					return '<li class="session" data-id="' + id + '"><button type="button" class="session-link" data-action="use" data-id="' + id +
						'"' + (s.id === targetId ? ' aria-current="true"' : '') + '><strong>' + esc(serviceName(catalog, s.harness)) + '</strong>' +
						'<span>' + esc(modelLabel(catalog, s.model)) + '</span><span>' + esc(folderName(s.workspace)) + '</span>' +
						'<span class="state state-' + esc(s.status) + '">' + statusGlyph(s.status) + esc(SESSION_LABEL[s.status] || s.status) + '</span></button>' +
						'<button type="button" data-action="stop" data-id="' + id + '">Encerrar</button></li>';
				}).join('') + '</ul>');
	}

	function renderTarget(state, catalog, targetId) {
		var session = state.sessions.find(function (s) { return s.id === targetId; });
		if (!session) { return '<div class="empty"><p class="lead">Crie uma tarefa para um agente</p><p>Uma sessão será criada ao enviar a tarefa.</p></div>'; }
		var events = (state.events || []).filter(function (event) { return event.sessionId === targetId; });
		return '<ul class="sessions">' + renderSession(session, events, catalog, true) + '</ul>';
	}

	function hubLine(state) {
		var status = state && state.hub && HUB_LABEL[state.hub.status] ? state.hub.status : 'disconnected';
		return '<span class="state state-' + status + '">' + statusGlyph(status) + '</span><span class="k">Hub</span><span class="v">' + HUB_LABEL[status] + '</span>';
	}

	/** The fixed layout. It is drawn once: only the parts that have ids are updated afterwards, so typing is never interrupted. */
	function shell() {
		return '<header class="hd">' + BRAND_MARK + '<h1>AGENTES</h1><span id="hub" class="hubline" aria-live="polite"></span>' +
			'<button type="button" class="icon" data-action="openSettings" title="Configurações do painel de agentes" aria-label="Configurações do painel de agentes">' +
			'<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6.5 1.5h3l.4 1.7 1.3.7 1.6-.7 1.5 2.6-1.3 1.2v1.4l1.3 1.2-1.5 2.6-1.6-.7-1.3.7-.4 1.7h-3l-.4-1.7-1.3-.7-1.6.7-1.5-2.6 1.3-1.2V7l-1.3-1.2 1.5-2.6 1.6.7 1.3-.7z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.1"/></svg></button></header>' +
			'<main class="list" aria-label="Sessões"><div id="sessions"></div></main>' +
			'<form id="composer" class="composer" aria-label="Nova tarefa">' +
			'<div class="target-row"><span id="target" class="target-label"></span><button type="button" id="new" data-action="new" hidden>Nova sessão</button></div>' +
			'<div class="ws-row"><span class="ws-label">Workspace</span><span id="ws" class="ws"></span><button type="button" data-action="pickWorkspace">Trocar</button></div>' +
			'<div class="selectors">' +
			'<div class="field"><label for="service">Serviço de agentes</label><select id="service"></select></div>' +
			'<div class="field"><label for="provider">Provedor</label><select id="provider"></select></div>' +
			'<div class="field wide"><label for="model">Modelo</label><input id="filter" type="search" placeholder="Filtrar modelos" aria-label="Filtrar modelos" autocomplete="off"><select id="model"></select></div>' +
			'<div class="field"><label for="effort">Esforço</label><select id="effort"></select></div>' +
			'</div>' +
			'<p id="note" class="note" role="status"></p>' +
			'<div class="field wide"><label for="prompt">Tarefa</label><textarea id="prompt" rows="4" maxlength="16000" placeholder="Descreva o que o agente deve fazer"></textarea></div>' +
			'<div class="actions"><button type="submit" id="send" class="primary">Enviar</button><button type="button" id="cancel" data-action="cancel" disabled>Cancelar tarefa</button></div>' +
			'</form>';
	}

	function render(state, catalog, targetId) {
		return '<div class="hubline">' + hubLine(state) + '</div>' + renderSessions(state, catalog, targetId);
	}

	var api = {
		renderNavigation: renderNavigation, renderTarget: renderTarget, shell: shell, render: render, renderSessions: renderSessions, hubLine: hubLine, resolve: resolve, effortLabel: effortLabel,
		modelLabel: modelLabel, serviceName: serviceName, folderName: folderName, esc: esc, SERVICE_NOTE: SERVICE_NOTE
	};
	if (typeof module !== 'undefined' && module.exports) { module.exports = api; } else { root.SingularityAgentsRender = api; }
})(typeof window !== 'undefined' ? window : this);
