import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { Comparisons, Comparison, Participant } from './comparisons';
import { Solutions, Solution } from './solutions';
import { SessionHistory } from './history';
import { parseSelection } from './catalog';
import { Session, ModelInfo } from './protocol';

export type TeamRole = 'implementer' | 'reviewer' | 'tester';
export interface RoleChoice { service: string; model: ModelInfo }
export interface Findings { verdict: 'approve' | 'changes_requested'; summary: string; issues: Array<{ file: string; line?: number; severity: string; message: string }>; scenarios?: string[] }
interface Step { role: TeamRole; version: number; sessionId: string; status: 'intent' | 'sent' | 'done' | 'failed' | 'cancelled'; startedAt: number; endedAt?: number; result?: string; error?: string }
interface Version { number: number; comparisonId: string; solutionId: string; tree: string; patchHash: string; review?: Findings; testPlan?: Findings; validation?: Solution['validation']; stale?: boolean }
export interface Team {
	id: string; workspace: string; task: string; roles: RoleChoice[]; createdAt: number; updatedAt: number; finishedAt?: number;
	state: 'preparing' | 'running' | 'snapshotting' | 'paused' | 'awaiting-validation' | 'completed' | 'failed' | 'cancelled' | 'exhausted' | 'unrecoverable';
	phase: TeamRole | 'validation'; cycle: number; maxCorrections: number; comparisonId?: string;
	steps: Step[]; versions: Version[]; contextHash?: string; chosen?: boolean; error?: string; resumeRequired?: boolean;
	cancelledRoles?: string[]; pendingFeedback?: string;
	/** What the person asked for after a version was delivered; each one started a new cycle on top of that version. */
	followUps?: Array<{ text: string; at: number }>;
	command?: { executable: string; args: string[]; approved: true };
}

/** A report is a model opinion tied to a specific snapshot, never an independent test result. */
export function parseFindings(text: string): Findings {
	const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
	let value: unknown;
	try { value = JSON.parse(clean); } catch { throw new Error('O agente não entregou um parecer JSON válido.'); }
	const raw = value as Partial<Findings>;
	if (!raw || !['approve', 'changes_requested'].includes(raw.verdict ?? '') || typeof raw.summary !== 'string' || raw.summary.length > 3000 || !Array.isArray(raw.issues) || raw.issues.length > 30) { throw new Error('Parecer estruturado incompatível.'); }
	const issues = raw.issues.map(issue => {
		if (!issue || typeof issue.file !== 'string' || issue.file.length > 220 || typeof issue.message !== 'string' || issue.message.length > 2000 || !['low', 'medium', 'high'].includes(issue.severity) || (issue.line !== undefined && (!Number.isInteger(issue.line) || issue.line < 1))) { throw new Error('Problema de revisão inválido.'); }
		return { file: issue.file, message: issue.message, severity: issue.severity, ...(issue.line ? { line: issue.line } : {}) };
	});
	return { verdict: issues.length ? 'changes_requested' : raw.verdict!, summary: raw.summary, issues,
		...(Array.isArray(raw.scenarios) ? { scenarios: raw.scenarios.filter(s => typeof s === 'string' && s.length <= 1000).slice(0, 20) } : {}) };
}

