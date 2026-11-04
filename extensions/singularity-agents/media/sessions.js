(function () {
	const vscode = acquireVsCodeApi();
	const R = window.SingularityAgentsRender;
	const app = document.getElementById('app');
	app.classList.add('navigation');
	app.innerHTML = '<div class="session-filters">' +
		'<select id="session-workspace" aria-label="Workspace das sessões"></select>' +
		'<div class="session-segments" role="group" aria-label="Exibir sessões">' +
		'<button type="button" data-filter="active" aria-pressed="false">Ativas (0)</button>' +
		'<button type="button" data-filter="recent" aria-pressed="true">Recentes (0)</button></div>' +
		'<input type="search" placeholder="Buscar sessões…" aria-label="Buscar sessões"></div>' +
		'<h2 class="nav-heading"></h2><div id="session-cards"></div>';

	const workspace = app.querySelector('select');
	const search = app.querySelector('input');
	const segments = [...app.querySelectorAll('[data-filter]')];
	const cards = app.querySelector('#session-cards');
	const heading = app.querySelector('.nav-heading');
	let filter = 'recent';
	let data = { state: { sessions: [] } };
	let markup;
	let previousWorkspaces;
	let chosenWorkspace = false;

	function workspaceKey(path) {
		if (!path) { return ''; }
		return /^[a-z]:|^[\\]{2}/i.test(path) ? path.replace(/\\/g, '/').toLowerCase() : path;
	}

	function draw() {
		const sessions = data.state.sessions;
		const workspaces = new Map();
		for (const path of [data.workspace, ...sessions.map(session => session.workspace)]) {
			const key = workspaceKey(path);
			if (key && !workspaces.has(key)) { workspaces.set(key, path); }
		}
		const signature = JSON.stringify([...workspaces]);
		if (signature !== previousWorkspaces) {
			const selected = chosenWorkspace ? workspace.value : workspaceKey(data.workspace);
			workspace.replaceChildren(new Option('Todos os workspaces', ''), ...[...workspaces].map(([key, path]) => {
				const option = new Option(R.folderName(path), key);
				option.title = path;
				return option;
			}));
			workspace.value = workspaces.has(selected) ? selected : '';
			previousWorkspaces = signature;
		}

		const scoped = sessions.filter(session => !workspace.value || workspaceKey(session.workspace) === workspace.value);
		const active = scoped.filter(R.isActive);
		const recent = scoped.filter(session => !R.isActive(session)).reverse();
		segments[0].textContent = 'Ativas (' + active.length + ')';
		segments[1].textContent = 'Recentes (' + recent.length + ')';
		for (const segment of segments) { segment.setAttribute('aria-pressed', String(segment.dataset.filter === filter)); }
		heading.textContent = filter === 'active' ? 'Sessões ativas' : 'Sessões recentes';

		const query = search.value.trim().toLocaleLowerCase();
		const matches = (filter === 'active' ? active : recent).filter(session =>
			[session.title, R.serviceName(data.catalog, session.harness), R.modelLabel(data.catalog, session.model), R.folderName(session.workspace)]
				.some(value => value?.toLocaleLowerCase().includes(query)));
		const next = R.renderNavigation(matches, data.catalog, data.targetId);
		if (next === markup) { return; }
		const focused = cards.contains(document.activeElement) ? document.activeElement.dataset : undefined;
		cards.innerHTML = markup = next;
		if (focused?.action) {
			[...cards.querySelectorAll('button')].find(button => button.dataset.action === focused.action && button.dataset.id === focused.id)?.focus();
		}
	}

	window.addEventListener('message', ({ data: update }) => {
		if (update?.type !== 'sessions') { return; }
		data = update;
		draw();
	});
	search.addEventListener('input', draw);
	workspace.addEventListener('change', () => { chosenWorkspace = true; draw(); });
	app.addEventListener('click', event => {
		const button = event.target.closest('button');
		if (button?.dataset.filter) {
			filter = button.dataset.filter;
			draw();
		} else if (button?.dataset.action) {
			vscode.postMessage({ type: button.dataset.action, id: button.dataset.id });
		}
	});
	draw();
	vscode.postMessage({ type: 'ready' });
})();
