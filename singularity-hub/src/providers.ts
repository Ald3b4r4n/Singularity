import { installOffer, providerMaintenance, type InstallProviderId } from './providerInstall';
import { execFile } from 'node:child_process';
import { openCodeExecutable, openCodeRunnable, OpenCodeError } from './opencode';
import { claudeExecutable, inspectClaude } from './claude';
import { codexExecutable, inspectCodex } from './codex';

const officialPackage: Record<InstallProviderId, string> = {
	opencode: '@opencode/cli-windows-x64-baseline',
	'claude-code': '@anthropic-ai/claude-code-win32-x64',
	'codex-cli': '@openai/codex'
};

async function officialVersion(id: InstallProviderId): Promise<string | undefined> {
	try {
		const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(officialPackage[id]) + '/latest', {
			redirect: 'error', signal: AbortSignal.timeout(4500)
		});
		if (!response.ok) { await response.body?.cancel(); return undefined; }
		const data = await response.json() as { version?: unknown };
		return typeof data.version === 'string' && /^\d+\.\d+\.\d+$/.test(data.version) ? data.version : undefined;
	} catch { return undefined; }
}

export async function inspectProviders(probeOpenCode: () => Promise<boolean>, refresh: boolean) {
	const inspect = async (id: string, name: string, source: string, executable: string | undefined,
		probe: () => Promise<{ reason?: string; authenticationRequired?: boolean; version?: string; authenticated?: boolean }>) => {
		const latest = refresh ? await officialVersion(id as InstallProviderId) : undefined;
		const base = { id, name, source, executable, latest, maintenance: providerMaintenance(id as InstallProviderId, executable), verifiedVersion: installOffer(id)?.version };
		if (!executable) {
			const install = base.maintenance ? undefined : installOffer(id);
			return { ...base, status: 'not-installed', install };
		}
		try {
			const facts = await probe();
			return { ...base, ...facts, status: facts.authenticationRequired ? 'authentication-required' : facts.reason ? 'unavailable' : 'ready' };
		} catch (error) {
			if (error instanceof OpenCodeError && error.httpStatus) {
				if (error.httpStatus === 429 || error.httpStatus >= 500) {
					return { ...base, status: 'error', reason: 'O catálogo OpenCode está temporariamente indisponível (HTTP ' + error.httpStatus + ').' };
				}
				if (error.httpStatus === 401 || error.httpStatus === 403) {
					return { ...base, status: 'error', reason: 'O servidor local do OpenCode recusou a autenticação do Hub (HTTP ' + error.httpStatus + ').' };
				}
			}
			return { ...base, status: 'error', reason: error instanceof OpenCodeError ? error.message : 'Não foi possível consultar a integração. Confira a conexão e tente novamente.' };
		}
	};
	return Promise.all([
		inspect('opencode', 'OpenCode', 'https://opencode.ai/v2/docs', openCodeExecutable(), async () => {
			const executable = openCodeExecutable()!;
			const version = await new Promise<string | undefined>(resolve => {
				execFile(executable, ['--version'], { windowsHide: true, timeout: 5000, maxBuffer: 4096 }, (error, stdout) =>
					resolve(error ? undefined : /\d+\.\d+\.\d+/.exec(stdout)?.[0]));
			});
			if (!openCodeRunnable().ok || !version?.startsWith('2.')) {
				return { version, reason: 'OpenCode v2 e o helper Windows são necessários.' };
			}
			return { version, reason: await probeOpenCode() ? undefined : 'Nenhum modelo utilizável foi encontrado no catálogo.' };
		}),
		inspect('claude-code', 'Claude Code', 'https://code.claude.com/docs/en/setup', claudeExecutable(), () => inspectClaude(refresh).then(facts =>
			'reason' in facts ? facts : { version: facts.version, authenticated: true })),
		inspect('codex-cli', 'Codex CLI', 'https://github.com/openai/codex', codexExecutable(), () => inspectCodex(refresh).then(facts =>
			'reason' in facts ? facts : { version: facts.version, authenticated: true })),
		Promise.resolve({ id: 'gemini-cli', name: 'Gemini CLI', status: 'planned' })
	]);
}
