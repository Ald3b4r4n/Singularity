/**
 * Which Singularity processes are running, which of them are legitimate and which are leftovers: a diagnosis that never guesses.
 *
 * Nothing here trusts a name or a PID. A Hub proves what it is through three independent facts: the command line of the process, the
 * moment Windows created it, and the record it wrote in the per-user instance registry when it started. A process that cannot be
 * proven is reported as "não verificável" and is never offered for termination. Termination re-reads everything immediately before
 * acting (PID reuse changes the creation time), kills one PID only, and refuses anything that has agents or sessions attached unless
 * the person confirmed that explicitly.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureSecureDir, writeFileAtomic } from './secure';

export interface ProcInfo { pid: number; ppid: number; name: string; path?: string; cmd?: string; created: number }
export type Lister = () => Promise<ProcInfo[]>;

export interface InstanceRecord { v: 1; pid: number; startedAtMs: number; home: string; instanceId: string; kind: 'default' | 'isolated'; script: string }

export type Role = 'current-hub' | 'other-hub' | 'orphan-hub' | 'unverified-hub' | 'gateway' | 'unverified-gateway' | 'linked-agent' | 'orphan-agent';
export interface ProcessEntry {
	pid: number;
	created: number;
	role: Role;
	/** Whether identity (command line, creation time and the registry or the Hub's own record) was proven. */
	verified: boolean;
	label: string;
	reason: string;
	recommendation: string;
	sessions: string[];
	children: number;
	/** Only set when termination is possible and safe to offer. */
	canTerminate: boolean;
	/** A healthy registered Hub of another state folder can be asked to stop itself, gracefully, with that folder's own credentials. */
	canShutdown?: boolean;
	home?: string;
	/** Terminating it would also stop agents or sessions: it needs the explicit "active agents" confirmation. */
	hasActiveWork: boolean;
}

export interface Snapshot {
	generatedAt: number;
	entries: ProcessEntry[];
	/** Everything that is not a Singularity process is only counted, never listed or touched. */
	foreignIgnored: number;
	recoveryRecords: number;
}

export interface Context {
	now?: number;
	/** The Hub of the inspected home, as proven by discovery (pid and start time), when it answers. */
	current?: { pid: number; startedAtMs: number };
	/** Processes the running Hub says belong to its own sessions. */
	owned?: Array<{ pid: number; sessionId: string }>;
	gateway?: { pid: number } | undefined;
	records?: InstanceRecord[];
	/** What the home of a registered instance currently says: the pid of the Hub it points to, if any. */
	homeHub?: (home: string) => { pid: number; startedAtMs: number; answers?: boolean } | undefined;
	recoveryRecords?: number;
	tolerateMs?: number;
}

const HUB = /singularity-hub[\\/]dist[\\/]main\.js/i;
const GATEWAY = /singularity-hub[\\/]dist[\\/]remote[\\/]main\.js/i;
const HELPER = /singularity-hub[\\/]dist[\\/]singularity-job\.exe$/i;
const TOLERANCE_MS = 15_000;

export const instancesDir = (env: NodeJS.ProcessEnv = process.env): string => path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Singularity', 'instances');

export function registerInstance(record: Omit<InstanceRecord, 'v'>, dir = instancesDir()): void {
	ensureSecureDir(dir);
	writeFileAtomic(path.join(dir, `${record.pid}.json`), JSON.stringify({ v: 1, ...record }));
}
export function unregisterInstance(pid: number, dir = instancesDir()): void { fs.rmSync(path.join(dir, `${pid}.json`), { force: true }); }

export function readInstances(dir = instancesDir()): InstanceRecord[] {
	let names: string[];
	try { names = fs.readdirSync(dir); } catch { return []; }
	const records: InstanceRecord[] = [];
	for (const name of names) {
		if (!/^\d+\.json$/.test(name)) { continue; }
		try {
			const value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Partial<InstanceRecord>;
			if (value.v === 1 && Number.isSafeInteger(value.pid) && Number.isFinite(value.startedAtMs) && typeof value.home === 'string' && typeof value.instanceId === 'string' && (value.kind === 'default' || value.kind === 'isolated')) { records.push(value as InstanceRecord); }
		} catch { /* a damaged record proves nothing: ignored */ }
	}
	return records;
}

