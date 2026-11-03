// Webview glue: draws whatever state the extension posts and forwards the few UI actions back.
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById('app');

	function draw(state) {
		app.innerHTML = window.SingularityAgentsRender.render(state);
	}

	window.addEventListener('message', event => {
		if (event.data && event.data.type === 'state') {
			draw(event.data.state);
		}
	});

	app.addEventListener('click', event => {
		const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
		if (target && target.dataset.action === 'openSettings') {
			vscode.postMessage({ type: 'openSettings' });
		}
	});

	// Nothing is restored from a previous run: the panel only ever shows the state the extension host posts now,
	// so a stale "connected" can never be displayed.
	vscode.postMessage({ type: 'ready' });
})();
