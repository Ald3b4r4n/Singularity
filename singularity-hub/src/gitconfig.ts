/**
 * The Hub runs Git without the person's global and system configuration: no hook, filter driver, alias or credential helper of theirs can
 * change what a Hub command does. One part of that configuration is not optional, though: how line endings are stored in working files.
 * Git for Windows is normally installed with core.autocrlf=true, so a project checked out there has CRLF working files over LF blobs. If
 * the Hub ignored that, a perfectly clean project would look modified (every text file, to the byte), a worktree would not hold the same
 * bytes as the project it came from, and a solution would "change" every file it merely copied.
 *
 * So the effective line-ending settings of the project (system, global and repository level, as the person's own Git sees them), and only
 * those, are read once and given to every Hub Git command that works on that project, its worktrees or its staging clones. Nothing is
 * ever written to any configuration. `.gitattributes` needs no help: Git reads it from the repository itself.
 */
import { execFile } from 'node:child_process';

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: Promise<string[]> }>();
const aliases = new Map<string, string>();
const fold = (path: string): string => path.replace(/[\\/]+$/, '').toLowerCase();

const read = (workspace: string, key: string): Promise<string> => new Promise(resolve => {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
	for (const name of Object.keys(env)) { if (name.startsWith('GIT_') && name !== 'GIT_TERMINAL_PROMPT') { delete env[name]; } }
	execFile('git', ['-c', 'core.hooksPath=', '-C', workspace, 'config', '--get', key], { env, windowsHide: true, timeout: 8000, encoding: 'utf8' }, (error, stdout) => resolve(error ? '' : String(stdout).trim().toLowerCase()));
});

/**
 * A staging clone or any other directory the Hub creates for a project has no configuration of its own worth reading: it follows the
 * project it was made for.
 */
export function followLineEndings(directory: string, project: string): void {
	aliases.set(fold(directory), project);
	if (aliases.size > 2048) { aliases.delete(aliases.keys().next().value as string); }
}

/** `-c core.autocrlf=…` and `-c core.eol=…` as they are in effect for this project, or nothing when they are not set. */
export function lineEndingArgs(workspace: string, now = Date.now()): Promise<string[]> {
	const source = aliases.get(fold(workspace)) ?? workspace;
	const key = fold(source);
	const hit = cache.get(key);
	if (hit && now - hit.at < TTL_MS) { return hit.value; }
	const value = (async (): Promise<string[]> => {
		const [autocrlf, eol] = await Promise.all([read(source, 'core.autocrlf'), read(source, 'core.eol')]);
		return [...(['true', 'false', 'input'].includes(autocrlf) ? ['-c', `core.autocrlf=${autocrlf}`] : []), ...(['lf', 'crlf', 'native'].includes(eol) ? ['-c', `core.eol=${eol}`] : [])];
	})();
	cache.set(key, { at: now, value });
	if (cache.size > 512) { cache.delete(cache.keys().next().value as string); }
	return value;
}

export const clearLineEndingCache = (): void => { cache.clear(); };

export type EolStyle = 'none' | 'lf' | 'crlf' | 'mixed';
/** How a text buffer ends its lines. Binary data (a NUL byte) has no style. */
export function eolStyle(data: Buffer): EolStyle | 'binary' {
	if (data.includes(0)) { return 'binary'; }
	let lf = 0, crlf = 0;
	for (let index = data.indexOf(10); index !== -1; index = data.indexOf(10, index + 1)) { if (index > 0 && data[index - 1] === 13) { crlf++; } else { lf++; } }
	return crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none';
}
