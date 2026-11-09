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

/** Publishes `127.0.0.1:<port>` as HTTPS to the user's own devices. Requires the caller to have obtained explicit consent. */
export async function enableServe(port: number, env: NodeJS.ProcessEnv = process.env, runner: Runner = run): Promise<{ ok: boolean; reason?: string }> {
	const executable = tailscaleExecutable(env);
	if (!executable || !Number.isInteger(port) || port < 1024 || port > 65535) { return { ok: false, reason: 'Tailscale indisponível.' }; }
	const result = await runner(executable, ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`], 30000);
	return result.code === 0 ? { ok: true } : { ok: false, reason: 'O Tailscale recusou o comando serve. Verifique se o HTTPS está habilitado na sua conta.' };
}

export async function disableServe(env: NodeJS.ProcessEnv = process.env, runner: Runner = run): Promise<{ ok: boolean }> {
	const executable = tailscaleExecutable(env);
	if (!executable) { return { ok: false }; }
	return { ok: (await runner(executable, ['serve', '--https=443', 'off'], 30000)).code === 0 };
}
