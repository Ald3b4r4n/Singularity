// Webview glue: draws whatever state the extension posts and forwards the few UI actions back.
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById('app');

	function draw(state) {
		app.innerHTML = window.SingularityAgentsRender.render(state);
		vscode.setState({ state });
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

	const previous = vscode.getState();
	if (previous && previous.state) {
		draw(previous.state);
	}
	vscode.postMessage({ type: 'ready' });
})();
