(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById('app');

	function draw(state) {
		const previous = document.activeElement;
		const drafts = new Map([...app.querySelectorAll('textarea[data-session]')].map(field => [field.dataset.session, field.value]));
		const selection = previous instanceof HTMLTextAreaElement ? [previous.selectionStart, previous.selectionEnd] : undefined;
		app.innerHTML = window.SingularityAgentsRender.render(state);
		for (const field of app.querySelectorAll('textarea[data-session]')) {
			field.value = drafts.get(field.dataset.session) ?? '';
			if (selection && field.id === previous.id) {
				field.focus({ preventScroll: true });
				field.setSelectionRange(...selection);
			}
		}
	}

	window.addEventListener('message', event => {
		if (event.data?.type === 'state') {
			draw(event.data.state);
		}
	});

	app.addEventListener('click', event => {
		const target = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
		if (!target || target.disabled) {
			return;
		}
		const { action, id } = target.dataset;
		if (action === 'prompt') {
			const field = document.getElementById('prompt-' + id);
			const text = field?.value.trim();
			if (text) {
				vscode.postMessage({ type: action, id, text });
			}
		} else {
			vscode.postMessage({ type: action, id });
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
