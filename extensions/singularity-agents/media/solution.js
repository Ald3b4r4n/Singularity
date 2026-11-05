(function () {
	'use strict';
	window.SingularitySolution = function (vscode, R, results) {
		const panel = document.createElement('section'); panel.id = 'solution-review'; panel.hidden = true; results.before(panel);
		let open = false, record, pending = false, error = '', records = [], run;
		let lastSignature;
		let executable = 'node', argumentsJson = '["--test"]', allowUntested = false;
		const labels = { prepared: 'Preparada para revisão', validating: 'Validação em andamento', applying: 'Aplicação em andamento', applied: 'Aplicada ao projeto', 'rolling-back': 'Desfazendo aplicação', 'rolled-back': 'Aplicação desfeita', conflict: 'Operação bloqueada por conflito' };
		const tests = { unavailable: 'Nenhum teste independente configurado ou autorizado', running: 'Testes independentes em execução', passed: 'Testes independentes aprovados', failed: 'Testes independentes falharam', interrupted: 'Validação independente interrompida', cancelled: 'Validação independente cancelada' };
		function draw(comparison) {
			if (comparison !== undefined) { run = comparison; }
			panel.hidden = !open;
			if (!open) { return; }
			results.hidden = true; document.getElementById('composer').hidden = true;
			const signature = JSON.stringify([record?.id, record?.state, record?.validation, record?.error, pending, error, allowUntested]);
			if (signature === lastSignature) { return; } lastSignature = signature;
			if (!record) { panel.innerHTML = '<h2>Preparando solução isolada…</h2><p role="alert">' + R.esc(error) + '</p><button type="button" data-solution="close">Voltar à comparação</button>'; return; }
			const files = record.files || [], counts = record.counts || {};
			const renames = (record.renames || '').split('\n').filter(line => /^R[0-9]+\t/.test(line)).map(line => { const parts = line.split('\t'); return parts[1] + ' → ' + parts[2]; }).join('\n');
			panel.innerHTML = '<div class="solution-heading"><h2>Revisar aplicação ao projeto</h2><button type="button" data-solution="close">Voltar à comparação</button></div>' +
				'<p>' + R.esc(record.provider + ' · ' + record.model.modelID) + '</p><p>Commit-base <code>' + R.esc(record.base) + '</code></p><p role="status">' + R.esc(labels[record.state]) + '</p>' +
				'<p>' + (counts.added || 0) + ' adicionados · ' + (counts.modified || 0) + ' modificados · ' + (counts.removed || 0) + ' removidos</p>' +
				'<details open><summary>Lista completa dos arquivos</summary><ul class="solution-files">' + files.map(file => '<li><code>' + R.esc(file.path) + '</code> · ' + R.esc({ added: 'adicionado', modified: 'modificado', removed: 'removido' }[file.kind]) + (file.binary ? ' · binário' : '') + ' · ' + (file.after?.bytes ?? file.before?.bytes ?? 0) + ' bytes</li>').join('') + '</ul><pre>' + R.esc(renames) + '</pre></details>' +
				'<details><summary>Diff completo para revisão</summary><pre class="solution-diff">' + R.esc(record.diff || '') + '</pre></details>' +
				'<section class="solution-validation"><h3>Validação independente</h3><p>Integridade do patch ' + (record.integrity ? 'verificada' : 'não confirmada') + '</p><p id="solution-test-status">' + R.esc(tests[record.validation.state]) + (record.validation.exitCode !== undefined ? ' · Código de saída ' + record.validation.exitCode : '') + '</p><p>O relato de testes do agente permanece na comparação. O Singularity executa o comando autorizado em uma cópia Git temporária, com as permissões da sua conta.</p>' +
				(record.validation.executable ? '<p>Comando executado <code>' + R.esc(record.validation.executable + ' ' + JSON.stringify(record.validation.args)) + '</code></p>' : '') + '<label>Executável de teste<input id="solution-executable" value="' + R.esc(executable) + '"></label><label>Argumentos em JSON<input id="solution-arguments" value="' + R.esc(argumentsJson) + '"></label><button type="button" data-solution="validate"' + (pending || !['prepared', 'rolled-back'].includes(record.state) ? ' disabled' : '') + '>Autorizar e executar testes</button><pre class="solution-test-output">' + R.esc(record.validation.output || '') + '</pre></section>' +
				'<p class="solution-warning">A aplicação exige o mesmo commit-base e uma árvore limpa. Os worktrees de comparação serão preservados.</p>' +
				(record.validation.state === 'unavailable' ? '<label><input type="checkbox" id="solution-untested"' + (allowUntested ? ' checked' : '') + '>Confirmo a aplicação sem executar testes independentes</label>' : '') +
				'<p role="alert" id="solution-error">' + R.esc(error || record.error || '') + '</p><div class="solution-actions">' +
				'<button type="button" class="primary" data-solution="apply"' + (pending || !['prepared', 'rolled-back'].includes(record.state) || (record.validation.state !== 'passed' && !(record.validation.state === 'unavailable' && allowUntested)) ? ' disabled' : '') + '>Confirmar aplicação</button>' +
				'<button type="button" data-solution="undo"' + (pending || record.state !== 'applied' ? ' disabled' : '') + '>Desfazer aplicação</button><button type="button" data-solution="refresh">Atualizar estado</button></div>';
		}
		panel.addEventListener('input', e => { if (e.target.id === 'solution-executable') { executable = e.target.value; } if (e.target.id === 'solution-arguments') { argumentsJson = e.target.value; } });
		panel.addEventListener('change', e => { if (e.target.id === 'solution-untested') { allowUntested = e.target.checked; draw(); } });
		panel.addEventListener('click', e => {
			const button = e.target.closest('button[data-solution]'); if (!button || button.disabled) { return; }
			const action = button.dataset.solution;
			if (action === 'close') { open = false; panel.hidden = true; results.hidden = false; document.getElementById('composer').hidden = false; window.dispatchEvent(new Event('solutionClosed')); return; }
			if (action === 'validate') {
				let args;
				try { args = JSON.parse(argumentsJson); if (!Array.isArray(args)) { throw new Error(); } } catch { error = 'Informe os argumentos como uma lista JSON.'; draw(); return; }
				vscode.postMessage({ type: 'solutionValidate', id: record.id, executable, args });
			} else if (action === 'apply') { vscode.postMessage({ type: 'solutionApply', id: record.id, patchHash: record.patchHash, allowUntested }); }
			else if (action === 'undo') { vscode.postMessage({ type: 'solutionUndo', id: record.id }); }
			else { vscode.postMessage({ type: 'solutionReview', id: record.id }); }
			pending = true; error = ''; draw();
		});
		window.addEventListener('message', ({ data }) => {
			if (data?.type === 'solutionReview') { record = data.record; open = true; pending = false; error = ''; draw(); }
			if (data?.type === 'solutionRecords') { records = data.records; }
			if (data?.type === 'solutionCancelled') { pending = false; draw(); }
			if (data?.type === 'failed' && open) { error = data.message; pending = false; draw(); }
		});
		return {
			draw, isOpen: () => open,
			prepare() { open = true; record = undefined; pending = true; error = ''; draw(); },
			previous(comparisonId) { return records.filter(r => r.comparisonId === (comparisonId || run?.id)).at(-1); },
			review(id) { vscode.postMessage({ type: 'solutionReview', id }); },
			close() { open = false; panel.hidden = true; document.getElementById('composer').hidden = false; }
		};
	};
})();