/** The Windows process table with creation times. */
export const windowsLister: Lister = () => new Promise((resolve, reject) => {
	const script = 'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; path = $_.ExecutablePath; cmd = $_.CommandLine; created = [int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } } | ConvertTo-Json -Compress';
	execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
		if (error) { reject(error); return; }
		try {
			const parsed = JSON.parse(stdout) as unknown;
			const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>;
			resolve(rows.filter(row => Number.isSafeInteger(row.pid) && typeof row.created === 'number').map(row => ({ pid: row.pid as number, ppid: Number(row.ppid) || 0, name: String(row.name ?? ''), ...(typeof row.path === 'string' ? { path: row.path } : {}), ...(typeof row.cmd === 'string' ? { cmd: row.cmd } : {}), created: row.created as number })));
		} catch (e) { reject(e as Error); }
	});
});

const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance;

/** Pure classification of a process table. */
export function classify(procs: ProcInfo[], context: Context = {}): Snapshot {
	const tolerance = context.tolerateMs ?? TOLERANCE_MS;
	const byPid = new Map(procs.map(p => [p.pid, p]));
	const children = new Map<number, ProcInfo[]>();
	for (const p of procs) { const parent = byPid.get(p.ppid); if (parent && parent.created <= p.created && p.pid !== p.ppid) { (children.get(p.ppid) ?? children.set(p.ppid, []).get(p.ppid)!).push(p); } }
	// the console host Windows attaches to every console process is not work: it is ignored
	const descendants = (pid: number): number => (children.get(pid) ?? []).filter(child => !/^conhost(\.exe)?$/i.test(child.name)).reduce((sum, child) => sum + 1 + descendants(child.pid), 0);
	const records = new Map((context.records ?? []).map(r => [r.pid, r]));
	const owned = new Map<number, string[]>();
	for (const item of context.owned ?? []) { (owned.get(item.pid) ?? owned.set(item.pid, []).get(item.pid)!).push(item.sessionId); }

	const hubs = procs.filter(p => /node(\.exe)?$/i.test(p.name) && p.cmd && HUB.test(p.cmd) && !GATEWAY.test(p.cmd));
	const liveHubPids = new Set(hubs.map(h => h.pid));
	const entries: ProcessEntry[] = [];
	let known = 0;
	const base = (p: ProcInfo): Pick<ProcessEntry, 'pid' | 'created' | 'sessions' | 'children'> => ({ pid: p.pid, created: p.created, sessions: owned.get(p.pid) ?? [], children: descendants(p.pid) });

	for (const p of hubs) {
		known++;
		const record = records.get(p.pid);
		const isCurrent = !!context.current && context.current.pid === p.pid && near(p.created, context.current.startedAtMs, tolerance);
		if (isCurrent) {
			entries.push({ ...base(p), role: 'current-hub', verified: true, label: 'Hub principal', reason: 'É o Hub que responde e se identificou com o token deste usuário.', recommendation: 'Manter. Ele continua ativo depois de fechar a IDE, como projetado.', canTerminate: false, hasActiveWork: (owned.size > 0) });
			continue;
		}
		if (record && near(p.created, record.startedAtMs, tolerance)) {
			const at = context.homeHub?.(record.home);
			if (at && at.pid === p.pid && at.answers === false && (context.now ?? Date.now()) - p.created > 120_000) {
				const kids = descendants(p.pid);
				entries.push({ ...base(p), role: 'orphan-hub', verified: true, label: 'Hub registrado que não responde', reason: 'Identidade comprovada (registro e horário de criação). A pasta de estado dele aponta para este processo, mas ele não responde à prova de identidade há mais de 2 minutos.', recommendation: kids ? 'Há agentes ligados a ele: revise antes e confirme que quer encerrar também os agentes.' : 'Pode ser encerrado com segurança.', canTerminate: true, hasActiveWork: kids > 0 });
			} else if (at && at.pid === p.pid) {
				entries.push({ ...base(p), role: 'other-hub', verified: true, label: record.kind === 'isolated' ? 'Hub de perfil isolado ou de teste' : 'Hub de outro perfil', reason: 'Está registrado, responde à prova de identidade e é o Hub em uso da própria pasta de estado dele.', recommendation: 'Preservado: é uma instância legítima. Se não precisa mais dela, peça que ela mesma encerre (encerramento gracioso).', canTerminate: false, canShutdown: true, home: record.home, hasActiveWork: descendants(p.pid) > 0 });
			} else {
				const kids = descendants(p.pid);
				entries.push({ ...base(p), role: 'orphan-hub', verified: true, label: 'Hub órfão', reason: 'Identidade comprovada (registro e horário de criação), mas a pasta de estado dele não aponta mais para este processo.', recommendation: kids ? 'Há agentes ligados a ele: revise antes e confirme que quer encerrar também os agentes.' : 'Pode ser encerrado com segurança.', canTerminate: true, hasActiveWork: kids > 0 });
			}
			continue;
		}
		entries.push({ ...base(p), role: 'unverified-hub', verified: false, label: 'Hub não verificável', reason: record ? 'O horário de criação não confere com o registro: o PID pode ter sido reutilizado.' : 'Não há registro de origem (iniciado antes do registro de instâncias ou por outro meio).', recommendation: 'Preservado. Não dá para provar que é um resto; encerre-o você mesmo se souber que é.', canTerminate: false, hasActiveWork: descendants(p.pid) > 0 });
	}

	for (const p of procs) {
		if (/node(\.exe)?$/i.test(p.name) && p.cmd && GATEWAY.test(p.cmd)) {
			known++;
			const linked = !!context.gateway && context.gateway.pid === p.pid;
			entries.push({ ...base(p), role: linked ? 'gateway' : 'unverified-gateway', verified: linked, label: linked ? 'Gateway remoto' : 'Gateway não verificável', reason: linked ? 'É o gateway registrado em gateway.json.' : 'Não corresponde ao gateway registrado.', recommendation: linked ? 'Manter. Desative pelo comando "Desativar acesso remoto".' : 'Preservado: não dá para provar a origem.', canTerminate: false, hasActiveWork: false });
		}
	}

	for (const p of procs) {
		if (!p.path || !HELPER.test(p.path)) { continue; }
		known++;
		const sessions = owned.get(p.pid) ?? [];
		if (sessions.length) { entries.push({ ...base(p), role: 'linked-agent', verified: true, label: 'Agente em sessão', reason: 'Pertence a uma sessão que o Hub principal conhece.', recommendation: 'Manter. Encerre pela própria sessão.', canTerminate: false, hasActiveWork: true }); continue; }
		const parent = byPid.get(p.ppid);
		const parentAlive = !!parent && parent.created <= p.created;
		const underHub = parentAlive && liveHubPids.has(p.ppid);
		if (underHub) { entries.push({ ...base(p), role: 'linked-agent', verified: true, label: 'Agente de outro Hub', reason: 'O processo que o criou é um Hub vivo.', recommendation: 'Manter.', canTerminate: false, hasActiveWork: true }); continue; }
		const kids = descendants(p.pid);
		entries.push({ ...base(p), role: 'orphan-agent', verified: true, label: 'Agente órfão', reason: parentAlive ? 'O processo que o criou não é um Hub do Singularity.' : 'O processo que o criou não existe mais e nenhuma sessão o reivindica.', recommendation: context.recoveryRecords ? 'Há registros de recuperação: reiniciar o Hub tenta reanexar sessões antes de qualquer encerramento.' : 'Pode ser encerrado; o Job Object encerra o que ele iniciou.', canTerminate: true, hasActiveWork: kids > 0 });
	}

	entries.sort((a, b) => a.created - b.created);
	return { generatedAt: context.now ?? Date.now(), entries, foreignIgnored: procs.length - known, recoveryRecords: context.recoveryRecords ?? 0 };
}

