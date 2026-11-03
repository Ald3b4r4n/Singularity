// Renders the Singularity Agents panel body from a plain state object.
// Shared by the webview (media/main.js) and the Node tests, so it has no DOM or VS Code dependency.
//
// state = {
//   hub:      { status: 'disconnected' | 'connecting' | 'connected' | 'error', detail?: string },
//   sessions: [{ id, harness, title, status: 'running' | 'waiting' | 'done' | 'failed' | 'idle', summary? }]
// }
(function (root) {
	var HUB_LABEL = { disconnected: 'não conectado', connecting: 'conectando', connected: 'conectado', error: 'com erro' };
	var SESSION_LABEL = { running: 'em execução', waiting: 'aguardando aprovação', done: 'concluída', failed: 'falhou', idle: 'ociosa' };

	function esc(value) {
		return String(value === undefined || value === null ? '' : value)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

	function renderSession(s) {
		var label = SESSION_LABEL[s.status] || esc(s.status);
		return '<li class="session" data-status="' + esc(s.status) + '">' +
			'<div class="row"><span class="harness">' + esc(s.harness) + '</span>' +
			'<span class="state state-' + esc(s.status) + '">' + statusGlyph(s.status) + '<span>' + label + '</span></span></div>' +
			(s.title ? '<div class="title">' + esc(s.title) + '</div>' : '') +
			(s.summary ? '<div class="summary">' + esc(s.summary) + '</div>' : '') +
			'</li>';
	}

	function renderEmpty(hub) {
		var detail = hub.detail ? '<p class="detail">' + esc(hub.detail) + '</p>' : '';
		return '<div class="empty">' + BRAND_MARK.replace('class="mark"', 'class="mark big"') +
			'<p class="lead">Singularity Hub não conectado</p>' +
			'<p>Quando estiver disponível, seus agentes e sessões aparecerão aqui.</p>' + detail +
			'<p class="fine">Nenhum agente é iniciado e nenhuma conexão é feita automaticamente.</p></div>';
	}

	function render(state) {
		var hub = (state && state.hub) || { status: 'disconnected' };
		var sessions = (state && state.sessions) || [];
		var status = HUB_LABEL[hub.status] ? hub.status : 'disconnected';
		var sessionsHtml = sessions.length
			? '<ul class="sessions">' + sessions.map(renderSession).join('') + '</ul>'
			: (status === 'connected' ? '<div class="empty"><p class="lead">Nenhuma sessão</p><p>O Hub está conectado e não há sessões abertas.</p></div>' : renderEmpty(hub));
		return '<header class="hd">' + BRAND_MARK + '<h1>SINGULARITY AGENTS</h1></header>' +
			'<section class="hub" aria-live="polite"><span class="state state-' + status + '">' + statusGlyph(status) + '</span>' +
			'<span class="k">Hub</span><span class="v">' + HUB_LABEL[status] + '</span></section>' +
			'<section class="list" aria-label="Sessões"><h2>SESSÕES <span class="count">' + sessions.length + '</span></h2>' + sessionsHtml + '</section>' +
			'<footer class="ft"><button type="button" data-action="openSettings">Configurações</button></footer>';
	}

	var api = { render: render, esc: esc };
	if (typeof module !== 'undefined' && module.exports) { module.exports = api; } else { root.SingularityAgentsRender = api; }
})(typeof window !== 'undefined' ? window : this);
