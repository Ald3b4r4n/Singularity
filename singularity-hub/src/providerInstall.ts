import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
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
		version: '2.1.292',
		url: 'https://registry.npmjs.org/@anthropic-ai/claude-code-win32-x64/-/claude-code-win32-x64-2.1.292.tgz',
		digest: 'CXrrjj7Czs9o2YossKkN3z/K+/1GmIjjt3H8muHBDzxw/WM/J9I4kz6jBI4wLwt5miVMkXwwhrwT0hhyNPYAIw==',
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
	return directory ? join(directory, packages[id].executable) : undefined;
}

export class ProviderInstallError extends Error { }

export async function verifyProviderArchive(id: InstallProviderId, archive: string): Promise<void> {
	const hash = createHash('sha512');
	for await (const chunk of createReadStream(archive)) { hash.update(chunk); }
	if (hash.digest('base64') !== packages[id].digest) {
		throw new ProviderInstallError('O pacote falhou na verificação de integridade.');
	}
}

export async function installProvider(id: InstallProviderId, version: string, existing: () => string | undefined): Promise<void> {
	const offer = installOffer(id);
	if (!offer || offer.version !== version) { throw new ProviderInstallError('Versão ou plataforma não suportada.'); }
	const target = installationDir(id, process.env);
	if (!target || installing.has(id) || existing() || existsSync(target)) {
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
		if (existing() || existsSync(target)) { throw new ProviderInstallError('Outra instalação foi encontrada.'); }
		cancellation.signal.throwIfAborted();
		await rename(payload, target);
	} catch (error) {
		if (cancellation.signal.aborted) { throw new ProviderInstallError('Instalação cancelada.'); }
		throw error;
	} finally {
		installing.delete(id);
		if (staging) { await rm(staging, { recursive: true, force: true }); }
	}
}
