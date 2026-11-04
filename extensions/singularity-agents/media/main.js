(function () {
	const vscode = acquireVsCodeApi();
	const R = window.SingularityAgentsRender;
	const app = document.getElementById('app');
	app.innerHTML = R.shell();

	const $ = id => document.getElementById(id);
	const el = {
		hub: $('hub'), sessions: $('sessions'), composer: $('composer'), target: $('target'), newSession: $('new'), ws: $('ws'),
		service: $('service'), model: $('model'), effort: $('effort'), note: $('note'),
		prompt: $('prompt'), send: $('send'), cancel: $('cancel')
	};

	let state = { hub: { status: 'disconnected' }, sessions: [] };
	let catalog;
	let catalogError;
	let loading = false;
	let requested = false;
	let prefs = {};
	let workspace = '';
	let targetId = vscode.getState()?.targetId;
	el.prompt.value = vscode.getState()?.draft || '';
	let targetSeen = false; // the session in use has been seen in the Hub state at least once
	let sending = false;
	let submittedDraft;
	let message = '';
	let lastMarkup;
	let transcript = [];
	let historyKey;
	const drafts = new Map(Object.entries(vscode.getState()?.drafts ?? {}));
	function selectTarget(id) {
		if (targetId === id) { return; }
		drafts.delete(targetId || '');
		drafts.set(targetId || '', el.prompt.value);
		if (drafts.size > 16) { drafts.delete(drafts.keys().next().value); }
		targetId = id;
		el.prompt.value = drafts.get(id || '') || '';
	}
	function saveDraft() {
		vscode.setState({ targetId, draft: el.prompt.value, drafts: Object.fromEntries(drafts) });
	}

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
		const sel = R.resolve(catalog, prefs);
		el.hub.innerHTML = R.hubLine(state);
		el.ws.textContent = workspace ? R.folderName(workspace) : 'Escolher workspace';
		el.ws.title = workspace || 'Escolher workspace';
		el.ws.setAttribute('aria-label', 'Workspace: ' + el.ws.textContent);

		fill(el.service, sel.services.map(s => ({ value: s.id, label: s.name + R.SERVICE_NOTE[s.status], disabled: s.status !== 'available' })), sel.service, loading ? 'Carregando…' : 'Sem serviços');
		const names = new Map();
		for (const model of sel.models) { names.set(model.name, (names.get(model.name) || 0) + 1); }
		fill(el.model, sel.models.map(m => ({
			value: m.key, label: names.get(m.name) > 1 ? m.name + ' · ' + m.providerName : m.name
		})), sel.model?.key, loading ? 'Carregando…' : 'Sem modelos');
		el.model.title = sel.model ? sel.model.providerName + ' · ' + sel.model.name : '';
		const effortOptions = [{ value: '', label: 'Padrão do modelo' }, ...sel.efforts.map(e => ({ value: e, label: R.effortLabel(e) }))];
		fill(el.effort, effortOptions, sel.effort);

		const online = connected();
		el.service.disabled = !online || loading;
		el.model.disabled = !online || loading || !sel.canSend;
		el.effort.disabled = !online || loading || !sel.efforts.length;

		const current = target();
		el.target.textContent = current ? 'Sessão: ' + R.serviceName(catalog, current.harness) + ' · ' + R.modelLabel(catalog, current.model) : '';
		el.newSession.hidden = !targetId;
		const running = busy();
		el.send.disabled = current?.historical || current?.recovery === 'unrecoverable' || !online || sending || running || !sel.canSend || !el.prompt.value.trim();
		el.cancel.hidden = !running;
		el.newSession.disabled = sending;
		el.prompt.disabled = false;

		let note = message;
		if (!note) {
			if (!online) { note = 'Conecte o Singularity Hub para escolher modelos.'; }
			else if (loading) { note = 'Lendo serviços, provedores e modelos…'; }
			else if (catalogError) { note = catalogError; }
			else if (catalog && catalog.unavailable) { note = catalog.unavailable; }
			else if (sel.service && sel.model && !sel.efforts.length) { note = 'Este modelo usa seu esforço padrão.'; }
			else if (current && current.model && sel.model && (current.model.modelID !== sel.model.id || current.model.providerID !== sel.model.providerID || (current.model.variant || '') !== sel.effort)) { note = 'A escolha será aplicada a esta sessão ao enviar.'; }
		}
		el.note.textContent = note;
	}

	function drawSessions() {
		const selected = target();
		const key = selected && [selected.id, selected.updatedAt, selected.historical].join(':');
		if (key !== historyKey) {
			if (historyKey?.split(':')[0] !== selected?.id) { transcript = []; }
			historyKey = key;
			if (selected && !selected.recovery) { vscode.postMessage({ type: 'history', id: selected.id, key }); }
		}
		const markup = R.renderTarget(state, catalog, targetId, transcript);
		if (markup !== lastMarkup) {
			const action = el.sessions.contains(document.activeElement) ? document.activeElement.dataset.action : undefined;
			const scroll = el.sessions.closest('.list');
			const top = scroll.scrollTop;
			const atBottom = scroll.scrollHeight - top - scroll.clientHeight < 4;
			el.sessions.innerHTML = lastMarkup = markup;
			scroll.scrollTop = atBottom ? scroll.scrollHeight : top;
			if (action === 'stop') { el.sessions.querySelector('[data-action="stop"]')?.focus({ preventScroll: true }); }
		}
		saveDraft();
	}

	function remember() {
		const sel = R.resolve(catalog, prefs);
		prefs = { service: sel.service, providerID: sel.model?.providerID, modelID: sel.model && sel.model.id, variant: sel.effort };
		vscode.postMessage({ type: 'prefs', prefs });
	}

	window.addEventListener('message', event => {
		const data = event.data || {};
		if (data.type === 'history') {
			if (data.id === targetId && data.key === historyKey) { transcript = data.turns; drawSessions(); }
		} else if (data.type === 'state') {
			state = data.state;
			// The session in use is dropped only when it was seen and is really gone while the Hub is connected: an update that
			// arrives before the session shows up (or while the connection is being re-established) must not turn the next
			// send into a new session.
			if (targetId && target()) { targetSeen = true; }
			else if (targetId && targetSeen && connected()) { targetId = undefined; targetSeen = false; vscode.postMessage({ type: 'target' }); }
			if (connected() && !requested) { requestCatalog(false); }
			if (!connected()) { requested = false; }
			drawSessions(); drawComposer();
		} else if (data.type === 'created') {
			targetId = data.id; targetSeen = !!target();
			drawSessions(); drawComposer();
		} else if (data.type === 'use') {
			if (sending) { return; }
			selectTarget(data.id);
			targetSeen = !!target();
			const model = target()?.model;
			if (model) { prefs = { service: 'opencode', providerID: model.providerID, modelID: model.modelID, variant: model.variant || '' }; }
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
			if (el.prompt.value === submittedDraft) { el.prompt.value = ''; }
			drawSessions(); drawComposer();
		} else if (data.type === 'failed') {
			sending = false; message = data.message || 'A operação falhou.';
			drawComposer();
		}
	});

	// Each selector changes only what depends on it; the text being typed is never touched.
	el.service.addEventListener('change', () => { prefs = { service: el.service.value }; message = ''; remember(); requestCatalog(false); });
	el.model.addEventListener('change', () => {
		const model = R.resolve(catalog, prefs).models.find(m => m.key === el.model.value);
		if (!model) { return; }
		prefs = { ...prefs, providerID: model.providerID, modelID: model.id, variant: '' };
		message = ''; remember(); drawComposer();
	});
	el.effort.addEventListener('change', () => { prefs = { ...prefs, variant: el.effort.value }; message = ''; remember(); drawComposer(); });
	el.prompt.addEventListener('input', () => { message = ''; saveDraft(); drawComposer(); });
	el.prompt.addEventListener('keydown', event => {
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !el.send.disabled) { event.preventDefault(); el.composer.requestSubmit(); }
	});

	el.composer.addEventListener('submit', event => {
		event.preventDefault();
		const sel = R.resolve(catalog, prefs);
		const text = el.prompt.value.trim();
		if (el.send.disabled || !text || !sel.canSend) { return; }
		submittedDraft = el.prompt.value;
		sending = true; message = '';
		vscode.postMessage({ type: 'send', text, sessionId: targetId, selection: { providerID: sel.model.providerID, modelID: sel.model.id, variant: sel.effort || undefined } });
		drawComposer();
	});

	app.addEventListener('click', event => {
		const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
		if (!button || button.disabled) { return; }
		const { action, id } = button.dataset;
		if (action === 'prepare') {
			if (!el.prompt.value.trim()) {
				el.prompt.value = button.dataset.prompt;
				el.prompt.dispatchEvent(new Event('input'));
			}
			el.prompt.focus();
			el.prompt.setSelectionRange(el.prompt.value.length, el.prompt.value.length);
		} else if (action === 'new') {
			selectTarget(undefined); targetSeen = false;
			vscode.postMessage({ type: 'target' });
			drawSessions(); drawComposer();
		} else if (action === 'cancel') {
			if (targetId) { vscode.postMessage({ type: 'interrupt', id: targetId }); }
		} else if (action === 'stop') {
			vscode.postMessage({ type: action, id });
		} else {
			vscode.postMessage({ type: action });
		}
	});

	drawSessions(); drawComposer();
	vscode.postMessage({ type: 'ready' });
})();
