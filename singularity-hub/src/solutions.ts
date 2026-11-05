import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import { join, resolve, dirname, basename, sep, isAbsolute } from 'node:path';
import { SessionHistory } from './history';
import { ensureSecureDir, currentWindowsUser } from './secure';
import type { Comparison, Participant } from './comparisons';

const execute = promisify(execFile);
const maxFiles = 512;
const maxBytes = 32 * 1024 * 1024;
const digest = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
interface FileState { hash: string; bytes: number; mode: number }
export interface SolutionFile { path: string; before?: FileState; after?: FileState; kind: 'added' | 'modified' | 'removed'; binary: boolean }
interface Validation { state: 'unavailable' | 'running' | 'passed' | 'failed' | 'interrupted'; executable?: string; args?: string[]; exitCode?: number | null; output?: string; at?: number }
export interface Solution {
	id: string; comparisonId: string; participantId: string; workspace: string; source: string; base: string;
	provider: string; model: Participant['model']; createdAt: number; sourceFingerprint: string; indexHash: string;
	files: SolutionFile[]; tree: string; patchHash: string; integrity: boolean; validation: Validation;
	state: 'prepared' | 'validating' | 'applying' | 'applied' | 'rolling-back' | 'rolled-back' | 'conflict';
	progress: number; error?: string; lockToken?: string; lockPid?: number; directories?: string[];
}
export type SolutionSource = (comparisonId: string, workspace: string, participantId: string) => Promise<{ comparison: Comparison; participant: Participant }>;

/** Git always runs with optional index writes and user-defined hooks/filters disabled in the isolated repository. */
async function git(workspace: string, args: string[], input?: Buffer, extra: NodeJS.ProcessEnv = {}): Promise<Buffer> {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) { if (key.startsWith('GIT_')) { delete env[key]; } }
	Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, extra);
	if (input) {
		return new Promise((resolveResult, reject) => {
			const child = spawn('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-C', workspace, ...args], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
			const chunks: Buffer[] = []; let size = 0; let error = '';
			const timer = setTimeout(() => child.kill(), 30000);
			child.stdout.on('data', (data: Buffer) => { size += data.length; if (size > maxBytes) { child.kill(); } else { chunks.push(data); } });
			child.stderr.on('data', (data: Buffer) => { error = (error + data.toString()).slice(0, 2000); });
			child.once('error', reject);
			child.once('close', code => { clearTimeout(timer); code === 0 && size <= maxBytes ? resolveResult(Buffer.concat(chunks)) : reject(new Error('Git não confirmou a preparação. ' + error)); });
			child.stdin.on('error', () => {}); child.stdin.end(input);
		});
	}
	const result = await execute('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-C', workspace, ...args], { env, windowsHide: true, encoding: 'buffer', timeout: 30000, maxBuffer: maxBytes });
	return result.stdout;
}
const textGit = async (workspace: string, args: string[]): Promise<string> => (await git(workspace, args)).toString('utf8').trim();

export function safeSolutionPath(path: string): void {
	if (!path || path.length > 220 || path.includes('\\') || /[\x00-\x1f\x7f:]/.test(path) || isAbsolute(path)) { throw new Error('Caminho de arquivo não suportado.'); }
	for (const part of path.split('/')) {
		if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^\.git$/i.test(part) || /^\.?git~\d+$/i.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) { throw new Error('Caminho perigoso recusado: ' + path); }
	}
}

async function readFileState(root: string, path: string): Promise<{ state: FileState; data: Buffer } | undefined> {
	safeSolutionPath(path);
	let cursor = root;
	for (const part of path.split('/')) {
		cursor = join(cursor, part);
		const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') { return undefined; } throw error; });
		if (!stat) { return undefined; }
		if (stat.isSymbolicLink()) { throw new Error('Links não são suportados: ' + path); }
	}
	const stat = await fs.lstat(cursor);
	if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || !(stat.mode & 0o200)) { throw new Error('Tipo, tamanho ou permissão de arquivo não suportado: ' + path); }
	if (!(await fs.realpath(cursor)).toLowerCase().startsWith(((await fs.realpath(root)) + sep).toLowerCase())) { throw new Error('Arquivo fora do repositório.'); }
	const data = await fs.readFile(cursor);
	return { state: { hash: digest(data), bytes: data.length, mode: stat.mode & 0o777 }, data };
}

