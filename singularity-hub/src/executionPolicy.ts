import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureSecureDir, writeFileAtomic } from './secure';

/**
 * What the implementer of a workspace may do with a terminal. It is chosen by the owner on this computer, per workspace, and never by a
 * remote client: the phone can read it, and a model or a provider picked remotely cannot raise it.
 *
 *  - restricted:  edits files, runs no command (what the product did before this policy existed);
 *  - development: runs commands of development (install, build, test, lint, git) starting in its own working copy;
 *  - autonomous:  works without the limits the harness can lift, non-interactively.
 *
 * `external` is a separate consent: commands whose effect leaves this computer (git push, a deploy, publishing a package).
 */
export type ExecutionMode = 'restricted' | 'development' | 'autonomous';
export const EXECUTION_MODES: readonly ExecutionMode[] = ['restricted', 'development', 'autonomous'];
export interface ExecutionPolicy { mode: ExecutionMode; external: boolean; updatedAt?: number }
export type AgentRole = 'implementer' | 'reviewer' | 'tester';

export const DEFAULT_POLICY: ExecutionPolicy = Object.freeze({ mode: 'restricted', external: false });

export function parsePolicy(value: unknown): ExecutionPolicy | undefined {
	const raw = value as Partial<ExecutionPolicy> | undefined;
	if (!raw || typeof raw !== 'object' || !EXECUTION_MODES.includes(raw.mode as ExecutionMode) || typeof raw.external !== 'boolean') { return undefined; }
	return { mode: raw.mode as ExecutionMode, external: raw.mode === 'restricted' ? false : raw.external, ...(Number.isFinite(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}) };
}

/** Policies per workspace, in one protected file of the Hub. A workspace that was never configured is restricted. */
export class ExecutionPolicies {
	private readonly records = new Map<string, ExecutionPolicy>();
	constructor(private readonly file: string) {
		try {
			if (existsSync(file)) {
				const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
				for (const [key, value] of Object.entries(stored ?? {}).slice(0, 500)) { const policy = parsePolicy(value); if (policy) { this.records.set(key, policy); } }
			}
		} catch { /* An unreadable file grants nothing: every workspace stays restricted. */ }
	}
	private key(workspace: string): string { try { return realpathSync.native(workspace).toLowerCase(); } catch { return workspace.toLowerCase(); } }
	get(workspace: string): ExecutionPolicy { return { ...(this.records.get(this.key(workspace)) ?? DEFAULT_POLICY) }; }
	set(workspace: string, mode: unknown, external: unknown): ExecutionPolicy {
		const policy = parsePolicy({ mode, external: external === true });
		if (!policy) { throw new Error('Modo de execução inválido.'); }
		policy.updatedAt = Date.now();
		this.records.set(this.key(workspace), policy);
		ensureSecureDir(dirname(this.file));
		writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(this.records), null, '\t'));
		return { ...policy };
	}
}

/** Commands whose effect leaves this computer. A list of prefixes: it stops the plain cases, it is not a sandbox. */
export const EXTERNAL_COMMANDS: readonly string[] = ['git push', 'git remote add', 'git remote set-url', 'gh ', 'vercel', 'netlify', 'npm publish', 'pnpm publish', 'yarn publish', 'npx vercel', 'npx netlify',
	'firebase deploy', 'wrangler', 'docker push', 'twine upload', 'cargo publish', 'dotnet nuget push', 'gcloud ', 'aws ', 'az ', 'kubectl ', 'heroku ', 'flyctl ', 'scp ', 'ssh ', 'rsync '];

export interface OpenCodeRule { action: string; resource: string; effect: 'allow' | 'deny' }

/**
 * The permission rules given to OpenCode through its official inline configuration (`permissions`, last rule wins). `undefined` means
 * "do not touch its configuration": what a comparison did before this policy existed.
 */
export function openCodeRules(policy: ExecutionPolicy, role: AgentRole | undefined): OpenCodeRule[] | undefined {
	if (role === 'reviewer' || role === 'tester') { return [{ action: 'shell', resource: '*', effect: 'deny' }, { action: 'edit', resource: '*', effect: 'deny' }]; }
	if (policy.mode === 'restricted') { return role === 'implementer' ? [{ action: 'shell', resource: '*', effect: 'deny' }] : undefined; }
	const rules: OpenCodeRule[] = policy.mode === 'development' ? [{ action: 'external_directory', resource: '*', effect: 'deny' }] : [];
	if (!policy.external) { for (const command of EXTERNAL_COMMANDS) { rules.push({ action: 'shell', resource: command.trimEnd() + '*', effect: 'deny' }); } }
	return rules;
}

