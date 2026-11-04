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
	var PERMISSIONS = [
		{ value: '', label: 'Padrão (nega o que pedir aprovação)' },
		{ value: 'plan', label: 'Somente planejar' },
		{ value: 'acceptEdits', label: 'Aceitar edições de arquivos' }
	];
	var SERVICE_NOTE = { available: '', unavailable: ' (indisponível)', planned: ' (em breve)' };

	function esc(value) {
		return String(value === undefined || value === null ? '' : value)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	function permissionLabel(mode) {
		for (var i = 0; i < PERMISSIONS.length; i++) { if (PERMISSIONS[i].value === (mode || '')) { return PERMISSIONS[i].label; } }
		return String(mode);
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
		return s ? s.name : (id === 'opencode' ? 'OpenCode' : id === 'claude-code' ? 'Claude Code' : String(id));
	}

	/** "Provider name · Model name" for a model a session reports, using the catalog names when they are known. */
	function modelLabel(catalog, model) {
		if (!model) { return 'modelo padrão do serviço'; }
		var provider = catalog && catalog.providers ? find(catalog.providers, model.providerID) : undefined;
		var known = provider ? find(provider.models, model.modelID) : undefined;
		return (provider ? provider.name : model.providerID === 'claude-code' ? 'Claude Code' : model.providerID) + ' · ' + (known ? known.name : model.modelID);
	}

	function folderName(path) {
		var parts = String(path || '').replace(/[\\/]+$/, '').split(/[\\/]/);
		return parts[parts.length - 1] || String(path || '');
	}

	/** An archived Claude Code session whose CLI conversation exists can be brought back; the next task resumes it. */
	function canReopen(s) { return !!s.historical && s.harness === 'claude-code' && s.resumable === true; }

	function renderSession(s, events, catalog) {
		var label = s.historical ? 'histórico' : s.recovery === 'unrecoverable' ? 'não recuperável' : SESSION_LABEL[s.status] || esc(s.status);
		var id = esc(s.id);
		var effort = s.model ? '<span class="effort">' + esc(s.model.variant ? effortLabel(s.model.variant) : 'Padrão do modelo') + '</span>' : '';
		return '<li class="session target" data-id="' + id + '" data-status="' + esc(s.status) + '">' +
			'<div class="row"><span class="svc">' + esc(serviceName(catalog, s.harness)) + '</span>' +
			'<span class="state state-' + esc(s.status) + '">' + statusGlyph(s.status) + '<span>' + label + '</span></span></div>' +
			'<div class="meta"><span class="model" title="' + esc(s.model ? s.model.providerID + '/' + s.model.modelID : '') + '">' + esc(modelLabel(catalog, s.model)) + '</span>' + effort + '</div>' +
			(s.createdAt ? '<div class="workspace">' + esc(new Date(s.createdAt).toLocaleString()) + (s.updatedAt ? ' · ' + esc(new Date(s.updatedAt).toLocaleString()) : '') + '</div>' : '') +
			(s.workspace ? '<div class="workspace" title="' + esc(s.workspace) + '">' + esc(folderName(s.workspace)) + '</div>' : '') +
			(s.harness === 'claude-code' ? '<div class="workspace">Permissões: ' + esc(permissionLabel(s.permissionMode)) + '</div>' : '') +
			(s.prompt ? '<section class="submitted"><h2>Tarefa enviada</h2><p>' + esc(s.prompt) + '</p></section>' : '') +
			(s.summary ? '<div class="summary" role="status">' + esc(s.summary) + '</div>' : '') +
			(s.result ? '<pre class="result" aria-label="Resultado">' + esc(s.result) + '</pre>' : '') +
			(events.length ? '<ol class="events" aria-label="Eventos">' + events.slice(-3).map(function (e) { return '<li>' + esc(e.name) + '</li>'; }).join('') + '</ol>' : '') +
			'<div class="session-actions">' +
			(!s.historical && s.recovery !== 'unrecoverable' ? '<button type="button" data-action="stop" data-id="' + id + '">Encerrar</button>' : '') +
			(canReopen(s) ? '<button type="button" data-action="reopen" data-id="' + id + '">Reabrir sessão</button>' : '') + '</div>' +
			'</li>';
	}

	function renderNavigation(state, catalog, targetId, workspace) {
		return (workspace ? '<p class="nav-workspace">' + esc(folderName(workspace)) + '</p>' : '') +
			'<h2 class="nav-heading">Sessões recentes</h2>' +
			(!state.sessions.length ? '<div class="empty"><p class="lead">Nenhuma sessão</p><p>As sessões dos agentes serão exibidas aqui.</p></div>' :
				'<ul class="sessions">' + state.sessions.map(function (s) {
					var id = esc(s.id);
					return '<li class="session" data-id="' + id + '"><button type="button" class="session-link" data-action="use" data-id="' + id +
						'"' + (s.id === targetId ? ' aria-current="true"' : '') + '><strong>' + (s.recovery === 'unrecoverable' ? 'Sessão não recuperável' : 'Sessão ' + esc(s.id.slice(0, 8))) + '</strong>' +
						'<span>' + esc(modelLabel(catalog, s.model)) + '</span><span>' + esc(folderName(s.workspace)) + '</span>' +
						'<span class="state state-' + esc(s.status) + '">' + statusGlyph(s.status) + esc(s.historical ? 'histórico' : SESSION_LABEL[s.status] || s.status) + '</span></button>' +
						(!s.historical && s.recovery !== 'unrecoverable' ? '<button type="button" data-action="stop" data-id="' + id + '">Encerrar</button>' : '') + (canReopen(s) ? '<button type="button" data-action="reopen" data-id="' + id + '">Reabrir</button>' : '') + (s.historical ? '<button type="button" data-action="deleteHistory" data-id="' + id + '">Excluir histórico</button>' : '') + '</li>';
				}).join('') + '</ul>');
	}

	function renderTarget(state, catalog, targetId, transcript) {
		var session = state.sessions.find(function (s) { return s.id === targetId; });
		if (!session) { return welcome(); }
		var events = (state.events || []).filter(function (event) { return event.sessionId === targetId; });
		var turns = transcript || [];
		var prior = session.historical || !session.prompt ? turns : turns.slice(0, -1);
		var history = prior.map(function (turn) {
			return '<li class="history-turn"><p><strong>Você</strong></p><div class="response-text">' + esc(turn.prompt) + '</div>' +
				(turn.result ? '<p><strong>Agente</strong></p><div class="response-text">' + esc(turn.result) + '</div>' : '') + '</li>';
		}).join('');
		return '<ul class="sessions">' + history + renderSession(session, events, catalog) + '</ul>';
	}

	function hubLine(state) {
		var status = state && state.hub && HUB_LABEL[state.hub.status] ? state.hub.status : 'disconnected';
		return '<span class="state state-' + status + '">' + statusGlyph(status) + '</span><span class="k">Hub</span><span class="v">' + HUB_LABEL[status] + '</span>';
	}

	var shortcuts = [
		['Implementar um recurso', 'Desenvolva uma nova funcionalidade no projeto.', 'Implemente o seguinte recurso no projeto: ', 'M9 6l-6 6 6 6m6-12l6 6-6 6m-1-15l-4 18'],
		['Corrigir um problema', 'Investigue e corrija um bug no código.', 'Investigue e corrija o seguinte problema: ', 'M14 7l3 3 5-5a6 6 0 0 1-8 8L6 21a2 2 0 0 1-3-3l8-8a6 6 0 0 1 8-8z'],
		['Refatorar o código', 'Melhore a estrutura, a performance ou a legibilidade.', 'Refatore o seguinte trecho preservando seu comportamento: ', 'M2 7l10-5 10 5-10 5zm0 5l10 5 10-5m-20 5l10 5 10-5'],
		['Planejar uma tarefa', 'Analise o projeto e proponha um plano de desenvolvimento.', 'Analise o projeto e proponha um plano para: ', 'M2 5l2 2 4-4m-6 9l2 2 4-4m-6 9l2 2 4-4m3-12h11m-11 7h11m-11 7h11']
	];

	function welcome() {
		return '<section class="welcome"><div class="orbit">' + BRAND_MARK + '</div>' +
			'<h2>Crie uma tarefa para um agente</h2><p>Use agentes de IA para implementar funcionalidades, corrigir problemas, refatorar o código ou planejar o desenvolvimento do seu projeto.</p>' +
			'<div class="shortcuts">' + shortcuts.map(function ([title, description, prompt, icon]) {
				return '<button type="button" data-action="prepare" data-prompt="' + esc(prompt) + '">' +
					'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + icon + '"/></svg>' +
					'<span><strong>' + title + '</strong><span>' + description + '</span></span></button>';
			}).join('') + '</div></section>';
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
			'<div class="field"><label for="effort">Esforço</label><select id="effort"></select></div>' +
			'<div class="field" id="permission-field" hidden><label for="permission">Permissões</label><select id="permission"></select></div></div>' +
			'<div class="actions"><button type="button" id="cancel" data-action="cancel" hidden>Cancelar tarefa</button>' +
			'<button type="submit" id="send" class="primary" title="Enviar (Ctrl+Enter)">Enviar</button></div></div>' +
			'<p id="note" class="note" role="status"></p></form>';
	}

	var api = {
		renderNavigation: renderNavigation, renderTarget: renderTarget, shell: shell, hubLine: hubLine, resolve: resolve, effortLabel: effortLabel,
		modelLabel: modelLabel, serviceName: serviceName, folderName: folderName, esc: esc, SERVICE_NOTE: SERVICE_NOTE,
			PERMISSIONS: PERMISSIONS, permissionLabel: permissionLabel, canReopen: canReopen
	};
	if (typeof module !== 'undefined' && module.exports) { module.exports = api; } else { root.SingularityAgentsRender = api; }
})(typeof window !== 'undefined' ? window : this);
