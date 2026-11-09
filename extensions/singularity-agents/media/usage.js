'use strict';
(function () {
	const vscode = acquireVsCodeApi();
	const root = document.getElementById('services');
	const notice = document.getElementById('notice');
	const fmt = v => v >= 1e9 ? (v / 1e9).toFixed(2).replace('.', ',') + ' bi' : v >= 1e6 ? (v / 1e6).toFixed(1).replace('.', ',') + ' mi' : v >= 1e3 ? (v / 1e3).toFixed(1).replace('.', ',') + ' mil' : String(v);
	const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) { n.className = cls; } if (text !== undefined) { n.textContent = text; } return n; };
	function line(label, t) {
		const row = el('div', 'row'); row.append(el('span', 'l', label));
		row.append(el('span', 'v', t.messages ? fmt(t.input + t.reasoning) + ' entrada · ' + fmt(t.output) + ' saída' + (t.cacheRead + t.cacheWrite ? ' · ' + fmt(t.cacheRead + t.cacheWrite) + ' cache' : '') + (t.cost ? ' · US$ ' + t.cost.toFixed(2).replace('.', ',') : '') : 'sem uso'));
		return row;
	}
	function meter(w) {
		const box = el('div', 'meter ' + (w.usedPercent >= 85 ? 'bad' : w.usedPercent >= 60 ? 'warn' : 'ok'));
		const head = el('div', 'row'); head.append(el('span', '', w.label), el('strong', '', String(w.usedPercent).replace('.', ',') + '% usado')); box.append(head);
		const track = el('div', 'track'); track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', w.label); track.setAttribute('aria-valuenow', String(w.usedPercent));
		const fill = el('div', 'fill'); fill.style.width = Math.min(100, w.usedPercent) + '%'; track.append(fill); box.append(track);
		if (w.resetsAt) { box.append(el('p', 'muted', 'Renova em ' + new Date(w.resetsAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))); } else if (w.resetsText) { box.append(el('p', 'muted', 'Renova ' + w.resetsText)); }
		return box;
	}
	function card(s) {
		const c = el('article', 'card'); c.append(el('h2', '', s.name));
		if (s.plan) { if (s.plan.name) { c.append(el('p', 'muted', 'Plano ' + s.plan.name)); } s.plan.windows.forEach(w => c.append(meter(w))); }
		c.append(line('Hoje', s.today), line('7 dias', s.week), line('30 dias', s.month));
		if (s.models.length) { c.append(el('p', 'muted', 'Modelos (30 dias)')); s.models.slice(0, 5).forEach(m => { const r = el('div', 'row'); r.append(el('span', 'l', m.model), el('span', 'v', fmt(m.month.input + m.month.reasoning + m.month.output) + ' tokens')); c.append(r); }); }
		if (s.note) { c.append(el('p', 'muted', s.note)); }
		return c;
	}
	window.addEventListener('message', event => {
		const m = event.data;
		if (m.type === 'loading') { notice.textContent = 'Lendo…'; }
		else if (m.type === 'error') { notice.textContent = 'Não foi possível ler o uso: ' + m.message; }
		else if (m.type === 'usage') { notice.textContent = 'Atualizado em ' + new Date(m.usage.generatedAt).toLocaleTimeString('pt-BR') + '.'; root.replaceChildren(...m.usage.services.map(card)); }
	});
	const toggle = document.getElementById('claude-plan');
	window.addEventListener('message', event => { if (event.data.type === 'usage') { const on = !!(event.data.usage.settings && event.data.usage.settings.claudePlan); toggle.textContent = on ? 'Ocultar limites do plano Claude' : 'Mostrar limites do plano Claude'; toggle.dataset.on = on ? '1' : ''; } });
	toggle.addEventListener('click', () => vscode.postMessage({ action: toggle.dataset.on ? 'disableClaudePlan' : 'enableClaudePlan' }));
	document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ action: 'refresh' }));
	vscode.postMessage({ action: 'ready' });
})();