/** Adds the rules to an inline configuration that may already exist (the isolated profile, or one of the person). */
export function openCodeConfig(existing: string | undefined, rules: OpenCodeRule[] | undefined): string | undefined {
	if (!rules) { return existing; }
	let config: Record<string, unknown> = {};
	if (existing?.trim()) {
		try { config = JSON.parse(existing) as Record<string, unknown>; } catch { throw new Error('O ambiente define uma configuração inline do OpenCode que não pôde ser lida. A política de execução não pode ser aplicada com segurança.'); }
		if (!config || typeof config !== 'object' || Array.isArray(config)) { throw new Error('A configuração inline do OpenCode é inválida.'); }
	}
	return JSON.stringify({ ...config, permissions: [...(Array.isArray(config.permissions) ? config.permissions as unknown[] : []), ...rules] });
}

export interface ClaudeLaunch { permissionMode: 'plan' | 'acceptEdits' | 'bypassPermissions'; allowedTools?: string[]; disallowedTools?: string[] }
/** Claude Code: its own permission modes and tool lists, all official flags. Without a role (a comparison) it stays as it was. */
export function claudeLaunch(policy: ExecutionPolicy, role: AgentRole | undefined): ClaudeLaunch {
	if (role === 'reviewer' || role === 'tester') { return { permissionMode: 'plan' }; }
	if (policy.mode === 'restricted') { return { permissionMode: 'acceptEdits' }; }
	const disallowedTools = policy.external ? undefined : EXTERNAL_COMMANDS.map(command => `Bash(${command.trimEnd()}:*)`);
	return policy.mode === 'development' ? { permissionMode: 'acceptEdits', allowedTools: ['Bash'], ...(disallowedTools ? { disallowedTools } : {}) }
		: { permissionMode: 'bypassPermissions', ...(disallowedTools ? { disallowedTools } : {}) };
}

export interface CodexLaunch { sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'; network?: boolean }
/**
 * Codex CLI: its sandbox. `workspace-write` already lets it run commands inside the working copy, without network; development adds
 * the network (to install dependencies) and autonomous lifts the sandbox. It has no rule per command, so `external` is only an instruction.
 */
export function codexLaunch(policy: ExecutionPolicy, role: AgentRole | undefined): CodexLaunch {
	if (role === 'reviewer' || role === 'tester') { return { sandbox: 'read-only' }; }
	if (policy.mode === 'restricted') { return { sandbox: 'workspace-write' }; }
	return policy.mode === 'development' ? { sandbox: 'workspace-write', network: true } : { sandbox: 'danger-full-access' };
}

/** What the implementer is told about the terminal. The harness enforces what it can; this says the same thing in words. */
export function implementerInstructions(policy: ExecutionPolicy): string {
	const outside = policy.external
		? 'O proprietário autorizou operações externas neste workspace: quando a tarefa pedir, você pode publicar (git push, deploy, CLIs de hospedagem). Informe exatamente o que publicou e onde.'
		: 'Não publique nem envie nada para fora deste computador (git push, deploy, publicação de pacotes): essas operações não estão autorizadas neste workspace. Se a tarefa pedir publicação, deixe tudo pronto e diga o que falta autorizar.';
	if (policy.mode === 'restricted') { return 'Produza arquivos reais com ferramentas de edição. Não execute comandos de shell, testes ou outras CLIs nesta etapa.'; }
	const base = 'Produza arquivos reais. Você pode usar o terminal neste worktree: instalar dependências, compilar, executar testes e linters, e usar o Git para inspecionar. Execute de fato os comandos e relate o resultado real (comando e código de saída); nunca afirme que um teste passou sem tê-lo executado. '
		+ 'Não altere o histórico nem as referências do repositório (nada de reset, rebase, checkout de outro ramo, branch, tag, stash ou config); commits não são necessários, o Hub captura as alterações do diretório. ';
	return base + (policy.mode === 'development' ? 'Trabalhe dentro deste worktree; não modifique arquivos fora dele. ' : '') + outside;
}

const SECRET = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|[A-Za-z0-9+=_-]{48,})\b/g;
const ASSIGNED = /((?:token|secret|password|passwd|senha|api[_-]?key|authorization|bearer)["']?\s*[:=]\s*["']?)([^\s"']{6,})/gi;
/** Removes what looks like a credential from a command or its output before it is shown or stored. */
export function redact(text: string): string {
	return text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, (_match, scheme: string) => scheme + ' [oculto]').replace(ASSIGNED, (_match, label: string) => label + '[oculto]').replace(SECRET, '[oculto]');
}
