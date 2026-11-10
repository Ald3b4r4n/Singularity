import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * Optional private HTTPS through Tailscale Serve. This module only ever runs `tailscale status` and `tailscale serve` (publishing to the
 * user's own tailnet). It never runs `tailscale funnel` (public internet), never installs anything and never changes the firewall.
 */
export interface TailscaleState {
	installed: boolean;
	loggedIn: boolean;
	/** The MagicDNS name of this computer inside the tailnet, e.g. `pc.tailnet.ts.net`. */
	dnsName?: string;
	reason?: string;
}

export function tailscaleExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const explicit = env.SINGULARITY_TAILSCALE;
	if (explicit) { return isAbsolute(explicit) && existsSync(explicit) ? explicit : undefined; }
	const names = process.platform === 'win32' ? ['tailscale.exe'] : ['tailscale'];
	const roots = (env.PATH ?? env.Path ?? '').split(delimiter).map(entry => entry.replace(/^"|"$/g, '')).filter(entry => isAbsolute(entry));
	if (process.platform === 'win32') { roots.push(join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale')); }
	for (const root of roots) { for (const name of names) { if (existsSync(join(root, name))) { return join(root, name); } } }
	return undefined;
}

export type Runner = (executable: string, args: string[], timeout?: number) => Promise<{ code: number; stdout: string }>;

const run: Runner = (executable, args, timeout = 15000) => {
	return new Promise(resolve => {
		execFile(executable, args, { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
			resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? '') });
		});
	});
};

export async function tailscaleState(env: NodeJS.ProcessEnv = process.env, runner: Runner = run): Promise<TailscaleState> {
	const executable = tailscaleExecutable(env);
	if (!executable) {
		return { installed: false, loggedIn: false, reason: 'O Tailscale não está instalado. Instale-o em tailscale.com/download, entre na sua conta e ative o acesso remoto de novo.' };
	}
	const result = await runner(executable, ['status', '--json']);
	try {
		const status = JSON.parse(result.stdout) as { BackendState?: string; Self?: { DNSName?: string } };
		const loggedIn = status.BackendState === 'Running';
		const dnsName = typeof status.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '').toLowerCase() : undefined;
		return { installed: true, loggedIn, ...(loggedIn && dnsName ? { dnsName } : {}), ...(loggedIn ? {} : { reason: 'O Tailscale está instalado, mas não está conectado a uma conta.' }) };
	} catch {
		return { installed: true, loggedIn: false, reason: 'Não foi possível ler o estado do Tailscale.' };
	}
}

export interface ServeConfig {
	/** False when `tailscale serve status` could not be read: nothing is then concluded and nothing is changed. */
	known: boolean;
	configured: boolean;
	/** Where the published addresses are proxied to, e.g. `http://127.0.0.1:51946`. */
	targets: string[];
	/** Funnel exposes a service to the public internet. The Singularity never turns it on; it is only reported. */
	funnel: boolean;
}

/** What Tailscale Serve is publishing on this computer right now (read-only). */
export async function serveConfig(env: NodeJS.ProcessEnv = process.env, runner: Runner = run): Promise<ServeConfig> {
	const executable = tailscaleExecutable(env);
	if (!executable) { return { known: false, configured: false, targets: [], funnel: false }; }
	const result = await runner(executable, ['serve', 'status', '--json']);
	try {
		const config = JSON.parse(result.stdout || '{}') as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>; TCP?: Record<string, unknown>; AllowFunnel?: Record<string, unknown> };
		const targets: string[] = [];
		for (const site of Object.values(config.Web ?? {})) { for (const handler of Object.values(site?.Handlers ?? {})) { if (typeof handler?.Proxy === 'string') { targets.push(handler.Proxy.replace(/\/$/, '').toLowerCase()); } } }
		const configured = targets.length > 0 || Object.keys(config.TCP ?? {}).length > 0 || Object.keys(config.Web ?? {}).length > 0;
		return { known: result.code === 0, configured, targets: [...new Set(targets)], funnel: Object.values(config.AllowFunnel ?? {}).some(value => value === true) };
	} catch {
		return { known: false, configured: false, targets: [], funnel: false };
	}
}

export const serveTarget = (port: number): string => `http://127.0.0.1:${port}`;

/**
 * Publishes `127.0.0.1:<port>` as HTTPS to the user's own devices. Requires the caller to have obtained explicit consent. Another
 * publication that is not this gateway's own (current or previous port) is never replaced unless that was asked for explicitly.
 */
export async function enableServe(port: number, env: NodeJS.ProcessEnv = process.env, runner: Runner = run, options: { previousPort?: number; replace?: boolean } = {}): Promise<{ ok: boolean; reason?: string; conflict?: boolean; tailnetOnly?: boolean }> {
	const executable = tailscaleExecutable(env);
	if (!executable || !Number.isInteger(port) || port < 1024 || port > 65535) { return { ok: false, reason: 'Tailscale indisponível.' }; }
	const before = await serveConfig(env, runner);
	const mine = [serveTarget(port), ...(options.previousPort ? [serveTarget(options.previousPort)] : [])];
	const foreign = before.targets.filter(target => !mine.includes(target));
	if (before.known && foreign.length && options.replace !== true) { return { ok: false, conflict: true, reason: 'Já existe outra publicação do Tailscale Serve neste computador. Ela não foi substituída.' }; }
	const result = await runner(executable, ['serve', '--bg', '--https=443', serveTarget(port)], 30000);
	if (result.code !== 0) { return { ok: false, reason: 'O Tailscale recusou o comando serve. Verifique se o HTTPS está habilitado na sua conta.' }; }
	const after = await serveConfig(env, runner);
	if (after.known && !after.targets.includes(serveTarget(port))) { return { ok: false, reason: 'O Tailscale aceitou o comando, mas a publicação não aponta para este gateway.' }; }
	return { ok: true, tailnetOnly: after.known ? !after.funnel : undefined };
}

/**
 * Turns the publication off ONLY when it is this gateway's own. Tailscale Serve is one configuration for the whole computer: a gateway
 * that never published (another state folder, a test) must not take down what a different gateway is serving.
 */
export async function disableServe(port: number, env: NodeJS.ProcessEnv = process.env, runner: Runner = run): Promise<{ ok: boolean; skipped?: boolean }> {
	const executable = tailscaleExecutable(env);
	if (!executable) { return { ok: false }; }
	const config = await serveConfig(env, runner);
	if (!config.known || !config.targets.includes(serveTarget(port))) { return { ok: true, skipped: true }; }
	return { ok: (await runner(executable, ['serve', '--https=443', 'off'], 30000)).code === 0 };
}
