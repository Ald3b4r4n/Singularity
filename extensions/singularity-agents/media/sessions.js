(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById('app');
	app.classList.add('navigation');
	let markup;
	window.addEventListener('message', ({ data }) => {
		if (data?.type !== 'sessions') { return; }
		const next = window.SingularityAgentsRender.renderNavigation(data.state, data.catalog, data.targetId, data.workspace);
		if (next === markup) { return; }
		const focused = document.activeElement?.dataset;
		app.innerHTML = markup = next;
		if (focused?.action) {
			[...app.querySelectorAll('button')].find(button => button.dataset.action === focused.action && button.dataset.id === focused.id)?.focus();
		}
	});
	app.addEventListener('click', event => {
		const button = event.target.closest('button[data-action]');
		if (button) { vscode.postMessage({ type: button.dataset.action, id: button.dataset.id }); }
	});
	vscode.postMessage({ type: 'ready' });
})();
