import { followLineEndings, lineEndingArgs } from './gitconfig';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { realpathSync, existsSync } from 'node:fs';
import { realpath, lstat, readFile, mkdir } from 'node:fs/promises';
import { join, dirname, isAbsolute, sep } from 'node:path';
import { SessionHistory } from './history';
import { ensureSecureDir } from './secure';
import { Session, ModelInfo } from './protocol';
import { parseSelection } from './catalog';

const execute = promisify(execFile);
const services = ['opencode', 'claude-code', 'codex-cli'];
export type ParticipantStatus = 'preparing' | 'running' | 'done' | 'failed' | 'cancelled' | 'unrecoverable' | 'idle';
export interface Participant {
	id: string;
	service: string;
	model: ModelInfo;
	workspace: string;
	sessionId?: string;
	status: ParticipantStatus;
	role?: 'implementer' | 'reviewer' | 'tester';
	startedAt?: number;
	endedAt?: number;
	error?: string;
	removed?: boolean;
}
export interface Comparison {
	id: string;
	workspace: string;
	base: string;
	prompt: string;
	createdAt: number;
	selected?: string;
	team?: boolean;
	workflowId?: string;
	participants: Participant[];
}
interface Adapter {
	create(workspace: string, service: string, model: ModelInfo, role?: 'implementer' | 'reviewer' | 'tester', profileWorkspace?: string): Promise<Session>;
	prompt(id: string, text: string): void;
	stop(id: string): Promise<void>;
	list(): Session[];
	history?(id: string, workspace: string): Promise<import('./history').Turn[]>;
}

/** Owns the grouping and Git lifecycle. Inference and streaming belong to the existing adapters. */
export class Comparisons {
	private readonly records = new Map<string, Comparison>();
	private readonly storage: SessionHistory;
	private readonly busy = new Set<string>();
	private creating = false;
	private readonly cancelling = new Set<string>();
	constructor(private directory: string, private readonly adapter: Adapter, private readonly changed: () => void) {
		if (existsSync(directory)) { this.directory = realpathSync.native(directory); }
		this.storage = new SessionHistory(join(directory, 'records'), join(__dirname, 'singularity-job.exe'), 'comparison');
	}

	async recover(): Promise<void> {
		this.storage.load();
		for (const session of this.storage.list()) {
			try {
				const record = JSON.parse(this.storage.turns(session.id).at(-1)?.result ?? 'null') as Comparison;
				if (record?.id !== session.id || !Array.isArray(record.participants) || record.participants.length < 2 || record.participants.length > 3) { continue; }
				if (record.participants.some(p => !services.includes(p.service) || !this.validWorktree(record, p) || !/^[0-9a-f-]{36}$/.test(p.id))) { continue; }
				this.records.set(record.id, record);
				for (const p of record.participants) {
					if (p.status !== 'running' && p.status !== 'preparing') { continue; }
					const candidates = this.adapter.list().filter(s => s.workspace?.toLowerCase() === p.workspace.toLowerCase() && s.harness === p.service);
					const live = p.sessionId ? candidates.find(s => s.id === p.sessionId) : candidates.length === 1 ? candidates[0] : undefined;
					if (live) { p.sessionId = live.id; }
					if (live && !live.historical && !live.recovery && live.workspace?.toLowerCase() === p.workspace.toLowerCase()) {
						p.status = live.status === 'done' ? 'done' : live.status === 'failed' ? 'failed' : live.status === 'idle' ? 'unrecoverable' : 'running';
						if (p.status === 'unrecoverable') { p.error = 'A execução não foi confirmada após a interrupção. A tarefa foi preservada e nenhum prompt foi reenviado.'; }
					} else { p.status = 'unrecoverable'; p.error = 'Sessão não recuperável após a interrupção do Hub.'; }
					if (p.status !== 'running') { p.endedAt = Date.now(); }
				}
				this.save(record);
			} catch { /* Invalid protected records cannot authorize Git operations. */ }
		}
	}

