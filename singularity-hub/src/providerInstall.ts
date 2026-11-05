import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ensureSecureDir, isOwnerOnly } from './secure';

const run = promisify(execFile);
const packages = {
	opencode: {
		version: '2.2.5',
		url: 'https://registry.npmjs.org/@opencode/cli-windows-x64-baseline/-/cli-windows-x64-baseline-2.2.5.tgz',
		digest: 'MSSHmCs7301UnYROwPZUjx081pbfuavFgvr0A8zFyAyKu2bP+fMxNvzKcWXLNC8cnFF1flQtFZQlvUbS0+QwEA==',
		prefix: 'package/bin',
		executable: 'opencode.exe'
	},
	'claude-code': {
		version: '2.1.318',
		url: 'https://registry.npmjs.org/@anthropic-ai/claude-code-win32-x64/-/claude-code-win32-x64-2.1.318.tgz',
		digest: 'g/fa2hqcU/+Qd3NMaY/8i+AoX6HQt3zBcj+V/Ot9icr5TN4PmOmuy6YhVNFLHb2IniLIrBA+gZFqonUe0aYLxg==',
		prefix: 'package',
		executable: 'claude.exe'
	},
	'codex-cli': {
		version: '0.166.0',
		url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.166.0-win32-x64.tgz',
		digest: 'NS8Ps5oG5r19pCrMCUXwUqOui6odnUIoBlQkrjCJ+h1k6KiwCzC/+mI9d3nSZCqFoVONPBTmqyq8NYq3YaFGyA==',
		prefix: 'package/vendor/x86_64-pc-windows-msvc',
		executable: 'bin/codex.exe'
	}
} as const;

export type InstallProviderId = keyof typeof packages;
const overrides: Record<InstallProviderId, string> = {
	opencode: 'SINGULARITY_OPENCODE', 'claude-code': 'SINGULARITY_CLAUDE_CODE', 'codex-cli': 'SINGULARITY_CODEX_CLI'
};
const installing = new Map<InstallProviderId, AbortController>();

export function cancelProviderInstall(id: InstallProviderId): boolean {
	const running = installing.get(id);
	running?.abort();
	return !!running;
}

export function installOffer(id: string): { version: string; url: string } | undefined {
	if (process.platform !== 'win32' || process.arch !== 'x64' || !Object.hasOwn(packages, id)) { return undefined; }
	const provider = id as InstallProviderId;
	if (process.env[overrides[provider]]) { return undefined; }
	const { version, url } = packages[provider];
	return { version, url };
}

function installationDir(id: InstallProviderId, env: NodeJS.ProcessEnv): string | undefined {
	return env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA)
		? join(env.LOCALAPPDATA, 'Singularity', 'Providers', id, packages[id].version) : undefined;
}

export function managedProviderPath(id: InstallProviderId, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const directory = installationDir(id, env);
	if (!directory) { return undefined; }
	const current = join(directory, packages[id].executable);
	if (id === 'claude-code' && !existsSync(directory)) {
		const previous = join(dirname(directory), '2.1.292', packages[id].executable);
		if (existsSync(previous)) { return previous; }
	}
	return current;
}

export function providerMaintenance(id: InstallProviderId, existing?: string) {
	const offer = installOffer(id);
	if (!offer) { return undefined; }
	const target = installationDir(id, process.env);
	if (!target) { return undefined; }
	const expected = managedProviderPath(id);
	if (existing && (!expected || resolve(existing).toLowerCase() !== resolve(expected).toLowerCase())) { return undefined; }
	if (existsSync(target)) { return { ...offer, operation: 'repair' as const }; }
	if (existing && id === 'claude-code') { return { ...offer, operation: 'update' as const }; }
	return undefined;
}

export function providerBusy(id: InstallProviderId): boolean { return installing.has(id); }

export class ProviderInstallError extends Error { }