async function inheritedPermissions(path: string): Promise<void> {
	if (process.platform !== 'win32') { return; }
	await execute(join(__dirname, 'singularity-job.exe'), ['inspect-file', path], { windowsHide: true, timeout: 5000 }).catch(() => { throw new Error('Atributos ou streams NTFS não suportados: ' + path); });
	const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
	const result = await execute(executable, [path], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
	const rules = result.stdout.split(/\r?\n/).filter(line => /:\(/.test(line));
	if (!rules.length || rules.some(line => !line.slice(line.indexOf(':(') + 1).includes('(I)'))) { throw new Error('ACL específica não suportada. Preserve as permissões de ' + path); }
}

async function baseEntries(root: string, base: string): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	for (const entry of (await git(root, ['ls-tree', '-rz', base])).toString('utf8').split('\0').filter(Boolean)) {
		const match = /^(\d+) blob [0-9a-f]+\t(.+)$/.exec(entry);
		if (!match || !['100644', '100755'].includes(match[1])) { throw new Error('O repositório contém links ou submódulos não suportados.'); }
		safeSolutionPath(match[2]); result.set(match[2], match[1]);
	}
	return result;
}

export class Solutions {
	private readonly records = new Map<string, Solution>();
	private readonly storage: SessionHistory;
	private readonly busy = new Set<string>();
	constructor(private readonly directory: string, private readonly source: SolutionSource, private readonly fault?: (index: number) => void) {
		this.storage = new SessionHistory(join(directory, 'records'), join(__dirname, 'singularity-job.exe'), 'solution');
	}
	private location(id: string): string { return join(this.directory, id); }
	private stage(id: string): string { return join(this.location(id), 'stage'); }
	private save(record: Solution): void {
		this.storage.save({ id: record.id, harness: 'solution', status: 'idle', workspace: record.workspace, updatedAt: Date.now() }, { prompt: '', result: JSON.stringify(record), status: 'idle', at: Date.now() }, true);
		this.records.set(record.id, record);
	}
	async recover(): Promise<void> {
		this.storage.load();
		for (const session of this.storage.list()) {
			try {
				const record = JSON.parse(this.storage.turns(session.id).at(-1)?.result ?? 'null') as Solution;
				if (record?.id !== session.id || !Number.isFinite(record.createdAt) || !Array.isArray(record.files) || record.files.length > maxFiles || !isAbsolute(record.workspace)) { continue; }
				for (const file of record.files) { safeSolutionPath(file.path); }
				if (record.directories?.some(path => !resolve(path).toLowerCase().startsWith((record.workspace + sep).toLowerCase()))) { continue; }
				this.records.set(record.id, record);
				if (record.state === 'applying' || record.state === 'rolling-back') { await this.recoverTransaction(record); }
				else if (record.lockToken) {
					try { await this.releaseLock(record, true); if (record.state === 'applied') { await this.removeArtifacts(record); } }
					catch (error) { record.state = 'conflict'; record.error = String(error); this.save(record); }
				}
				if (record.state === 'validating') { record.state = 'prepared'; record.validation.state = 'interrupted'; this.save(record); }
			} catch { /* Corrupt protected data never authorizes an application. */ }
		}
	}
	list(workspace: string): Solution[] { const root = realpathSync.native(workspace); return structuredClone([...this.records.values()].filter(r => r.workspace.toLowerCase() === root.toLowerCase()).sort((a, b) => a.createdAt - b.createdAt)); }
	private get(id: string, workspace: string): Solution {
		const record = this.records.get(id);
		if (!record || record.workspace.toLowerCase() !== realpathSync.native(workspace).toLowerCase()) { throw new Error('Solução indisponível neste workspace.'); }
		return record;
	}
	private async indexHash(root: string): Promise<string> {
		const entries = await git(root, ['ls-files', '--stage', '-z']);
		const flags = await git(root, ['ls-files', '-v', '-z']);
		return digest(Buffer.concat([entries, flags]));
	}
	private async clean(root: string, base: string): Promise<string> {
		if (await textGit(root, ['rev-parse', 'HEAD']) !== base) { throw new Error('HEAD divergente do commit-base.'); }
		if (await textGit(root, ['status', '--porcelain=v1', '--untracked-files=all'])) { throw new Error('O projeto contém alterações preexistentes.'); }
		if ((await git(root, ['ls-files', '-v', '-z'])).toString().split('\0').some(line => /^[a-zS]/.test(line))) { throw new Error('Índice esparso ou arquivos ocultos do Git não são suportados.'); }
		return this.indexHash(root);
	}
	private async fingerprint(root: string, base: string): Promise<string> {
		const entries = await baseEntries(root, base);
		const extra = (await git(root, ['ls-files', '--cached', '--others', '-z'])).toString('utf8').split('\0').filter(Boolean);
		const paths = [...new Set([...entries.keys(), ...extra])].sort();
		if (paths.length > 10000) { throw new Error('O worktree excede o limite de verificação deste ciclo.'); }
		const hashes: string[] = [];
		for (const path of paths) { hashes.push(path + ':' + JSON.stringify((await readFileState(root, path))?.state ?? null)); }
		return digest(hashes.join('\n') + await textGit(root, ['rev-parse', 'HEAD']) + await this.indexHash(root));
	}

	async prepare(comparisonId: string, workspace: string, participantId: string): Promise<Solution> {
		const { comparison, participant } = await this.source(comparisonId, workspace, participantId);
		const root = await fs.realpath(comparison.workspace);
		if (this.busy.has(root)) { throw new Error('Aguarde a operação neste projeto.'); }
		this.busy.add(root);
		try {
			const indexHash = await this.clean(root, comparison.base);
			await git(participant.workspace, ['merge-base', '--is-ancestor', comparison.base, 'HEAD']).catch(() => { throw new Error('O worktree divergiu do commit-base.'); });
			const sourceFingerprint = await this.fingerprint(participant.workspace, comparison.base);
			const entries = await baseEntries(root, comparison.base);
			for (const entry of (await git(participant.workspace, ['ls-files', '--stage', '-z'])).toString().split('\0').filter(Boolean)) {
				const match = /^(\d+) [0-9a-f]+ (\d+)\t(.+)$/.exec(entry);
				if (!match || match[2] !== '0' || !['100644', '100755'].includes(match[1]) || (entries.has(match[3]) ? entries.get(match[3]) !== match[1] : match[1] !== '100644')) { throw new Error('Alterações de tipo ou modo Git não são suportadas neste ciclo.'); }
			}
			const paths = [...new Set([...entries.keys(), ...(await git(participant.workspace, ['ls-files', '--cached', '--others', '-z'])).toString('utf8').split('\0').filter(Boolean)])].sort();
			const caseNames = new Set<string>();
			for (const path of paths) { safeSolutionPath(path); if (caseNames.has(path.toLowerCase())) { throw new Error('Colisão de nomes de arquivos.'); } caseNames.add(path.toLowerCase()); }
			const id = randomUUID(); ensureSecureDir(this.location(id));
			await fs.mkdir(join(this.location(id), 'before')); await fs.mkdir(join(this.location(id), 'after'));
			await git(this.location(id), ['clone', '--no-hardlinks', '--no-checkout', '--', root, this.stage(id)]);
			await git(this.stage(id), ['read-tree', comparison.base]);
			const files: SolutionFile[] = []; let bytes = 0;
			for (const path of paths) {
				const before = entries.has(path) ? await readFileState(root, path) : undefined;
				const after = await readFileState(participant.workspace, path);
				if (before?.state.hash === after?.state.hash) { continue; }
				if (before) { await inheritedPermissions(join(root, path)); }
				if (after) { await inheritedPermissions(join(participant.workspace, path)); }
				if (!entries.has(path) && await readFileState(root, path)) { throw new Error('Um arquivo de destino já existe: ' + path); }
				bytes += (before?.data.length ?? 0) + (after?.data.length ?? 0);
				if (files.length >= maxFiles || bytes > maxBytes) { throw new Error('A solução excede 512 arquivos ou 32 MiB.'); }
				const index = files.length;
				files.push({ path, before: before?.state, after: after?.state, kind: !before ? 'added' : !after ? 'removed' : 'modified', binary: !!before?.data.includes(0) || !!after?.data.includes(0) });
				if (before) { await fs.writeFile(join(this.location(id), 'before', String(index)), before.data, { flag: 'wx' }); }
				if (after) {
					await fs.writeFile(join(this.location(id), 'after', String(index)), after.data, { flag: 'wx' });
					const blob = (await git(this.stage(id), ['hash-object', '-w', '--stdin', '--no-filters'], after.data)).toString().trim();
					await git(this.stage(id), ['update-index', '--add', '--cacheinfo', entries.get(path) ?? '100644', blob, path]);
				} else { await git(this.stage(id), ['update-index', '--force-remove', '--', path]); }
			}
			if (!files.length) { throw new Error('A solução não contém alterações aplicáveis.'); }
			const tree = await textGit(this.stage(id), ['write-tree']);
			const patch = await git(this.stage(id), ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', comparison.base, '--']);
			if (patch.length > 8 * 1024 * 1024) { throw new Error('O diff completo excede 8 MiB.'); }
			await fs.writeFile(join(this.location(id), 'solution.patch'), patch, { flag: 'wx' });
			const checkIndex = join(this.location(id), 'check.index');
			await git(this.stage(id), ['read-tree', comparison.base], undefined, { GIT_INDEX_FILE: checkIndex });
			await git(this.stage(id), ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], patch, { GIT_INDEX_FILE: checkIndex });
			if ((await git(this.stage(id), ['write-tree'], undefined, { GIT_INDEX_FILE: checkIndex })).toString().trim() !== tree) { throw new Error('A integridade do patch não foi confirmada.'); }
			await git(this.stage(id), ['checkout-index', '--all']);
			if (sourceFingerprint !== await this.fingerprint(participant.workspace, comparison.base) || indexHash !== await this.clean(root, comparison.base)) { throw new Error('O projeto ou a solução mudou durante a preparação.'); }
			const record: Solution = { id, comparisonId, participantId, workspace: root, source: participant.workspace, base: comparison.base, provider: participant.service, model: participant.model, createdAt: Date.now(), sourceFingerprint, indexHash, files, tree, patchHash: digest(patch), integrity: true, validation: { state: 'unavailable' }, state: 'prepared', progress: 0 };
			this.save(record); return structuredClone(record);
		} finally { this.busy.delete(root); }
	}

	async review(id: string, workspace: string): Promise<unknown> {
		const record = this.get(id, workspace);
		const patch = await fs.readFile(join(this.location(id), 'solution.patch'));
		if (digest(patch) !== record.patchHash) { throw new Error('O patch preparado foi alterado.'); }
		const renames = await textGit(this.stage(id), ['diff', '--cached', '--name-status', '-M', record.base, '--']);
		return { ...structuredClone(record), diff: patch.toString('utf8'), renames, counts: { added: record.files.filter(f => f.kind === 'added').length, modified: record.files.filter(f => f.kind === 'modified').length, removed: record.files.filter(f => f.kind === 'removed').length } };
	}

	async validate(id: string, workspace: string, command: { executable?: unknown; args?: unknown; approved?: unknown }): Promise<Solution> {
		const record = this.get(id, workspace);
		if (!['prepared', 'rolled-back'].includes(record.state) || this.busy.has(record.workspace) || command?.approved !== true || typeof command.executable !== 'string' || !isAbsolute(command.executable) || !Array.isArray(command.args) || command.args.length > 40 || !command.args.every(a => typeof a === 'string' && a.length <= 1024)) { throw new Error('Autorize um executável absoluto e seus argumentos antes de validar.'); }
		if (!(await fs.stat(command.executable)).isFile()) { throw new Error('Executável de teste indisponível.'); }
		this.busy.add(record.workspace); record.state = 'validating'; record.validation = { state: 'running', executable: command.executable, args: command.args, at: Date.now() }; this.save(record);
		try {
			const pipe = randomUUID(), control = randomBytes(32).toString('hex');
			const child = spawn(join(__dirname, 'singularity-job.exe'), ['run-test', String(process.pid), pipe, currentWindowsUser().sid, this.stage(id), command.executable, ...command.args], { env: { ...process.env, SINGULARITY_JOB_CONTROL: control }, windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
			let output = ''; let timedOut = false;
			child.stdout.on('data', data => { output = (output + data.toString('utf8')).slice(-65536); });
			child.stderr.on('data', data => { output = (output + data.toString('utf8')).slice(-65536); });
			const timer = setTimeout(() => { timedOut = true; const stopped = spawnSync(join(__dirname, 'singularity-job.exe'), ['stop-job', pipe, String(child.pid)], { input: control, windowsHide: true, timeout: 5000 }); if (stopped.status !== 0) { child.kill(); } }, 60000);
			const exitCode = await new Promise<number | null>((resolveExit, reject) => { child.once('close', resolveExit); child.once('error', reject); }).finally(() => clearTimeout(timer));
			const stageChanged = !!(await textGit(this.stage(id), ['diff', '--name-only', '--no-ext-diff', '--no-textconv'])) || await textGit(this.stage(id), ['write-tree']) !== record.tree;
			record.validation = { ...record.validation, state: exitCode === 0 && !timedOut && !stageChanged ? 'passed' : 'failed', exitCode, output: output + (stageChanged ? '\nO comando alterou o snapshot validado.' : '') };
			record.state = 'prepared'; this.save(record); return structuredClone(record);
		} catch (error) { record.state = 'prepared'; record.validation.state = 'failed'; record.error = error instanceof Error ? error.message : 'Teste não confirmado.'; this.save(record); throw error; }
		finally { this.busy.delete(record.workspace); }
	}
	private async lockPath(record: Solution): Promise<string> {
		return resolve(record.workspace, await textGit(record.workspace, ['rev-parse', '--git-path', 'singularity-solution.lock']));
	}
	private async acquireLock(record: Solution): Promise<void> {
		record.lockToken = randomBytes(32).toString('hex'); record.lockPid = process.pid; this.save(record);
		const handle = await fs.open(await this.lockPath(record), 'wx', 0o600).catch(() => { throw new Error('Outra operação detém o bloqueio deste projeto.'); });
		try { await handle.writeFile(JSON.stringify({ id: record.id, token: record.lockToken, pid: process.pid })); await handle.sync(); }
		finally { await handle.close(); }
	}
	private async releaseLock(record: Solution, recovery = false): Promise<void> {
		const path = await this.lockPath(record);
		let lock: { id?: string; token?: string; pid?: number };
		try { lock = JSON.parse(await fs.readFile(path, 'utf8')); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; } throw error; }
		if (lock.id !== record.id || lock.token !== record.lockToken) { throw new Error('O bloqueio pertence a outra operação.'); }
		if (recovery && lock.pid !== process.pid) {
			let alive = true;
			try { process.kill(lock.pid!, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
			if (alive) { throw new Error('O proprietário do bloqueio ainda pode estar ativo.'); }
		}
		await fs.unlink(path);
	}
	private sibling(record: Solution, index: number, side: 'before' | 'after'): string {
		const path = join(record.workspace, record.files[index].path);
		return join(dirname(path), '.' + basename(path) + '.singularity-' + record.id + '-' + index + '.' + side);
	}
	private async raw(path: string): Promise<{ data: Buffer; mode: number } | undefined> {
		const stat = await fs.lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') { return undefined; } throw error; });
		if (!stat) { return undefined; }
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) { throw new Error('Tipo de arquivo alterado durante a operação.'); }
		return { data: await fs.readFile(path), mode: stat.mode & 0o777 };
	}
	private matches(actual: { data: Buffer; mode: number } | undefined, expected: FileState | undefined): boolean {
		return expected ? !!actual && digest(actual.data) === expected.hash && actual.mode === expected.mode : !actual;
	}
	private async snapshot(record: Solution, index: number, side: 'before' | 'after'): Promise<Buffer> {
		const expected = record.files[index][side];
		const data = await fs.readFile(join(this.location(record.id), side, String(index)));
		if (!expected || digest(data) !== expected.hash) { throw new Error('O conteúdo protegido da solução foi alterado.'); }
		return data;
	}
	private async assertRepository(record: Solution): Promise<void> {
		if (await textGit(record.workspace, ['rev-parse', 'HEAD']) !== record.base || await this.indexHash(record.workspace) !== record.indexHash) { throw new Error('HEAD ou índice mudou desde a preparação.'); }
	}
	private async assertParents(record: Solution, index: number, create: boolean): Promise<void> {
		let cursor = record.workspace;
		for (const part of record.files[index].path.split('/').slice(0, -1)) {
			cursor = join(cursor, part);
			let stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') { return undefined; } throw error; });
			if (!stat && create) {
				record.directories ??= []; if (!record.directories.includes(cursor)) { record.directories.push(cursor); this.save(record); }
				await fs.mkdir(cursor); stat = await fs.lstat(cursor);
			}
			if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) { throw new Error('Diretório de destino inseguro.'); }
			if (!stat) { return; }
		}
	}
	private async createExclusive(path: string, data: Buffer, mode: number): Promise<void> {
		const handle = await fs.open(path, 'wx', mode);
		try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
		await fs.chmod(path, mode);
	}
	private async publishExclusive(temporary: string, target: string): Promise<void> {
		// Creating a hard link refuses an existing destination, including a concurrent user edit.
		await fs.link(temporary, target); await fs.unlink(temporary);
	}
	private async probeLinks(record: Solution): Promise<void> {
		const first = join(record.workspace, '.singularity-' + record.id + '.probe');
		const second = first + '.link';
		await this.createExclusive(first, Buffer.from('SINGULARITY'), 0o600);
		await fs.link(first, second);
		await fs.unlink(second); await fs.unlink(first);
	}
	private async checkBeforeApply(record: Solution): Promise<void> {
		await this.assertRepository(record); await this.clean(record.workspace, record.base);
		const origin = await this.source(record.comparisonId, record.workspace, record.participantId);
		if (origin.comparison.base !== record.base || origin.participant.workspace.toLowerCase() !== record.source.toLowerCase() || await this.fingerprint(record.source, record.base) !== record.sourceFingerprint) { throw new Error('A solução selecionada mudou. Prepare uma nova revisão.'); }
		if (digest(await fs.readFile(join(this.location(record.id), 'solution.patch'))) !== record.patchHash) { throw new Error('O patch preparado foi alterado.'); }
		for (let index = 0; index < record.files.length; index++) {
			await this.assertParents(record, index, false);
			const file = record.files[index];
			if (file.before) { await inheritedPermissions(join(record.workspace, file.path)); }
			if (file.after) { await inheritedPermissions(join(record.source, file.path)); }
			if (!this.matches(await this.raw(join(record.workspace, file.path)), file.before)) { throw new Error('O destino mudou: ' + file.path); }
			if (file.before) { await this.snapshot(record, index, 'before'); }
			if (file.after) { await this.snapshot(record, index, 'after'); }
		}
	}
	async apply(id: string, workspace: string, confirmation: { confirmed?: unknown; patchHash?: unknown; allowUntested?: unknown }): Promise<Solution> {
		const record = this.get(id, workspace);
		if (record.state === 'applied') { return structuredClone(record); }
		if (!['prepared', 'rolled-back'].includes(record.state) || this.busy.has(record.workspace) || confirmation?.confirmed !== true || confirmation.patchHash !== record.patchHash || !record.integrity) { throw new Error('Revise e confirme esta versão da solução.'); }
		if (record.validation.state !== 'passed' && !(record.validation.state === 'unavailable' && confirmation.allowUntested === true)) { throw new Error('A validação independente falhou, foi interrompida ou ainda não foi autorizada.'); }
		this.busy.add(record.workspace); let locked = false;
		try {
			await this.checkBeforeApply(record); await this.acquireLock(record); locked = true; await this.checkBeforeApply(record);
			record.state = 'applying'; record.progress = 0; record.error = undefined; this.save(record);
			await this.probeLinks(record);
			for (let index = 0; index < record.files.length; index++) {
				const file = record.files[index], target = join(record.workspace, file.path);
				await this.assertRepository(record); await this.assertParents(record, index, true);
				if (!this.matches(await this.raw(target), file.before)) { throw new Error('Arquivo modificado durante a aplicação: ' + file.path); }
				if (file.after) { await this.createExclusive(this.sibling(record, index, 'after'), await this.snapshot(record, index, 'after'), file.after.mode); }
				if (file.before) {
					await fs.rename(target, this.sibling(record, index, 'before'));
					if (!this.matches(await this.raw(this.sibling(record, index, 'before')), file.before)) { throw new Error('O original mudou durante a aplicação: ' + file.path); }
				}
				if (file.after) { await this.publishExclusive(this.sibling(record, index, 'after'), target); }
				if (!this.matches(await this.raw(target), file.after)) { throw new Error('O resultado não corresponde ao manifesto.'); }
				record.progress = index + 1; this.save(record); this.fault?.(index);
			}
			await this.assertRepository(record);
			for (const file of record.files) { if (!this.matches(await this.raw(join(record.workspace, file.path)), file.after)) { throw new Error('O resultado mudou durante a aplicação.'); } }
			record.state = 'applied'; this.save(record); await this.removeArtifacts(record); return structuredClone(record);
		} catch (error) {
			if (record.state === 'applying') {
				try { await this.restore(record, false); } catch (restoreError) { record.state = 'conflict'; record.error = String(restoreError); this.save(record); }
			}
			throw error;
		} finally { if (locked && record.state !== 'conflict') { await this.releaseLock(record); } this.busy.delete(record.workspace); }
	}
	private async removeArtifacts(record: Solution): Promise<void> {
		for (const suffix of ['.probe.link', '.probe']) {
			const path = join(record.workspace, '.singularity-' + record.id + suffix), actual = await this.raw(path);
			if (actual) { if (!actual.data.equals(Buffer.from('SINGULARITY'))) { throw new Error('Arquivo de verificação modificado.'); } await fs.unlink(path); }
		}
		for (let index = 0; index < record.files.length; index++) {
			for (const side of ['before', 'after'] as const) {
				const path = this.sibling(record, index, side), actual = await this.raw(path);
				if (actual) { if (!this.matches(actual, record.files[index][side])) { throw new Error('Arquivo temporário modificado. Preserve-o para revisão.'); } await fs.unlink(path); }
			}
		}
	}
	private async restore(record: Solution, explicit: boolean): Promise<void> {
		await this.assertRepository(record);
		for (let index = 0; index < record.files.length; index++) {
			await this.assertParents(record, index, false);
			const file = record.files[index], actual = await this.raw(join(record.workspace, file.path)), held = await this.raw(this.sibling(record, index, 'before'));
			if (actual) { await inheritedPermissions(join(record.workspace, file.path)); }
			const removed = await this.raw(this.sibling(record, index, 'after'));
			if (removed && !this.matches(removed, file.after)) { throw new Error('Conflito no temporário preservado: ' + file.path); }
			if (held && !this.matches(held, file.before)) { throw new Error('Conflito no original preservado: ' + file.path); }
			if (explicit ? !this.matches(actual, file.after) : !this.matches(actual, file.after) && !this.matches(actual, file.before) && !(held && !actual) && !(record.state === 'rolling-back' && !actual && removed)) { throw new Error('Conflito após a aplicação: ' + file.path); }
			if (file.before) { await this.snapshot(record, index, 'before'); }
		}
		record.state = 'rolling-back'; this.save(record);
		for (let index = record.files.length - 1; index >= 0; index--) {
			const file = record.files[index], target = join(record.workspace, file.path), actual = await this.raw(target);
			if (this.matches(actual, file.before)) { continue; }
			if (!this.matches(actual, file.after) && actual) { throw new Error('Conflito durante o rollback: ' + file.path); }
			if (actual) {
				const removal = this.sibling(record, index, 'after');
				const existing = await this.raw(removal);
				if (existing) { if (!this.matches(existing, file.after)) { throw new Error('Conflito no temporário de rollback.'); } await fs.unlink(removal); }
				await fs.rename(target, removal);
				if (!this.matches(await this.raw(removal), file.after)) { throw new Error('O arquivo mudou durante o rollback: ' + file.path); }
			}
			if (file.before) {
				const held = this.sibling(record, index, 'before');
				if (!await this.raw(held)) { await this.createExclusive(held, await this.snapshot(record, index, 'before'), file.before.mode); }
				await this.publishExclusive(held, target);
			}
			this.save(record);
		}
		await this.removeArtifacts(record);
		for (const directory of [...(record.directories ?? [])].reverse()) { await fs.rmdir(directory).catch((error: NodeJS.ErrnoException) => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code ?? '')) { throw error; } }); }
		record.state = 'rolled-back'; record.progress = 0; record.error = undefined; this.save(record);
	}
	async undo(id: string, workspace: string): Promise<Solution> {
		const record = this.get(id, workspace);
		if (record.state === 'rolled-back') { return structuredClone(record); }
		if (record.state !== 'applied' || this.busy.has(record.workspace)) { throw new Error('Nenhuma aplicação confirmada está disponível para desfazer.'); }
		this.busy.add(record.workspace); let locked = false;
		try { await this.acquireLock(record); locked = true; await this.restore(record, true); return structuredClone(record); }
		catch (error) { record.error = error instanceof Error ? error.message : 'Rollback não confirmado.'; if (this.records.get(id)?.state === 'rolling-back') { record.state = 'conflict'; } this.save(record); throw error; }
		finally { if (locked && record.state !== 'conflict') { await this.releaseLock(record); } this.busy.delete(record.workspace); }
	}
	private async recoverTransaction(record: Solution): Promise<void> {
		try { await this.releaseLock(record, true); await this.acquireLock(record); await this.restore(record, false); await this.releaseLock(record); }
		catch (error) { record.state = 'conflict'; record.error = 'Recuperação bloqueada. ' + (error instanceof Error ? error.message : 'Inspecione os arquivos.'); this.save(record); }
	}
}