export class Teams {
	private readonly records = new Map<string, Team>();
	private readonly storage: SessionHistory;
	private readonly busy = new Set<string>();
	private creating = false;
	constructor(directory: string, private readonly comparisons: Comparisons, private readonly solutions: Solutions,
		private readonly sessions: () => Session[], private readonly changed: () => void) {
		this.storage = new SessionHistory(directory, join(__dirname, 'singularity-job.exe'), 'team');
	}
	private save(team: Team, touch = true): void {
		if (touch) { team.updatedAt = Date.now(); if (['completed', 'failed', 'cancelled', 'exhausted', 'unrecoverable'].includes(team.state) && !team.finishedAt) { team.finishedAt = team.updatedAt; } }
		this.storage.save({ id: team.id, harness: 'team', status: 'idle', workspace: team.workspace, updatedAt: team.updatedAt }, { prompt: '', result: JSON.stringify(team), status: 'idle', at: team.updatedAt }, true);
		this.records.set(team.id, team); this.changed();
	}
	active(): boolean { return this.creating || [...this.records.values()].some(t => !['completed', 'failed', 'cancelled', 'exhausted', 'unrecoverable'].includes(t.state)); }
	list(workspace: string): Team[] { return structuredClone([...this.records.values()].filter(t => realpathSync.native(t.workspace).toLowerCase() === realpathSync.native(workspace).toLowerCase()).sort((a, b) => a.createdAt - b.createdAt)); }
	private get(id: string, workspace: string): Team {
		const team = this.records.get(id);
		if (!team || realpathSync.native(team.workspace).toLowerCase() !== realpathSync.native(workspace).toLowerCase()) { throw new Error('Equipe indisponível neste workspace.'); }
		return team;
	}
	async recover(): Promise<void> {
		this.storage.load();
		for (const record of this.storage.list()) {
			try {
				const team = JSON.parse(this.storage.turns(record.id).at(-1)?.result ?? 'null') as Team;
				if (team?.id !== record.id || !Array.isArray(team.steps) || team.steps.length > 9 || !Array.isArray(team.versions) || team.versions.length > 3 || !Array.isArray(team.roles) || team.roles.length !== 3) { continue; }
				const wasTerminal = ['completed', 'failed', 'cancelled', 'exhausted', 'unrecoverable'].includes(team.state);
				const owned = this.comparisons.list(team.workspace).filter(c => c.workflowId === team.id).sort((a, b) => a.createdAt - b.createdAt);
				if (owned.length) { team.comparisonId = owned.at(-1)!.id; }
				if (!['completed', 'failed', 'cancelled', 'exhausted', 'unrecoverable'].includes(team.state)) {
					team.state = 'paused'; team.resumeRequired = true;
					const step = team.steps.at(-1), session = this.sessions().find(s => s.id === step?.sessionId);
					if (step?.status === 'intent' || (step?.status === 'sent' && (!session || session.recovery || (session.historical && session.status !== 'done')))) {
						team.state = 'unrecoverable'; team.error = 'Etapa não recuperável. Nenhum prompt foi reenviado.';
					} else { team.error = 'Hub reiniciado. Retome explicitamente para continuar a equipe.'; }
				}
				this.save(team, !wasTerminal);
			} catch { /* Invalid protected records never authorize inference. */ }
		}
	}
	async start(input: unknown): Promise<Team> {
		const p = input as { workspace?: string; text?: string; participants?: RoleChoice[]; maxCorrections?: number };
		if (this.active()) { throw new Error('Já existe uma equipe em andamento ou pausada. Cancele ou exclua essa equipe antes de iniciar outra.'); }
		if (this.comparisons.active()) { throw new Error('Há uma comparação em andamento. Cancele-a ou espere terminar antes de iniciar uma equipe.'); }
		if (!p || typeof p.workspace !== 'string' || typeof p.text !== 'string' || !p.text.trim() || p.text.length > 7000 || !Array.isArray(p.participants) || p.participants.length !== 3 || !Number.isInteger(p.maxCorrections ?? 2) || (p.maxCorrections ?? 2) < 0 || (p.maxCorrections ?? 2) > 2) { throw new Error('Escolha uma tarefa, três papéis e até dois ciclos de correção.'); }
		const roles = p.participants.map(choice => { const model = parseSelection(choice?.model); if (!choice || !['opencode', 'claude-code', 'codex-cli'].includes(choice.service) || !model) { throw new Error('Selecione um provedor e modelo para cada papel.'); } return { service: choice.service, model }; });
		this.creating = true;
		const team: Team = { id: randomUUID(), workspace: p.workspace, task: p.text, roles, createdAt: Date.now(), updatedAt: Date.now(), state: 'preparing', phase: 'implementer', cycle: 0, maxCorrections: p.maxCorrections ?? 2, steps: [], versions: [] };
		this.save(team);
		try {
			await this.allocate(team);
			await this.dispatch(team, 'implementer', this.implementationPrompt(team));
			return structuredClone(team);
		} catch (error) { team.state = 'failed'; team.error = error instanceof Error ? error.message : 'Equipe não iniciada.'; this.save(team); throw error; }
		finally { this.creating = false; }
	}
	private group(team: Team): Comparison {
		const group = this.comparisons.list(team.workspace).find(r => r.id === team.comparisonId);
		if (!group?.team) { throw new Error('Contexto Git da equipe indisponível.'); }
		return group;
	}
	private participant(team: Team, role: TeamRole): Participant { return this.group(team).participants[['implementer', 'reviewer', 'tester'].indexOf(role)]; }
	private async allocate(team: Team): Promise<void> {
		const group = await this.comparisons.create({ workspace: team.workspace, text: team.task, participants: team.roles }, true, team.id);
		team.workspace = group.workspace; team.comparisonId = group.id; team.contextHash = undefined;
		if (group.participants.some(p => p.status !== 'idle')) { throw new Error(group.participants.find(p => p.error)?.error ?? 'Provedor indisponível.'); }
		if (team.state === 'cancelled') { await this.comparisons.teamStop(group.id, team.workspace); return; }
		this.save(team);
	}
	private implementationPrompt(team: Team, feedback?: string): string {
		return `Papel: implementador. Versão ${team.cycle + 1}. Trabalhe somente no worktree atual. Produza arquivos reais com ferramentas de edição. A revisão e os testes independentes serão conduzidos nas etapas próprias. Não execute comandos de shell, testes ou outras CLIs nesta etapa. Nunca aplique no projeto principal.\nTarefa original:\n${team.task}\n${feedback ? 'Feedback verificável da versão anterior:\n' + feedback : ''}`;
	}
	private async dispatch(team: Team, role: TeamRole, prompt: string): Promise<void> {
		if (team.state === 'cancelled') { return; }
		if (prompt.length > 16000) { throw new Error('O contexto desta etapa excede o limite de envio.'); }
		const participant = this.participant(team, role);
		const sessionId = await this.comparisons.teamSession(team.comparisonId!, team.workspace, participant.id);
		if ((team.state as Team['state']) === 'cancelled') { await this.comparisons.teamStopRole(team.comparisonId!, team.workspace, participant.id); return; }
		const step: Step = { role, version: team.cycle + 1, sessionId, status: 'intent', startedAt: Date.now() };
		team.phase = role; team.state = 'running'; team.steps.push(step); this.save(team);
		await this.comparisons.teamPrompt(team.comparisonId!, team.workspace, participant.id, prompt);
		step.status = 'sent'; this.save(team);
		setImmediate(() => { const session = this.sessions().find(s => s.id === step.sessionId); if (session) { this.onSession(session); } });
	}
	onSession(session: Session): void {
		for (const team of this.records.values()) {
			const step = team.steps.at(-1);
			if (!step || step.sessionId !== session.id || step.status !== 'sent' || this.busy.has(team.id) || team.state !== 'running' || team.resumeRequired || !['done', 'failed', 'idle'].includes(session.status)) { continue; }
			void this.settle(team, session).catch(error => { if (team.state === 'cancelled') { return; } team.state = 'paused'; team.error = error instanceof Error ? error.message : 'Etapa interrompida.'; this.save(team); });
		}
	}
	private async settle(team: Team, session: Session): Promise<void> {
		this.busy.add(team.id);
		try {
			const step = team.steps.at(-1)!;
			if (session.status !== 'done' || session.recovery) { step.status = session.status === 'idle' ? 'cancelled' : 'failed'; team.state = session.recovery ? 'unrecoverable' : 'paused'; step.error = session.summary ?? 'A etapa não terminou com sucesso.'; team.error = step.error; this.save(team); return; }
			step.result = await this.comparisons.teamResult(team.comparisonId!, team.workspace, this.participant(team, step.role).id);
			step.status = 'done'; step.endedAt = Date.now(); this.save(team);
			await this.advance(team);
		} finally { this.busy.delete(team.id); const current = this.sessions().find(s => s.id === team.steps.at(-1)?.sessionId); if (current) { setImmediate(() => this.onSession(current)); } }
	}
	private async advance(team: Team): Promise<void> {
		if (team.state === 'cancelled' || team.resumeRequired) { return; }
		const step = team.steps.at(-1)!;
		if (step.role === 'implementer') {
			team.state = 'snapshotting'; this.save(team);
			const impl = this.participant(team, 'implementer');
			this.comparisons.select(team.comparisonId!, team.workspace, impl.id);
			const existing = team.versions.find(v => v.number === team.cycle + 1);
			if (existing) { await this.assess(team, 'reviewer'); return; }
			const solution = await this.solutions.prepare(team.comparisonId!, team.workspace, impl.id);
			team.versions.push({ number: team.cycle + 1, comparisonId: team.comparisonId!, solutionId: solution.id, tree: solution.tree, patchHash: solution.patchHash }); this.save(team);
			await this.assess(team, 'reviewer'); return;
		}
		const version = team.versions.at(-1)!;
		const participant = this.participant(team, step.role);
		if (team.contextHash !== await this.solutions.snapshotFingerprint(version.solutionId, team.workspace, participant.workspace)) { throw new Error('O avaliador modificou sua cópia de inspeção. O parecer foi invalidado.'); }
		const report = parseFindings(step.result ?? '');
		await this.comparisons.teamStopRole(team.comparisonId!, team.workspace, participant.id);
		if (step.role === 'reviewer') {
			version.review = report; this.save(team);
			if (report.verdict === 'changes_requested') { await this.correct(team, JSON.stringify(report)); return; }
			await this.assess(team, 'tester'); return;
		}
		version.testPlan = report; this.save(team);
		if (report.verdict === 'changes_requested') { await this.correct(team, JSON.stringify(report)); return; }
		team.phase = 'validation'; team.state = 'awaiting-validation'; this.save(team);
		if (team.command) { await this.runTests(team); }
	}
	private async assess(team: Team, role: 'reviewer' | 'tester'): Promise<void> {
		const version = team.versions.at(-1)!, participant = this.participant(team, role);
		if (!team.contextHash || team.contextHash !== await this.solutions.snapshotFingerprint(version.solutionId, team.workspace, participant.workspace)) { team.contextHash = await this.solutions.exportSnapshot(version.solutionId, team.workspace, participant.workspace); } this.save(team);
		const review = await this.solutions.review(version.solutionId, team.workspace) as { diff: string };
		const context = review.diff.length <= 6500 ? review.diff : 'O diff excede o contexto textual. Inspecione os arquivos reais no worktree atual.';
		await this.dispatch(team, role, `Papel: ${role === 'reviewer' ? 'revisor' : 'testador'}. Snapshot imutável ${version.tree}, versão ${version.number}. Esta cópia isolada contém a implementação real. Inspecione os arquivos com ferramentas de leitura. Não altere arquivos e não execute comandos ou testes. Nunca altere o worktree de outro participante. Testes independentes serão executados apenas por um comando autorizado pelo usuário.\nTarefa e critérios:\n${team.task}\nDiff:\n${context}\nResponda SOMENTE JSON válido, sem markdown, no formato {"verdict":"approve" ou "changes_requested","summary":"parecer","issues":[{"file":"caminho","line":1,"severity":"high","message":"problema concreto"}],"scenarios":["cenário"]}. Use issues vazio quando não houver defeitos. Uma solicitação de defeito intencional inicial serve somente como fixture; os critérios finais de correção devem ser satisfeitos.`);
	}
	private async correct(team: Team, feedback: string): Promise<void> {
		if (team.state === 'cancelled') { return; }
		const previous = team.versions.at(-1)!;
		await this.comparisons.teamStop(team.comparisonId!, team.workspace);
		if ((team.state as Team['state']) === 'cancelled') { return; }
		if (team.cycle >= team.maxCorrections) { team.state = 'exhausted'; team.error = 'Limite de ciclos atingido. Os problemas permanecem no relatório.'; this.save(team); return; }
		team.pendingFeedback = feedback.slice(0, 4500); team.phase = 'implementer';
		previous.stale = true; team.cycle++; team.chosen = false; team.state = 'preparing'; this.save(team);
		await this.allocate(team);
		team.contextHash = await this.solutions.exportSnapshot(previous.solutionId, team.workspace, this.participant(team, 'implementer').workspace); this.save(team);
		await this.dispatch(team, 'implementer', this.implementationPrompt(team, feedback.slice(0, 4500)));
	}
	async validate(id: string, workspace: string, command: { executable?: unknown; args?: unknown; approved?: unknown }): Promise<Team> {
		const team = this.get(id, workspace);
		if (team.state !== 'awaiting-validation' || this.busy.has(id) || command?.approved !== true || typeof command.executable !== 'string' || !Array.isArray(command.args) || !command.args.every(a => typeof a === 'string')) { throw new Error('Autorize um comando de teste para esta versão da equipe.'); }
		team.command = { executable: command.executable, args: command.args, approved: true }; this.save(team);
		this.busy.add(id); try { await this.runTests(team, true); return structuredClone(team); } finally { this.busy.delete(id); }
	}
	private async runTests(team: Team, freshlyAuthorized = false): Promise<void> {
		const version = team.versions.at(-1)!;
		const saved = this.solutions.list(team.workspace).find(s => s.id === version.solutionId)!;
		if (saved.validation.state === 'interrupted' && !freshlyAuthorized) { team.command = undefined; team.state = 'awaiting-validation'; team.error = 'Teste interrompido. Autorize explicitamente uma nova execução.'; this.save(team); return; }
		const sameCommand = saved.validation.executable === team.command?.executable && JSON.stringify(saved.validation.args) === JSON.stringify(team.command?.args);
		const solution = saved.validation.state === 'passed' && sameCommand ? saved : await this.solutions.validate(version.solutionId, team.workspace, team.command!);
		version.validation = solution.validation; this.save(team);
		if (team.state === 'cancelled') { return; }
		if (solution.validation.state !== 'passed') { await this.correct(team, 'Resultado independente do comando autorizado: ' + JSON.stringify(solution.validation)); return; }
		team.state = 'completed'; team.error = undefined; this.save(team);
	}
	async cancel(id: string, workspace: string, role?: string): Promise<void> {
		const team = this.get(id, workspace);
		if (role && (!['implementer', 'reviewer', 'tester'].includes(role) || (team.phase !== role && !(team.phase === 'validation' && role === 'tester')))) { throw new Error('Papel inválido.'); }
		if (role) { team.cancelledRoles = [...new Set([...(team.cancelledRoles ?? []), role])]; }
		team.state = role ? 'paused' : 'cancelled'; team.resumeRequired = !!role; team.error = role ? 'Participante cancelado. A equipe aguarda encerramento ou inspeção.' : undefined; this.save(team);
		const version = team.versions.at(-1);
		if (version && (!role || role === 'tester')) { await this.solutions.cancelValidation(version.solutionId, team.workspace); }
		while (this.busy.has(id)) { await new Promise(resolve => setTimeout(resolve, 50)); }
		if (team.comparisonId) {
			if (role) { const p = this.participant(team, role as TeamRole); await this.comparisons.cancel(team.comparisonId, team.workspace, p.id); }
			else { for (const group of this.comparisons.list(team.workspace).filter(c => c.workflowId === team.id || c.id === team.comparisonId)) { await this.comparisons.cancel(group.id, team.workspace); await this.comparisons.teamStop(group.id, team.workspace); } }
		}
	}
	/**
	 * A new instruction from the person after the team delivered a version: it becomes part of the task (so the reviewer and the tester judge
	 * against it too) and starts one more cycle on top of the current version. Only for a team that is not working.
	 */
	async instruct(id: string, workspace: string, text: unknown): Promise<Team> {
		const team = this.get(id, workspace);
		if (typeof text !== 'string' || !text.trim() || text.length > 3000) { throw new Error('Escreva a nova instrução (até 3000 caracteres).'); }
		if (!['completed', 'awaiting-validation', 'exhausted'].includes(team.state) || this.busy.has(id) || !team.versions.length) { throw new Error('A equipe só recebe uma nova instrução depois de entregar uma versão e parar de trabalhar.'); }
		const task = team.task + '\n\nInstrução adicional do usuário:\n' + text.trim();
		if (task.length > 7000) { throw new Error('A tarefa com as instruções ficou longa demais. Crie uma equipe nova com o pedido completo.'); }
		this.busy.add(id);
		try {
			team.task = task; team.followUps = [...(team.followUps ?? []), { text: text.trim(), at: Date.now() }];
			team.maxCorrections = Math.max(team.maxCorrections, team.cycle + 1); team.error = undefined; team.finishedAt = undefined; team.command = undefined; this.save(team);
			await this.correct(team, 'Nova instrução do usuário, a cumprir sobre a versão atual: ' + text.trim());
		} catch (error) { if ((team.state as Team['state']) !== 'cancelled') { team.state = 'paused'; team.error = error instanceof Error ? error.message : 'A nova instrução não pôde ser iniciada.'; this.save(team); } throw error; }
		finally { this.busy.delete(id); const current = this.sessions().find(s => s.id === team.steps.at(-1)?.sessionId); if (current) { setImmediate(() => this.onSession(current)); } }
		return structuredClone(team);
	}
	/** Removes a team that is not working: its agents are stopped, their isolated worktrees cleaned and the record forgotten. The project itself is never touched. */
	async delete(id: string, workspace: string): Promise<void> {
		const team = this.get(id, workspace);
		if (['preparing', 'running', 'snapshotting'].includes(team.state)) { throw new Error('Cancele a equipe antes de excluí-la.'); }
		if (team.state === 'paused' || team.state === 'awaiting-validation') { await this.cancel(id, workspace); }
		while (this.busy.has(id)) { await new Promise(resolve => setTimeout(resolve, 50)); }
		for (const group of this.comparisons.list(team.workspace).filter(c => c.workflowId === id || c.id === team.comparisonId)) { await this.comparisons.cleanup(group.id, team.workspace).catch(() => undefined); }
		this.storage.delete(id); this.records.delete(id); this.changed();
	}
	async resume(id: string, workspace: string): Promise<Team> {
		const team = this.get(id, workspace), step = team.steps.at(-1);
		if (team.state !== 'paused' || team.cancelledRoles?.length || this.busy.has(id) || !step || step.status === 'intent' || step.status === 'cancelled' || step.status === 'failed') { throw new Error('Retomada insegura. Nenhum prompt será reenviado.'); }
		team.resumeRequired = false; team.error = undefined; team.state = 'running'; this.save(team);
		if (step.status === 'done') { this.busy.add(id); try { await this.advance(team); } finally { this.busy.delete(id); } }
		else {
			const session = this.sessions().find(s => s.id === step.sessionId);
			if (!session || session.recovery || session.historical && session.status !== 'done') { team.state = 'unrecoverable'; this.save(team); throw new Error('Sessão não recuperável.'); }
			if (session.status === 'done') { await this.settle(team, session); }
		}
		return structuredClone(team);
	}
	choose(id: string, workspace: string): void {
		const team = this.get(id, workspace);
		if (team.state !== 'completed') { throw new Error('Conclua os pareceres e a validação independente antes de escolher o resultado.'); }
		team.chosen = true; this.save(team);
	}
	async prepare(id: string, workspace: string): Promise<unknown> {
		const team = this.get(id, workspace);
		if (team.state !== 'completed' || !team.chosen) { throw new Error('Escolha explicitamente a versão final concluída.'); }
		return this.solutions.review(team.versions.at(-1)!.solutionId, team.workspace);
	}
}
