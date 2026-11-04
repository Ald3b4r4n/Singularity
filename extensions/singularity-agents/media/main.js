(function () {
	const vscode = acquireVsCodeApi();
	const R = window.SingularityAgentsRender;
	const app = document.getElementById('app');
	app.innerHTML = R.shell();

	const $ = id => document.getElementById(id);
	const el = {
		hub: $('hub'), sessions: $('sessions'), composer: $('composer'), target: $('target'), newSession: $('new'), ws: $('ws'),
		service: $('service'), provider: $('provider'), filter: $('filter'), model: $('model'), effort: $('effort'), note: $('note'),
		prompt: $('prompt'), send: $('send'), cancel: $('cancel')
	};

	let state = { hub: { status: 'disconnected' }, sessions: [] };
	let catalog;
	let catalogError;
	let loading = false;
	let requested = false;
	let prefs = {};
	let workspace = '';
	let targetId;
	let targetSeen = false; // the session in use has been seen in the Hub state at least once
	let sending = false;
	let message = '';

	const target = () => state.sessions.find(s => s.id === targetId);
	const connected = () => state.hub.status === 'connected';
	const busy = () => { const s = target(); return !!s && (s.status === 'running' || s.status === 'waiting'); };

	/** Replaces the options of a select and keeps the value when it still exists. Never touches the prompt. */
	function fill(select, options, value, placeholder) {
		const wanted = JSON.stringify([options, value, placeholder]);
		if (select.dataset.sig === wanted) { return; }
		select.dataset.sig = wanted;
		select.innerHTML = '';
		for (const option of options) {
			const o = document.createElement('option');
			o.value = option.value; o.textContent = option.label; o.disabled = !!option.disabled;
			select.appendChild(o);
		}
		if (!options.length && placeholder) {
			const o = document.createElement('option'); o.value = ''; o.textContent = placeholder; select.appendChild(o);
		}
		select.value = value ?? '';
	}

	function requestCatalog(refresh) {
		if (!connected()) { return; }
		loading = true; requested = true; catalogError = undefined;
		vscode.postMessage({ type: 'catalog', refresh: !!refresh });
		drawComposer();
	}

	function drawComposer() {
		const sel = R.resolve(catalog, prefs, el.filter.value);
		el.hub.innerHTML = R.hubLine(state);
		el.ws.textContent = workspace ? R.folderName(workspace) : 'nenhum';
		el.ws.title = workspace || '';

		fill(el.service, sel.services.map(s => ({ value: s.id, label: s.name + R.SERVICE_NOTE[s.status], disabled: s.status !== 'available' })), sel.service, loading ? 'Carregando…' : 'Sem serviços');
		fill(el.provider, sel.providers.map(p => ({ value: p.id, label: p.name })), sel.provider && sel.provider.id, loading ? 'Carregando…' : 'Sem provedores');
		fill(el.model, sel.models.map(m => ({ value: m.id, label: m.name })), sel.model && sel.model.id, loading ? 'Carregando…' : 'Sem modelos');
		const effortOptions = sel.efforts.length ? [{ value: '', label: 'Padrão do modelo' }].concat(sel.efforts.map(e => ({ value: e, label: R.effortLabel(e) }))) : [];
		fill(el.effort, effortOptions, sel.effort, 'Sem controle de esforço');

		const online = connected();
		for (const control of [el.service, el.provider, el.model, el.filter]) { control.disabled = !online || loading || !sel.canSend && control !== el.service; }
		el.effort.disabled = !online || loading || !sel.efforts.length;
		el.filter.hidden = sel.totalModels < 12;

		const current = target();
		el.target.textContent = current ? 'Sessão: ' + R.serviceName(catalog, current.harness) + ' · ' + R.modelLabel(catalog, current.model) : 'Nova sessão (criada ao enviar)';
		el.newSession.hidden = !current;
		const running = busy();
		el.send.disabled = !online || sending || running || !sel.canSend || !workspace || !el.prompt.value.trim();
		el.cancel.disabled = !running;
		el.prompt.disabled = false;

		let note = message;
		if (!note) {
			if (!online) { note = 'Conecte o Singularity Hub para escolher modelos.'; }
			else if (loading) { note = 'Lendo serviços, provedores e modelos…'; }
			else if (catalogError) { note = catalogError; }
			else if (catalog && catalog.unavailable) { note = catalog.unavailable; }
			else if (sel.service && sel.provider && !sel.efforts.length) { note = 'Este modelo não oferece controle de esforço.'; }
			else if (current && current.model && sel.model && (current.model.modelID !== sel.model.id || current.model.providerID !== sel.provider.id || (current.model.variant || '') !== sel.effort)) { note = 'A escolha será aplicada a esta sessão ao enviar.'; }
		}
		el.note.textContent = note;
	}

	function drawSessions() {
		el.sessions.innerHTML = R.renderSessions(state, catalog, targetId);
	}

	function remember() {
		const sel = R.resolve(catalog, prefs, el.filter.value);
		prefs = { service: sel.service, providerID: sel.provider && sel.provider.id, modelID: sel.model && sel.model.id, variant: sel.effort };
		vscode.postMessage({ type: 'prefs', prefs });
	}

	window.addEventListener('message', event => {
		const data = event.data || {};
		if (data.type === 'state') {
			state = data.state;
			// The session in use is dropped only when it was seen and is really gone while the Hub is connected: an update that
			// arrives before the session shows up (or while the connection is being re-established) must not turn the next
			// send into a new session.
			if (targetId && target()) { targetSeen = true; }
			else if (targetId && targetSeen && connected()) { targetId = undefined; targetSeen = false; }
			if (connected() && !requested) { requestCatalog(false); }
			if (!connected()) { requested = false; }
			drawSessions(); drawComposer();
		} else if (data.type === 'catalog') {
			loading = false; catalog = data.catalog; catalogError = data.error;
			drawSessions(); drawComposer();
		} else if (data.type === 'prefs') {
			const changedWorkspace = data.workspace !== undefined && data.workspace !== workspace;
			prefs = data.prefs || prefs;
			if (data.workspace !== undefined) { workspace = data.workspace; }
			if (changedWorkspace && connected()) { requestCatalog(false); }
			drawComposer();
		} else if (data.type === 'sent') {
			sending = false; message = '';
			if (data.sessionId) { targetId = data.sessionId; targetSeen = !!target(); }
			el.prompt.value = '';
			drawSessions(); drawComposer();
		} else if (data.type === 'failed') {
			sending = false; message = data.message || 'A operação falhou.';
			drawComposer();
		}
	});

	// Each selector changes only what depends on it; the text being typed is never touched.
	el.service.addEventListener('change', () => { prefs = { service: el.service.value }; message = ''; remember(); requestCatalog(false); });
	el.provider.addEventListener('change', () => { prefs = { ...prefs, providerID: el.provider.value, modelID: undefined, variant: '' }; message = ''; remember(); drawComposer(); });
	el.model.addEventListener('change', () => { prefs = { ...prefs, modelID: el.model.value, variant: '' }; message = ''; remember(); drawComposer(); });
	el.effort.addEventListener('change', () => { prefs = { ...prefs, variant: el.effort.value }; message = ''; remember(); drawComposer(); });
	el.filter.addEventListener('input', () => drawComposer());
	el.prompt.addEventListener('input', () => { message = ''; drawComposer(); });
	el.prompt.addEventListener('keydown', event => {
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !el.send.disabled) { event.preventDefault(); el.composer.requestSubmit(); }
	});

	el.composer.addEventListener('submit', event => {
		event.preventDefault();
		const sel = R.resolve(catalog, prefs, '');
		const text = el.prompt.value.trim();
		if (!text || !sel.canSend || sending || busy()) { return; }
		sending = true; message = '';
		vscode.postMessage({ type: 'send', text, sessionId: targetId, selection: { providerID: sel.provider.id, modelID: sel.model.id, variant: sel.effort || undefined } });
		drawComposer();
	});

	app.addEventListener('click', event => {
		const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
		if (!button || button.disabled) { return; }
		const { action, id } = button.dataset;
		if (action === 'use') {
			targetId = id; targetSeen = true;
			const session = target();
			if (session && session.model) { prefs = { service: 'opencode', providerID: session.model.providerID, modelID: session.model.modelID, variant: session.model.variant || '' }; remember(); }
			drawSessions(); drawComposer();
		} else if (action === 'new') {
			targetId = undefined; targetSeen = false; drawSessions(); drawComposer();
		} else if (action === 'cancel') {
			if (targetId) { vscode.postMessage({ type: 'interrupt', id: targetId }); }
		} else if (action === 'interrupt' || action === 'stop') {
			vscode.postMessage({ type: action, id });
		} else {
			vscode.postMessage({ type: action });
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