export type ShutdownResult = { shutdown: true } | { shutdown: false; reason: string };

/**
 * Asks a verified Hub of another state folder to stop itself. It is the Hub's own shutdown, authenticated with that folder's own
 * token, so no process is killed from outside. Refused while the Hub still holds sessions, unless that was confirmed.
 */
export async function shutdownInstance(request: { pid: number; created: number; confirm: boolean; confirmActiveWork?: boolean }, deps: { lister: Lister; context: () => Context | Promise<Context>; connect: (home: string) => Promise<{ sessions: number; stop: () => Promise<void> }> }): Promise<ShutdownResult> {
	if (request.confirm !== true) { return { shutdown: false, reason: 'O encerramento precisa ser confirmado.' }; }
	const snapshot = classify(await deps.lister(), await deps.context());
	const entry = snapshot.entries.find(item => item.pid === request.pid);
	if (!entry || entry.created !== request.created) { return { shutdown: false, reason: 'O processo não confere mais (PID reutilizado ou já encerrado). Nada foi alterado.' }; }
	if (entry.role !== 'other-hub' || !entry.canShutdown || !entry.home) { return { shutdown: false, reason: `${entry.label}: não é um Hub registrado que responda; nada foi alterado.` }; }
	let link: { sessions: number; stop: () => Promise<void> };
	try { link = await deps.connect(entry.home); } catch { return { shutdown: false, reason: 'O Hub não aceitou a conexão com as credenciais da pasta dele.' }; }
	if (link.sessions > 0 && request.confirmActiveWork !== true) { return { shutdown: false, reason: `O Hub tem ${link.sessions} sessão(ões). Confirme explicitamente para encerrá-lo junto.` }; }
	await link.stop().catch(() => undefined);
	for (let i = 0; i < 30; i++) {
		await new Promise(resolve => setTimeout(resolve, 200));
		if (!(await deps.lister()).some(item => item.pid === request.pid && item.created === request.created)) { return { shutdown: true }; }
	}
	return { shutdown: false, reason: 'O Hub não encerrou no tempo esperado.' };
}

