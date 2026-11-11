(function () {
	'use strict';
	window.SingularityTeam = function (vscode, R, app, solution) {
		const $ = id => document.getElementById(id), esc = R.esc;
		const STARTER = 'Descreva o que deseja desenvolver…';
		const roleNames = ['Implementador', 'Revisor', 'Testador'];
		const roleIds = ['implementer', 'reviewer', 'tester'];
		const labels = { preparing: 'Preparando equipe', running: 'Em execução', snapshotting: 'Criando snapshot', paused: 'Equipe pausada', 'awaiting-validation': 'Aguardando testes autorizados', completed: 'Resultado concluído', failed: 'Falha', cancelled: 'Cancelada', exhausted: 'Limite de correções atingido', unrecoverable: 'Equipe não recuperável' };
		let active = false, drafting = false, runs = [], selected, pending = false, error = '', signature, stopping;
		let state = { sessions: [], hub: {} }, cycles = 2, executable = 'node', argumentsJson = '["--test"]';
		const choices = roleIds.map(() => ({ service: 'opencode' }));
		const config = document.createElement('section'); config.id = 'team-config'; config.hidden = true;
		$('composer').querySelector('label[for="prompt"]').before(config);
		const results = document.createElement('section'); results.id = 'team-results'; results.hidden = true; app.querySelector('.list').append(results);
		const current = () => drafting ? undefined : runs.find(t => t.id === selected) || runs.at(-1);
		const final = run => run && ['completed', 'failed', 'cancelled', 'exhausted', 'unrecoverable'].includes(run.state);
		/** A team that delivered a version and stopped working can be answered: the instruction opens one more cycle on top of that version. */
		const answerable = run => !!run && ['completed', 'awaiting-validation', 'exhausted'].includes(run.state) && Array.isArray(run.versions) && run.versions.length > 0;
		const models = choice => (choice.catalog?.providers || []).flatMap(p => p.models.map(m => ({ ...m, providerID: p.id })));
		const model = choice => models(choice).find(m => m.id === choice.modelID && m.providerID === choice.providerID) || models(choice)[0];
		function catalog(index) { vscode.postMessage({ type: 'teamCatalog', index, service: choices[index].service }); }
		function configure() {
			config.innerHTML = '<p>A tarefa seguirá os três papéis em sequência. Cada papel terá seu próprio worktree. O mesmo modelo pode ser usado em sessões independentes.</p><div class="team-roles">' + choices.map((choice, index) => {
				const picked = model(choice);
				return '<fieldset><legend>' + roleNames[index] + '</legend><label>Provedor<select data-team-index="' + index + '" data-team-field="service">' + ['opencode', 'claude-code', 'codex-cli'].map(service => {
					const known = choice.catalog?.services?.find(s => s.id === service), unavailable = known && known.status !== 'available';
					return '<option value="' + service + '"' + (service === choice.service ? ' selected' : '') + (unavailable ? ' disabled' : '') + '>' + esc(R.serviceName(undefined, service)) + (unavailable ? ' · indisponível' : '') + '</option>';
				}).join('') + '</select></label><label>Modelo<select data-team-index="' + index + '" data-team-field="model">' + models(choice).map(m => '<option value="' + esc(m.providerID + '\t' + m.id) + '"' + (m.id === picked?.id && m.providerID === picked?.providerID ? ' selected' : '') + '>' + esc(m.name || m.id) + '</option>').join('') + '</select></label><label>Esforço<select data-team-index="' + index + '" data-team-field="effort"><option value="">Padrão do modelo</option>' + (picked?.efforts || []).map(e => '<option value="' + esc(e) + '"' + (choice.variant === e ? ' selected' : '') + '>' + esc(R.effortLabel(e)) + '</option>').join('') + '</select></label><p role="status">' + esc(choice.error || choice.catalog?.unavailable || '') + '</p></fieldset>';
			}).join('') + '</div><label>Limite de correções<select id="team-cycles">' + [0, 1, 2].map(n => '<option value="' + n + '"' + (cycles === n ? ' selected' : '') + '>' + n + '</option>').join('') + '</select></label>';
		}
		function findings(report) {
			return report ? '<p>' + esc(report.verdict === 'approve' ? 'Parecer favorável do agente' : 'Correções solicitadas pelo agente') + '</p><p>' + esc(report.summary) + '</p><ul>' + report.issues.map(issue => '<li>' + esc(issue.file + (issue.line ? ' · linha ' + issue.line : '') + ' · ' + issue.message) + '</li>').join('') + '</ul>' : '<p>Aguardando parecer.</p>';
		}
		function draw() {
			if (!active) { return; }
			const run = current(), open = solution.isOpen();
			$('mode-single').setAttribute('aria-pressed', 'false'); $('mode-comparison').setAttribute('aria-pressed', 'false'); $('mode-team').setAttribute('aria-pressed', 'true');
			$('sessions').hidden = true; $('comparison-results').hidden = true; $('comparison-config').hidden = true;
			config.hidden = !!run || open; results.hidden = open; $('composer').hidden = open;
			$('composer').querySelector('.selectors').hidden = true; $('target').hidden = true; $('new').hidden = true;
			$('prompt').maxLength = 7000;
			const reply = answerable(run), working = !!run && !final(run) && !reply;
			if (stopping && (!run || run.id !== stopping || final(run))) { stopping = undefined; }
			const stopLabel = stopping ? 'Parando…' : 'Parar';
			$('send').textContent = working ? stopLabel : pending ? 'Aguarde…' : !run ? 'Iniciar equipe' : reply ? 'Enviar' : final(run) ? 'Nova equipe' : stopLabel;
			$('send').disabled = state.hub?.status !== 'connected' || (working ? !!stopping : pending) || ((!run || reply) && (!$('prompt').value.trim() || (!run && !choices.every(c => !!model(c)))));
			$('send').classList.toggle('interrupt', working);
			$('send').title = reply ? 'Enviar esta instrução à equipe, sobre a versão atual' : working ? 'Parar a equipe: os agentes em execução são interrompidos' : '';
			$('prompt').placeholder = reply ? 'Responda à equipe: o que falta ou o que mudar…' : working ? 'A equipe está trabalhando. Você poderá responder quando ela parar.' : STARTER;
			$('prompt').disabled = working;
			$('note').textContent = error || (reply ? 'A resposta vai para o Implementador sobre a versão atual; o Revisor e o Testador avaliam de novo.' : run ? 'Os pareceres dos agentes e os testes independentes são registrados separadamente por versão.' : 'Os modelos selecionados executarão em sequência, com até dois ciclos de correção.');
			const next = [run?.id, run?.updatedAt, error, drafting].join(':');
			if (next !== signature) {
				signature = next;
				if (!run) { results.innerHTML = '<h2>Modo Equipe</h2><p>Implemente, revise e teste em worktrees isolados antes de escolher a solução final.</p>'; }
				else {
					const version = run.versions.at(-1);
					results.innerHTML = '<div class="team-heading"><h2>Equipe</h2><select id="team-history" aria-label="Histórico de equipes">' + runs.map(t => '<option value="' + esc(t.id) + '"' + (t.id === run.id ? ' selected' : '') + '>' + esc(t.task.slice(0, 60)) + '</option>').join('') + '</select></div><p class="team-task">' + esc(run.task) + '</p><p role="status" id="team-status">' + esc(labels[run.state]) + ' · ' + esc(roleNames[roleIds.indexOf(run.phase)] || 'Validação independente') + '</p><p>Correções ' + run.cycle + ' / ' + run.maxCorrections + ' · <span id="team-time"></span></p><p role="alert">' + esc(run.error || error) + '</p><div class="team-roles">' + run.roles.map((choice, index) => {
						const step = run.steps.filter(s => s.role === roleIds[index]).at(-1);
						return '<article class="team-role"><h3>' + roleNames[index] + '</h3><p>' + esc(R.serviceName(undefined, choice.service) + ' · ' + choice.model.modelID + ' · ' + (choice.model.variant || 'padrão')) + '</p><p>' + esc(step?.status || 'Aguardando') + '</p>' + (step ? '<button type="button" data-team="inspect" data-session="' + esc(step.sessionId) + '">Inspecionar participante</button>' : '') + (run.phase === roleIds[index] && run.state === 'running' ? '<button type="button" data-team="cancel-role" data-role="' + roleIds[index] + '">Cancelar participante</button>' : '') + '</article>';
					}).join('') + '</div><pre class="team-live"></pre><div class="team-actions">' + (run.state === 'paused' ? '<button type="button" data-team="resume">Retomar quando seguro</button>' : '') + (!final(run) ? '<button type="button" data-team="cancel">Parar equipe</button>' : '') + (final(run) || answerable(run) ? '<button type="button" data-team="new">Nova equipe</button><button type="button" data-team="delete">Excluir equipe</button>' : '') + (run.state === 'completed' ? '<button type="button" data-team="choose">Escolher solução final</button><button type="button" data-team="prepare"' + (!run.chosen ? ' disabled' : '') + '>Preparar aplicação</button>' : '') + '</div>' + run.versions.map(v => '<section class="team-version"><h3>Versão ' + v.number + (v.stale ? ' · pareceres anteriores invalidados para a versão atual' : '') + '</h3><code>' + esc(v.tree) + '</code><details open><summary>Revisão estruturada</summary>' + findings(v.review) + '</details><details><summary>Parecer do testador</summary>' + findings(v.testPlan) + '</details><p>Testes independentes ' + esc(v.validation?.state || 'ainda não executados') + (v.validation?.exitCode !== undefined ? ' · saída ' + v.validation.exitCode : '') + '</p><pre>' + esc(v.validation?.output || '') + '</pre></section>').join('') + (run.state === 'awaiting-validation' ? '<section class="solution-validation"><h3>Autorizar testes independentes</h3><p>O comando será executado na cópia Git desta versão e poderá ser repetido nas correções configuradas, com as permissões da sua conta.</p><label>Executável<input id="team-test-executable" value="' + esc(executable) + '"></label><label>Argumentos JSON<input id="team-test-arguments" value="' + esc(argumentsJson) + '"></label><button type="button" data-team="validate">Autorizar e executar testes</button></section>' : '');
				}
			}
			const step = run?.steps.at(-1), live = state.sessions.find(s => s.id === step?.sessionId)?.result || step?.result || '';
			const output = results.querySelector('.team-live'); if (output) { output.textContent = live; }
			solution.draw();
		}
		config.addEventListener('change', e => {
			if (e.target.id === 'team-cycles') { cycles = Number(e.target.value); return; }
			const index = Number(e.target.dataset.teamIndex), choice = choices[index]; if (!choice) { return; }
			if (e.target.dataset.teamField === 'service') { choice.service = e.target.value; choice.catalog = undefined; choice.modelID = undefined; choice.variant = ''; catalog(index); }
			if (e.target.dataset.teamField === 'model') { [choice.providerID, choice.modelID] = e.target.value.split('\t'); choice.variant = ''; }
			if (e.target.dataset.teamField === 'effort') { choice.variant = e.target.value; }
			configure(); draw();
		});
		results.addEventListener('input', e => { if (e.target.id === 'team-test-executable') { executable = e.target.value; } if (e.target.id === 'team-test-arguments') { argumentsJson = e.target.value; } });
		results.addEventListener('change', e => { if (e.target.id === 'team-history') { selected = e.target.value; draw(); } });
		results.addEventListener('click', e => {
			const button = e.target.closest('button[data-team]'); if (!button || button.disabled) { return; }
			const action = button.dataset.team;
			if (action === 'new') { drafting = true; signature = undefined; configure(); draw(); return; }
			if (action === 'delete') { vscode.postMessage({ type: 'teamDelete', id: current().id }); return; }
			if (action === 'inspect') { vscode.postMessage({ type: 'teamInspect', sessionId: button.dataset.session }); return; }
			if (action === 'validate') {
				let args; try { args = JSON.parse(argumentsJson); if (!Array.isArray(args)) { throw new Error(); } } catch { error = 'Informe uma lista JSON de argumentos.'; draw(); return; }
				vscode.postMessage({ type: 'teamValidate', id: current().id, executable, args });
			} else { if (action === 'cancel') { stopping = current().id; draw(); } vscode.postMessage({ type: { resume: 'teamResume', cancel: 'teamCancel', 'cancel-role': 'teamCancel', choose: 'teamChoose', prepare: 'teamPrepare' }[action], id: current().id, role: button.dataset.role }); }
		});
		window.addEventListener('solutionClosed', draw);
		window.addEventListener('message', ({ data }) => {
			if (data?.type === 'providerProfileChanged') { choices.forEach((c,i)=>{ c.catalog=undefined;c.error=undefined;if(active) { catalog(i); } });signature=undefined;draw(); }
			if (data?.type === 'teams') { runs = data.runs; state = data.state; draw(); }
			if (data?.type === 'teamCatalog') { const choice = choices[data.index]; if (choice && (!data.catalog || data.catalog.service === choice.service)) { choice.catalog = data.catalog; choice.error = data.error; configure(); draw(); } }
			if (data?.type === 'teamReply') { pending = false; if (data.operation === 'teamCancel') { stopping = undefined; } if (data.operation === 'teamInstruct' && data.result?.id) { $('prompt').value = ''; $('prompt').dispatchEvent(new Event('input', { bubbles: true })); } if (data.operation === 'teamDelete') { selected = undefined; } if (data.result?.id && Array.isArray(data.result.roles)) { selected = data.result.id; drafting = false; } signature = undefined; draw(); }
			if (data?.type === 'failed' && active) { pending = false; stopping = undefined; error = data.message; signature = undefined; draw(); }
			if (data?.type === 'solutionReview' && active) { draw(); }
		});
		setInterval(() => { const span = $('team-time'), run = current(); if (active && run && span) { span.textContent = final(run) && !run.finishedAt ? 'Tempo indisponível' : Math.max(0, Math.floor(((final(run) ? run.finishedAt : Date.now()) - run.createdAt) / 1000)) + ' s'; } }, 1000);
		return {
			active: () => active, draw,
			setActive(value) { active = value; if (value) { choices.forEach((c, i) => { if (!c.catalog) { catalog(i); } }); vscode.postMessage({ type: 'teamList' }); configure(); } else { config.hidden = true; results.hidden = true; $('prompt').maxLength = 16000; $('prompt').placeholder = STARTER; $('prompt').disabled = false; } draw(); },
			submit() {
				if (!active) { return false; } const run = current();
				if (run && answerable(run)) {
					const text = $('prompt').value.trim(); if (pending || !text || $('send').disabled) { return true; }
					pending = true; error = ''; vscode.postMessage({ type: 'teamInstruct', id: run.id, text }); draw(); return true;
				}
				if (run) { if (final(run)) { drafting = true; signature = undefined; configure(); draw(); } else if (!stopping) { stopping = run.id; vscode.postMessage({ type: 'teamCancel', id: run.id }); draw(); } return true; }
				if (pending || $('send').disabled) { return true; }
				pending = true; error = ''; vscode.postMessage({ type: 'teamStart', text: $('prompt').value.trim(), maxCorrections: cycles, participants: choices.map(c => { const m = model(c); return { service: c.service, model: { providerID: m.providerID, modelID: m.id, ...(c.variant ? { variant: c.variant } : {}) } }; }) }); draw(); return true;
			}
		};
	};
})();
