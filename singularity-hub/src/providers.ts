import { execFile } from 'node:child_process';
import { openCodeExecutable, openCodeRunnable } from './opencode';
import { claudeExecutable, inspectClaude } from './claude';
import { codexExecutable, inspectCodex } from './codex';

export async function inspectProviders(probeOpenCode: () => Promise<boolean>, refresh: boolean) {
	const inspect = async (id: string, name: string, source: string, executable: string | undefined,
		probe: () => Promise<{ reason?: string; authenticationRequired?: boolean; version?: string }>) => {
		const base = { id, name, source, executable };
		if (!executable) { return { ...base, status: 'not-installed' }; }
		try {
			const facts = await probe();
			return { ...base, ...facts, status: facts.authenticationRequired ? 'authentication-required' : facts.reason ? 'unavailable' : 'ready' };
		} catch {
			return { ...base, status: 'error', reason: 'Não foi possível verificar a integração.' };
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
			'reason' in facts ? facts : { version: facts.version })),
		inspect('codex-cli', 'Codex CLI', 'https://github.com/openai/codex', codexExecutable(), () => inspectCodex(refresh).then(facts =>
			'reason' in facts ? facts : { version: facts.version })),
		Promise.resolve({ id: 'gemini-cli', name: 'Gemini CLI', status: 'planned' })
	]);
}