	private worktreeRoot(workspace: string, id: string): string {
		const identity = createHash('sha256').update(workspace.toLowerCase()).digest('hex').slice(0, 16);
		return join(dirname(workspace), '.singularity-worktrees', identity, id);
	}
	private validWorktree(record: Comparison, participant: Participant): boolean {
		return participant.workspace === join(this.directory, record.id, participant.id) || participant.workspace === join(this.worktreeRoot(record.workspace, record.id), participant.id);
	}
	private save(record: Comparison): void {
		this.storage.save({ id: record.id, harness: 'comparison', status: 'idle', workspace: record.workspace, updatedAt: Date.now() },
			{ prompt: '', result: JSON.stringify(record), status: 'idle', at: Date.now() }, true);
		this.changed();
	}

	list(workspace: string): Comparison[] {
		return structuredClone([...this.records.values()].filter(r => r.workspace.toLowerCase() === realpathSync.native(workspace).toLowerCase()));
	}

	private get(id: string, workspace: string): Comparison {
		const record = this.records.get(id);
		if (!record || record.workspace.toLowerCase() !== realpathSync.native(workspace).toLowerCase()) { throw new Error('Comparação indisponível neste workspace.'); }
		return record;
	}

	private async git(workspace: string, args: string[]): Promise<string> {
		const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
		for (const key of Object.keys(env)) { if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT') { delete env[key]; } }
		// No global or system configuration of the person, except how line endings are stored (see gitconfig.ts): a worktree then holds the same
		// bytes as the project it came from, and every later check (snapshots, review, apply) reads them the same way.
		Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
		const lineEndings = await lineEndingArgs(workspace);
		const { stdout } = await execute('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...lineEndings, '-C', workspace, ...args],
			{ env, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
		return stdout;
	}

	async create(params: unknown, team = false, workflowId?: string): Promise<Comparison> {
		const input = params as { workspace?: unknown; text?: unknown; participants?: unknown };
		if (this.creating || typeof input?.workspace !== 'string' || !isAbsolute(input.workspace) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16000 || !Array.isArray(input.participants) || input.participants.length < 2 || input.participants.length > 3) { throw new Error('Escolha uma tarefa e dois ou três agentes.'); }
		if ([...this.records.values()].some(r => r.participants.some(p => p.status === 'preparing' || p.status === 'running'))) { throw new Error('Aguarde ou cancele a comparação ativa antes de iniciar outra.'); }
		const choices = input.participants.map((choice: { service?: unknown; model?: unknown }) => {
			if (!choice || typeof choice.service !== 'string' || !services.includes(choice.service)) { throw new Error('Provedor inválido.'); }
			const model = parseSelection(choice.model);
			if (!model) { throw new Error('Selecione o modelo de cada participante.'); }
			return { service: choice.service, model };
		});
		if (!team && new Set(choices.map(c => c.service + JSON.stringify(c.model))).size !== choices.length) { throw new Error('Selecione agentes ou modelos distintos.'); }
		this.creating = true;
		try {
			const workspace = await realpath(input.workspace);
			const root = await realpath((await this.git(workspace, ['rev-parse', '--show-toplevel'])).trim());
			if (workspace.toLowerCase() !== root.toLowerCase()) { throw new Error('Abra a raiz do repositório Git.'); }
			if ((await this.git(workspace, ['status', '--porcelain=v1', '--untracked-files=all'])).trim()) { throw new Error('A árvore de origem contém alterações. Faça commit ou escolha um repositório limpo.'); }
			const base = (await this.git(workspace, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
			ensureSecureDir(this.directory);
			this.directory = realpathSync.native(this.directory);
			const id = randomUUID();
			const record: Comparison = { id, workspace, base, prompt: input.text, createdAt: Date.now(), team, workflowId, participants: choices.map((c, index) => {
				const participantId = randomUUID();
				return { ...c, ...(team ? { role: (['implementer', 'reviewer', 'tester'] as const)[index] } : {}), id: participantId, workspace: join(this.worktreeRoot(workspace, id), participantId), status: 'preparing' };
			}) };
			const worktreeRoot = this.worktreeRoot(workspace, id);
			await mkdir(dirname(worktreeRoot), { recursive: true });
			for (const parent of [dirname(dirname(worktreeRoot)), dirname(worktreeRoot)]) {
				if ((await lstat(parent)).isSymbolicLink()) { throw new Error('Diretório de worktrees inseguro.'); }
			}
			await mkdir(worktreeRoot);
			ensureSecureDir(join(this.directory, id));
			this.records.set(id, record);
			this.save(record);
			// All participants are prepared before the first prompt can consume inference.
			try {
				for (const p of record.participants) {
					followLineEndings(p.workspace, workspace);
					await this.git(workspace, ['worktree', 'add', '--detach', p.workspace, base]);
					if (!team) { const session = await this.adapter.create(p.workspace, p.service, p.model, p.role, record.workspace); p.sessionId = session.id; }
					this.save(record);
				}
			} catch (error) {
				for (const p of record.participants) {
					p.status = 'failed'; p.error = error instanceof Error ? error.message : 'Falha na preparação.'; p.endedAt = Date.now();
					if (p.sessionId) { await this.stopParticipant(p).catch(() => { p.status = 'unrecoverable'; }); }
				}
				this.save(record);
				return structuredClone(record);
			}
			if (team) { for (const p of record.participants) { p.status = 'idle'; } this.save(record); return structuredClone(record); }
			for (const p of record.participants) { p.status = 'running'; p.startedAt = Date.now(); }
			this.save(record);
			for (const p of record.participants) {
				try { this.adapter.prompt(p.sessionId!, record.prompt); }
				catch (error) { p.status = 'failed'; p.error = error instanceof Error ? error.message : 'Falha ao enviar tarefa.'; p.endedAt = Date.now(); }
			}
			this.save(record);
			return structuredClone(record);
		} finally { this.creating = false; }
	}

	active(): boolean { return this.creating || [...this.records.values()].some(r => r.participants.some(p => p.status === 'preparing' || p.status === 'running')); }
	async teamSession(id: string, workspace: string, participantId: string): Promise<string> {
		const record = this.get(id, workspace), participant = record.participants.find(p => p.id === participantId);
		if (!record.team || !participant || participant.status !== 'idle' || participant.sessionId) { throw new Error('A sessão desta etapa já foi criada ou não pode iniciar.'); }
		await this.verifyTree(record, participant);
		const session = await this.adapter.create(participant.workspace, participant.service, participant.model, participant.role, record.workspace);
		participant.sessionId = session.id; this.save(record); return session.id;
	}
	async teamPrompt(id: string, workspace: string, participantId: string, text: string): Promise<void> {
		const record = this.get(id, workspace), participant = record.participants.find(p => p.id === participantId);
		if (!record.team || !participant || participant.status !== 'idle') { throw new Error('Etapa indisponível para envio.'); }
		await this.verifyTree(record, participant);
		participant.status = 'running'; participant.startedAt = Date.now(); this.save(record);
		try { this.adapter.prompt(participant.sessionId!, text); }
		catch (error) { participant.status = 'failed'; participant.error = String(error); this.save(record); throw error; }
	}
	async teamStopRole(id: string, workspace: string, participantId: string): Promise<void> {
		const record = this.get(id, workspace), p = record.participants.find(p => p.id === participantId);
		if (!record.team || !p) { throw new Error('Participante indisponível.'); }
		const session = this.adapter.list().find(s => s.id === p.sessionId);
		if (session && !session.historical) { await this.stopParticipant(p); }
	}
	async teamStop(id: string, workspace: string): Promise<void> {
		const record = this.get(id, workspace);
		if (!record.team) { throw new Error('Equipe indisponível.'); }
		for (const p of record.participants) {
			const session = this.adapter.list().find(s => s.id === p.sessionId);
			if (session && !session.historical) { await this.stopParticipant(p); }
			if (['preparing', 'idle', 'running'].includes(p.status)) { p.status = 'cancelled'; p.endedAt = Date.now(); }
		}
		this.save(record);
	}
	async teamResult(id: string, workspace: string, participantId: string): Promise<string> {
		const record = this.get(id, workspace), p = record.participants.find(p => p.id === participantId);
		if (!record.team || !p) { throw new Error('Participante indisponível.'); }
		const session = this.adapter.list().find(s => s.id === p.sessionId);
		return session?.result ?? (await this.adapter.history?.(p.sessionId!, p.workspace))?.at(-1)?.result ?? '';
	}
	/** Terminal adapter events are reconciled without resending a prompt. */
	onSession(session: Session): void {
		for (const record of this.records.values()) {
			const p = record.participants.find(p => p.sessionId === session.id);
			if (!p || p.status !== 'running' || this.cancelling.has(p.id)) { continue; }
			if (session.recovery) { p.status = 'unrecoverable'; }
			else if (session.status === 'done') { p.status = 'done'; }
			else if (session.status === 'idle') { p.status = 'cancelled'; }
			else if (session.status === 'failed' || session.historical) { p.status = 'failed'; p.error = session.summary; }
			else { continue; }
			p.endedAt = Date.now();
			this.save(record);
		}
	}

	private async stopParticipant(p: Participant): Promise<void> {
		const session = this.adapter.list().find(s => s.id === p.sessionId);
		if (!session || session.harness !== p.service || session.workspace?.toLowerCase() !== p.workspace.toLowerCase()) { throw new Error('Identidade da sessão não confirmada para encerramento.'); }
		if (!session.historical) { await this.adapter.stop(session.id); }
	}

	async cancel(id: string, workspace: string, participantId?: string): Promise<void> {
		const record = this.get(id, workspace);
		if (this.creating || this.busy.has(id)) { throw new Error('Aguarde a operação em andamento.'); }
		if (participantId && !record.participants.some(p => p.id === participantId)) { throw new Error('Participante inválido.'); }
		this.busy.add(id);
		try {
			await Promise.all(record.participants.filter(p => (!participantId || p.id === participantId) && p.status === 'running').map(async p => {
				this.cancelling.add(p.id);
				try {
					await this.stopParticipant(p);
					p.status = 'cancelled'; p.endedAt = Date.now(); delete p.error;
				} catch (error) { p.error = error instanceof Error ? error.message : 'Encerramento não confirmado.'; }
				finally {
					this.cancelling.delete(p.id);
					const session = this.adapter.list().find(s => s.id === p.sessionId);
					if (session && p.status === 'running') { this.onSession(session); }
				}
			}));
			this.save(record);
		} finally { this.busy.delete(id); }
	}

	private async verifyTree(record: Comparison, p: Participant): Promise<void> {
		if (p.removed || !this.validWorktree(record, p) || (await lstat(p.workspace)).isSymbolicLink()) { throw new Error('Worktree indisponível.'); }
		const entries = (await this.git(record.workspace, ['worktree', 'list', '--porcelain'])).split(/\r?\n/);
		if (!entries.some(line => line.replace(/\\/g, '/').toLowerCase() === ('worktree ' + p.workspace).replace(/\\/g, '/').toLowerCase())) { throw new Error('Identidade do worktree não confirmada.'); }
		const common = (await this.git(p.workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
		const origin = (await this.git(record.workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
		if (common.toLowerCase() !== origin.toLowerCase()) { throw new Error('Repositório do worktree divergente.'); }
	}

	async solutionSource(id: string, workspace: string, participantId: string): Promise<{ comparison: Comparison; participant: Participant }> {
		const record = this.get(id, workspace);
		const participant = record.participants.find(p => p.id === participantId);
		if (!participant || record.selected !== participant.id || participant.status !== 'done' || this.busy.has(id)) { throw new Error('Escolha uma solução concluída antes de preparar a aplicação.'); }
		this.busy.add(id);
		try {
			await this.verifyTree(record, participant);
			const session = this.adapter.list().find(s => s.id === participant.sessionId);
			if (!session) { throw new Error('A identidade da sessão não pode ser confirmada. O worktree foi preservado.'); }
			if (session && (session.status === 'running' || session.status === 'waiting' || session.recovery)) { throw new Error('A sessão voltou a ficar ativa ou não pode ser recuperada. Aguarde seu encerramento.'); }
			if (session && !session.historical) { await this.stopParticipant(participant); }
			if (this.adapter.list().some(s => s.id === participant.sessionId && !s.historical)) { throw new Error('O encerramento do processo não foi confirmado.'); }
			return { comparison: structuredClone(record), participant: structuredClone(participant) };
		} finally { this.busy.delete(id); }
	}

	async inspect(id: string, workspace: string, participantId: string): Promise<unknown> {
		const record = this.get(id, workspace);
		const p = record.participants.find(p => p.id === participantId);
		if (!p) { throw new Error('Participante inválido.'); }
		await this.verifyTree(record, p);
		const [files, diff, untracked] = await Promise.all([
			this.git(p.workspace, ['diff', '--name-status', record.base, '--']),
			this.git(p.workspace, ['diff', '--no-ext-diff', '--no-textconv', record.base, '--']),
			this.git(p.workspace, ['ls-files', '--others', '--exclude-standard'])
		]);
		let additions = '';
		for (const file of untracked.split(/\r?\n/).filter(Boolean).slice(0, 100)) {
			const path = join(p.workspace, file);
			const canonical = await realpath(path);
			if (!canonical.toLowerCase().startsWith((p.workspace + sep).toLowerCase()) || !(await lstat(path)).isFile()) { continue; }
			if ((await lstat(path)).size > 65536) { additions += '\nArquivo novo maior que 64 KiB: ' + file + '\n'; continue; }
			const data = await readFile(path);
			if (data.length > 65536 || data.includes(0)) { additions += '\nArquivo novo binário ou maior que 64 KiB: ' + file + '\n'; continue; }
			additions += '\ndiff --git a/' + file + ' b/' + file + '\n--- /dev/null\n+++ b/' + file + '\n' + data.toString('utf8').split(/\r?\n/).map(line => '+' + line).join('\n') + '\n';
		}
		const session = this.adapter.list().find(s => s.id === p.sessionId);
		const turns = p.sessionId && this.adapter.history ? await this.adapter.history(p.sessionId, p.workspace).catch(() => []) : [];
		return { participant: structuredClone(p), base: record.base, files, diff: diff + additions, untracked, usage: session?.usage, result: session?.result ?? turns.at(-1)?.result, error: p.error ?? session?.summary,
			tests: 'Consulte a saída do agente. O coordenador não executou testes independentes.', durationMs: p.startedAt ? (p.endedAt ?? Date.now()) - p.startedAt : undefined };
	}

	select(id: string, workspace: string, participantId: string): void {
		const record = this.get(id, workspace);
		if (!record.participants.some(p => p.id === participantId && !p.removed)) { throw new Error('Participante inválido.'); }
		record.selected = participantId;
		this.save(record);
	}

	async cleanup(id: string, workspace: string): Promise<void> {
		const record = this.get(id, workspace);
		if (this.creating || this.busy.has(id) || record.participants.some(p => ['running', 'preparing', 'unrecoverable'].includes(p.status))) { throw new Error('Confirme o encerramento dos participantes antes de limpar os worktrees.'); }
		this.busy.add(id);
		try {
			for (const p of record.participants.filter(p => !p.removed)) {
				if (!p.sessionId && !existsSync(p.workspace)) { p.removed = true; this.save(record); continue; }
				await this.verifyTree(record, p);
				if ((await this.git(p.workspace, ['status', '--porcelain=v1', '--untracked-files=all'])).trim() || (await this.git(p.workspace, ['rev-parse', 'HEAD'])).trim() !== record.base) { throw new Error('Worktree contém alterações ou commits. Preserve o resultado antes de removê-lo.'); }
				if (p.sessionId && this.adapter.list().some(s => s.id === p.sessionId && !s.historical)) { await this.stopParticipant(p); }
				await this.git(record.workspace, ['worktree', 'remove', p.workspace]);
				p.removed = true;
				this.save(record);
			}
		} finally { this.busy.delete(id); }
	}
}

