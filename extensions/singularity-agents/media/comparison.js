(function () {
	'use strict';
	window.SingularityComparison = function (vscode, R, app) {
		const $ = id => document.getElementById(id);
		const esc = R.esc;
		let drafting = false, error = '';
		let active = false, runs = [], state = { sessions: [], hub: {} }, selected, pending = false;
		let count = 2;
		const choices = [{ service: 'claude-code' }, { service: 'codex-cli' }, { service: 'opencode' }];
		const details = new Map();
		const states = { preparing: 'Preparando', running: 'Em execução', done: 'Concluída', failed: 'Falhou', cancelled: 'Cancelada', unrecoverable: 'Sessão não recuperável' };
		const mode = document.createElement('nav');
		mode.className = 'comparison-mode'; mode.setAttribute('aria-label', 'Modo de execução');
		mode.innerHTML = '<button type="button" id="mode-single" aria-pressed="true">Sessão individual</button><button type="button" id="mode-comparison" aria-pressed="false">Modo Comparação</button><button type="button" id="mode-team" aria-pressed="false">Modo Equipe</button>';
		app.querySelector('.hd').after(mode);
		const config = document.createElement('section');
		config.id = 'comparison-config'; config.hidden = true;
		$('composer').querySelector('label[for="prompt"]').before(config);
		const results = document.createElement('section');
		results.id = 'comparison-results'; results.hidden = true;
		$('sessions').after(results);
		const solution = window.SingularitySolution(vscode, R, results);
		const team = window.SingularityTeam(vscode, R, app, solution);
		function requestCatalog(index) { vscode.postMessage({ type: 'comparisonCatalog', index, service: choices[index].service }); }
		function setMode(value) {
			team.setActive(false); $('mode-team').setAttribute('aria-pressed', 'false');
			active = value;
			if (!active) { solution.close(); }
			if (active) { choices.slice(0, count).forEach((c, i) => { if (!c.catalog) { requestCatalog(i); } }); vscode.postMessage({ type: 'comparisonList' }); }
			drawConfig(); draw();
			window.dispatchEvent(new Event('comparisonMode'));
		}
		function modelOptions(c) {
			return (c.catalog?.providers ?? []).flatMap(p => p.models.map(m => ({ ...m, providerID: p.id })));
		}
		function resolved(c) { const models = modelOptions(c); return models.find(m => m.id === c.modelID && m.providerID === c.providerID) ?? models[0]; }
		function drawConfig() {
			config.innerHTML = '<div class="comparison-count"><label for="comparison-count">Participantes</label><select id="comparison-count"><option value="2"' + (count === 2 ? ' selected' : '') + '>2 agentes</option><option value="3"' + (count === 3 ? ' selected' : '') + '>3 agentes</option></select><span>Cada agente usará seu próprio worktree. Ao iniciar, todos os selecionados executarão a tarefa.</span></div><div class="comparison-choices">' + choices.slice(0, count).map((c, index) => {
				const model = resolved(c);
				return '<fieldset><legend>Agente ' + (index + 1) + '</legend><label>Provedor<select data-index="' + index + '" data-field="service">' + ['opencode', 'claude-code', 'codex-cli'].map(id => '<option value="' + id + '"' + (id === c.service ? ' selected' : '') + '>' + esc(R.serviceName(undefined, id)) + '</option>').join('') + '</select></label>' +
					'<label>Modelo<select data-index="' + index + '" data-field="model">' + modelOptions(c).map(m => '<option value="' + esc(m.providerID + '\t' + m.id) + '"' + (model?.id === m.id && model?.providerID === m.providerID ? ' selected' : '') + '>' + esc(m.name || m.id) + '</option>').join('') + '</select></label>' +
					'<label>Esforço<select data-index="' + index + '" data-field="effort"><option value="">Padrão do modelo</option>' + (model?.efforts ?? []).map(e => '<option value="' + esc(e) + '"' + (c.variant === e ? ' selected' : '') + '>' + esc(R.effortLabel(e)) + '</option>').join('') + '</select></label>' +
					(c.error || c.catalog?.unavailable ? '<p role="status">' + esc(c.error || c.catalog.unavailable) + '</p>' : '') + '</fieldset>';
			}).join('') + '</div>';
		}
		function current() { if (drafting) { return undefined; } return runs.find(r => r.id === selected) ?? runs[0]; }
		function running() { return current()?.participants.some(p => ['running', 'preparing'].includes(p.status)); }
		function draw() {
			if (team.active()) { team.draw(); return; }
			$('mode-single').setAttribute('aria-pressed', String(!active)); $('mode-comparison').setAttribute('aria-pressed', String(active));
			config.hidden = !active || !!current(); results.hidden = !active; $('sessions').hidden = active;
			$('composer').querySelector('.selectors').hidden = active;
			$('target').hidden = active; $('new').hidden = active || !$('target').textContent;
			if (!active) { return; }
			const run = current();
			$('note').textContent = error || 'Os resultados permanecem nos worktrees. Escolha um para inspecionar.';
			const online = state.hub?.status === 'connected';
			$('send').disabled = !online || pending || (!run && (!$('prompt').value.trim() || !choices.slice(0, count).every(c => !!resolved(c))));
			$('send').textContent = running() ? 'Parar todos' : pending ? 'Preparando…' : run ? 'Nova comparação' : 'Iniciar comparação';
			$('send').classList.toggle('interrupt', !!running());
			$('send').title = running() ? 'Cancelar todos os participantes ativos' : 'Enviar a tarefa aos agentes selecionados';
			if (!run) { results.innerHTML = '<div class="comparison-empty"><h2>Compare soluções em paralelo</h2><p>Selecione dois ou três agentes, escolha seus modelos e descreva uma tarefa. A origem Git deve estar limpa.</p>' + (runs.length ? '<button type="button" data-cmp="history">Voltar às comparações</button>' : '') + '</div>'; return; }
			results.innerHTML = '<div class="comparison-run"><label>Execução<select id="comparison-run">' + runs.map(r => '<option value="' + esc(r.id) + '"' + (r.id === run.id ? ' selected' : '') + '>' + esc(r.prompt.slice(0, 70)) + '</option>').join('') + '</select></label><code title="Commit-base">' + esc(run.base.slice(0, 12)) + '</code>' + (solution.previous(run.id) ? '<button type="button" data-cmp="reviewSolution">Revisar aplicação</button>' : '') + '<button type="button" data-cmp="new">Nova comparação</button><button type="button" data-cmp="cleanup">Limpar worktrees limpos</button></div><p class="comparison-task">' + esc(run.prompt) + '</p><div class="comparison-columns">' + run.participants.map(p => {
				const session = state.sessions.find(s => s.id === p.sessionId);
				const detail = details.get(p.id);
				const usage = session?.usage || detail?.usage;
				const metrics = usage ? Object.entries(usage).map(([key, value]) => ({ inputTokens: 'Tokens de entrada', outputTokens: 'Tokens de saída', cachedInputTokens: 'Tokens em cache', costUsd: 'Custo informado em USD' }[key] || key) + ' ' + value).join(' · ') : 'Uso e custo indisponíveis neste resultado.';
				const duration = p.startedAt ? Math.max(0, Math.round(((p.endedAt || Date.now()) - p.startedAt) / 1000)) + ' s' : '';
				return '<article class="comparison-card' + (run.selected === p.id ? ' chosen' : '') + '"><h2>' + esc(R.serviceName(undefined, p.service)) + '</h2><p>' + esc(p.model.modelID) + (p.model.variant ? ' · ' + esc(p.model.variant) : '') + '</p><p role="status">' + esc(states[p.status]) + ' · ' + duration + '</p>' +
					'<div class="comparison-actions">' + (p.status === 'running' ? '<button type="button" data-cmp="cancel" data-participant="' + esc(p.id) + '">Parar</button>' : '') +
					'<button type="button" data-cmp="inspect" data-participant="' + esc(p.id) + '"' + (p.removed ? ' disabled' : '') + '>Inspecionar diff</button><button type="button" data-cmp="select" data-participant="' + esc(p.id) + '"' + (p.removed ? ' disabled' : '') + '>' + (run.selected === p.id ? 'Selecionado' : 'Escolher para revisão') + '</button>' + (run.selected === p.id && p.status === 'done' && !p.removed ? '<button type="button" data-cmp="prepareSolution" data-participant="' + esc(p.id) + '">Aplicar ao projeto</button>' : '') + '</div>' +
					'<p class="note">' + esc(metrics) + '</p><pre class="comparison-output">' + esc(session?.result || detail?.result || p.error || session?.summary || (['running', 'preparing'].includes(p.status) ? 'Aguardando resposta do agente…' : 'Nenhuma resposta registrada.')) + '</pre>' +
					(detail ? '<details open><summary>Arquivos e diff</summary><pre>' + esc(detail.files + (detail.untracked ? '\nNovos arquivos\n' + detail.untracked : '') || 'Nenhuma alteração') + '</pre><pre class="comparison-diff">' + esc(detail.diff || 'Nenhum diff') + '</pre><p>' + esc(detail.tests) + '</p><button type="button" data-cmp="openDiff" data-participant="' + esc(p.id) + '">Abrir diff no editor</button><button type="button" data-cmp="openTree" data-participant="' + esc(p.id) + '">Abrir worktree</button></details>' : '') + '</article>';
			}).join('') + '</div>';
			solution.draw(run);
		}
		mode.addEventListener('click', e => { if (e.target.id === 'mode-team') { active = false; solution.close(); team.setActive(true); window.dispatchEvent(new Event('comparisonMode')); return; } if (e.target.id === 'mode-comparison') { setMode(true); } if (e.target.id === 'mode-single') { setMode(false); } });
		config.addEventListener('change', e => {
			if (e.target.id === 'comparison-count') { count = Number(e.target.value); if (count === 3 && !choices[2].catalog) { requestCatalog(2); } }
			else {
				const index = Number(e.target.dataset.index), c = choices[index];
				if (!c) { return; }
				if (e.target.dataset.field === 'service') { c.service = e.target.value; c.catalog = undefined; c.error = undefined; c.modelID = undefined; c.variant = ''; requestCatalog(index); }
				if (e.target.dataset.field === 'model') { [c.providerID, c.modelID] = e.target.value.split('\t'); c.variant = ''; }
				if (e.target.dataset.field === 'effort') { c.variant = e.target.value; }
			}
			drawConfig(); draw();
		});
		results.addEventListener('change', e => { if (e.target.id === 'comparison-run') { selected = e.target.value; drafting = false; draw(); } });
		results.addEventListener('click', e => {
			const button = e.target.closest('button[data-cmp]'); if (!button) { return; }
			const operation = button.dataset.cmp;
			if (operation === 'prepareSolution') { solution.prepare(); vscode.postMessage({ type: 'solutionPrepare', comparisonId: current().id, participantId: button.dataset.participant }); return; }
			if (operation === 'reviewSolution') { solution.review(solution.previous(current().id).id); return; }
			if (operation === 'history') { drafting = false; draw(); return; }
			if (operation === 'new') { selected = undefined; drafting = true; draw(); return; }
			const names = { cancel: 'comparisonCancel', inspect: 'comparisonInspect', select: 'comparisonSelect', cleanup: 'comparisonCleanup', openDiff: 'comparisonOpenDiff', openTree: 'comparisonOpenTree' };
			vscode.postMessage({ type: names[operation], id: current().id, participantId: button.dataset.participant });
		});
		window.addEventListener('message', event => {
			const data = event.data || {};
			if (data.type === 'solutionRecords') { draw(); }
			if (data.type === 'state') { state = data.state; draw(); }
			if (data.type === 'use') { setMode(false); }
			if (data.type === 'comparisons') { runs = data.runs.filter(r => !r.team).sort((a, b) => b.createdAt - a.createdAt); state = data.state; draw(); }
			if (data.type === 'failed' || data.type === 'comparisonError') { pending = false; error = data.message; draw(); }
			if (data.type === 'comparisonCatalog') {
				const c = choices[data.index]; if (c && (!data.catalog || data.catalog.service === c.service)) { c.catalog = data.catalog; c.error = data.error; drawConfig(); draw(); }
			}
			if (data.type === 'comparisonReply') {
				pending = false;
				if (data.operation === 'comparisonCreate') { drafting = false; selected = data.result.id; runs.unshift(data.result); }
				if (data.operation === 'comparisonInspect') { details.set(data.result.participant.id, data.result); }
				draw();
			}
		});
		return {
			draw, active: () => active,
			submit: () => {
				if (team.active()) { return team.submit(); }
				if (!active) { return false; }
				if (running()) { vscode.postMessage({ type: 'comparisonCancel', id: current().id }); return true; }
				if (current()) { drafting = true; selected = undefined; error = ''; drawConfig(); draw(); return true; }
				if (pending || $('send').disabled) { return true; }
				pending = true; error = '';
				vscode.postMessage({ type: 'comparisonCreate', text: $('prompt').value.trim(), participants: choices.slice(0, count).map(c => {
					const model = resolved(c); return { service: c.service, model: { providerID: model.providerID, modelID: model.id, ...(c.variant ? { variant: c.variant } : {}) } };
				}) });
				draw(); return true;
			}
		};
	};
})();