export interface TerminateRequest { pid: number; created: number; confirm: boolean; confirmActiveWork?: boolean }
export type TerminateResult = { terminated: true } | { terminated: false; reason: string };

/**
 * Terminates one verified leftover. The table is read again right now and the target must still be the same process (PID and
 * creation time) and still classified as terminable; otherwise nothing is touched.
 */
export async function terminate(request: TerminateRequest, deps: { lister: Lister; context: () => Context | Promise<Context>; kill?: (pid: number) => void }): Promise<TerminateResult> {
	if (request.confirm !== true) { return { terminated: false, reason: 'O encerramento precisa ser confirmado.' }; }
	if (!Number.isSafeInteger(request.pid) || request.pid <= 4 || request.pid === process.pid) { return { terminated: false, reason: 'PID não permitido.' }; }
	const procs = await deps.lister();
	const snapshot = classify(procs, await deps.context());
	const entry = snapshot.entries.find(item => item.pid === request.pid);
	if (!entry) { return { terminated: false, reason: 'O processo não é um processo do Singularity que possamos verificar. Nada foi encerrado.' }; }
	if (entry.created !== request.created) { return { terminated: false, reason: 'O PID agora pertence a outro processo (o horário de criação mudou). Nada foi encerrado.' }; }
	if (!entry.canTerminate) { return { terminated: false, reason: `${entry.label}: ${entry.recommendation}` }; }
	if (entry.hasActiveWork && request.confirmActiveWork !== true) { return { terminated: false, reason: 'Há agentes ou sessões ligados a este processo. Confirme explicitamente o encerramento deles.' }; }
	try { (deps.kill ?? ((pid: number) => process.kill(pid)))(request.pid); } catch (error) { return { terminated: false, reason: 'O Windows recusou o encerramento: ' + ((error as NodeJS.ErrnoException).code ?? 'erro') }; }
	for (let i = 0; i < 20; i++) {
		await new Promise(resolve => setTimeout(resolve, 150));
		const after = (await deps.lister()).find(item => item.pid === request.pid && item.created === request.created);
		if (!after) { return { terminated: true }; }
	}
	return { terminated: false, reason: 'O processo não encerrou no tempo esperado.' };
}
