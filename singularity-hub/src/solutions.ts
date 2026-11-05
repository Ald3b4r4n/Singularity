import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import { join, resolve, sep, isAbsolute } from 'node:path';
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
	progress: number; error?: string;
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
	constructor(private readonly directory: string, private readonly source: SolutionSource) {
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
				if (record?.id !== session.id || !Array.isArray(record.files) || record.files.length > maxFiles || !isAbsolute(record.workspace)) { continue; }
				for (const file of record.files) { safeSolutionPath(file.path); }
				this.records.set(record.id, record);
				if (record.state === 'validating') { record.state = 'prepared'; record.validation.state = 'interrupted'; this.save(record); }
			} catch { /* Corrupt protected data never authorizes an application. */ }
		}
	}
	list(workspace: string): Solution[] { const root = realpathSync.native(workspace); return structuredClone([...this.records.values()].filter(r => r.workspace.toLowerCase() === root.toLowerCase())); }
	private get(id: string, workspace: string): Solution {
		const record = this.records.get(id);
		if (!record || record.workspace.toLowerCase() !== realpathSync.native(workspace).toLowerCase()) { throw new Error('Solução indisponível neste workspace.'); }
		return record;
	}
	private async indexHash(root: string): Promise<string> {
		const path = resolve(root, await textGit(root, ['rev-parse', '--git-path', 'index']));
		return digest(await fs.readFile(path));
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
			const sourceFingerprint = await this.fingerprint(participant.workspace, comparison.base);
			const entries = await baseEntries(root, comparison.base);
			for (const entry of (await git(participant.workspace, ['ls-files', '--stage', '-z'])).toString().split('\0').filter(Boolean)) {
				const match = /^(\d+) [0-9a-f]+ \d+\t(.+)$/.exec(entry);
				if (!match || !['100644', '100755'].includes(match[1]) || (entries.has(match[2]) && entries.get(match[2]) !== match[1])) { throw new Error('Alterações de tipo ou modo Git não são suportadas neste ciclo.'); }
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
		if (record.state !== 'prepared' || this.busy.has(record.workspace) || command?.approved !== true || typeof command.executable !== 'string' || !isAbsolute(command.executable) || !Array.isArray(command.args) || command.args.length > 40 || !command.args.every(a => typeof a === 'string' && a.length <= 1024)) { throw new Error('Autorize um executável absoluto e seus argumentos antes de validar.'); }
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
}