export async function verifyProviderArchive(id: InstallProviderId, archive: string): Promise<void> {
	const hash = createHash('sha512');
	for await (const chunk of createReadStream(archive)) { hash.update(chunk); }
	if (hash.digest('base64') !== packages[id].digest) {
		throw new ProviderInstallError('O pacote falhou na verificação de integridade.');
	}
}

export async function installProvider(id: InstallProviderId, version: string, existing: () => string | undefined, operation: 'install' | 'repair' | 'update' = 'install', canReplace: () => boolean = () => true): Promise<void> {
	const offer = installOffer(id);
	if (!offer || offer.version !== version) { throw new ProviderInstallError('Versão ou plataforma não suportada.'); }
	const target = installationDir(id, process.env);
	const valid = () => operation === 'install' ? !existing() && !!target && !existsSync(target)
		: providerMaintenance(id, existing())?.operation === operation;
	if (!canReplace()) { throw new ProviderInstallError('Encerre as sessões do provedor antes da manutenção.'); }
	if (!target || installing.has(id) || !valid()) {
		throw new ProviderInstallError('Já existe uma instalação ou configuração, ou há uma instalação em andamento.');
	}
	const selected = packages[id];
	const directory = dirname(target);
	const system = join(process.env.SystemRoot ?? 'C:\Windows', 'System32');
	const cancellation = new AbortController();
	installing.set(id, cancellation);
	let staging: string | undefined;
	try {
		ensureSecureDir(directory);
		staging = await mkdtemp(join(directory, 'install-'));
		const archive = join(staging, 'provider.tgz');
		try {
			await run(join(system, 'curl.exe'), ['--disable', '--fail', '--silent', '--show-error', '--proto', '=https', '--connect-timeout', '15',
				'--max-time', '180', '--max-filesize', '314572800', '--output', archive, selected.url], { windowsHide: true, timeout: 185000, signal: cancellation.signal });
		} catch {
			throw new ProviderInstallError(cancellation.signal.aborted ? 'Instalação cancelada.' : 'O download oficial falhou. Confira a conexão e tente novamente.');
		}
		await verifyProviderArchive(id, archive);
		// Extract only the immutable, digest-verified vendor subtree with the Windows archive tool.
		await run(join(system, 'tar.exe'), ['-xf', archive, '-C', staging, selected.prefix], {
			windowsHide: true, timeout: 60000, signal: cancellation.signal
		});
		const payload = join(staging, selected.prefix);
		const candidate = join(payload, selected.executable);
		if (!isOwnerOnly(candidate)) { throw new ProviderInstallError('O executável não está protegido pela ACL esperada.'); }
		const check = await run(candidate, ['--version'], { cwd: payload, windowsHide: true, timeout: 20000, signal: cancellation.signal });
		if (/\b(\d+\.\d+\.\d+)\b/.exec(check.stdout.replace(/v(?=\d)/g, ''))?.[1] !== version) {
			throw new ProviderInstallError('A versão do executável oficial não foi confirmada.');
		}
		if (!valid() || !canReplace()) { throw new ProviderInstallError('A instalação mudou ou há uma sessão ativa.'); }
		cancellation.signal.throwIfAborted();
		if (operation === 'repair') {
			const backup = await mkdtemp(join(directory, 'backup-'));
			const previous = join(backup, 'previous');
			let retainBackup = false;
			try {
				await rename(target, previous);
				try { await rename(payload, target); }
				catch (error) {
					try { await rename(previous, target); }
					catch { retainBackup = true; throw new ProviderInstallError('Falha ao restaurar a instalação. A versão anterior foi preservada em ' + previous); }
					throw error;
				}
			} finally {
				if (!retainBackup) { await rm(backup, { recursive: true, force: true }).catch(() => undefined); }
			}
		} else {
			await rename(payload, target);
		}
	} catch (error) {
		if (cancellation.signal.aborted) { throw new ProviderInstallError('Instalação cancelada.'); }
		throw error;
	} finally {
		installing.delete(id);
		if (staging) { await rm(staging, { recursive: true, force: true }); }
	}
}
