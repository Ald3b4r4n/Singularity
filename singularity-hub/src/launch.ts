import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Root of the Hub package: the folder that holds dist/ (and, in a distribution, runtime/). */
export const HUB_ROOT = path.resolve(__dirname, '..');

/** The Node.js shipped with the Hub in a distribution: <hub root>/runtime/node(.exe). */
export function bundledNode(root: string = HUB_ROOT): string | undefined {
	const candidate = path.join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
	return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * The Node.js that runs the Hub.
 *  1. SINGULARITY_NODE_PATH, when set (an explicit choice);
 *  2. the bundled runtime, when this is a distribution: the user's PATH is never consulted then;
 *  3. node(.exe) from PATH, for development checkouts only.
 * (The IDE's own Electron binary is not a Node.)
 */
export function findNode(env: NodeJS.ProcessEnv = process.env, root: string = HUB_ROOT): string | undefined {
	if (env.SINGULARITY_NODE_PATH && fs.existsSync(env.SINGULARITY_NODE_PATH)) {
		return env.SINGULARITY_NODE_PATH;
	}
	const bundled = bundledNode(root);
	if (bundled) {
		return bundled;
	}
	const names = process.platform === 'win32' ? ['node.exe'] : ['node'];
	for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
		for (const name of names) {
			const candidate = path.join(dir.replace(/^"|"$/g, ''), name);
			if (dir && fs.existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

export const HUB_MAIN = path.join(__dirname, 'main.js');

/**
 * Environment for the Hub, built from an allowlist: the Hub runs with only what Windows (or POSIX) needs to locate the
 * user's state and its own runtime. It inherits nothing from the IDE (Electron, VS Code, Copilot, cloud credentials,
 * proxies) and no PATH: the Hub spawns no processes, and every Windows tool it calls is addressed by absolute path.
 */
const HUB_ENV_ALLOWLIST_WIN32 = [
	'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE',
	'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
];
const HUB_ENV_ALLOWLIST_POSIX = ['HOME', 'TMPDIR', 'XDG_STATE_HOME', 'USER', 'LANG', 'LC_ALL'];

export function hubEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const allowed = process.platform === 'win32' ? HUB_ENV_ALLOWLIST_WIN32 : HUB_ENV_ALLOWLIST_POSIX;
	const env: NodeJS.ProcessEnv = {};
	// Windows environment names are case-insensitive: match them that way, but keep the name the OS reported.
	const wanted = new Set(allowed.map(k => k.toUpperCase()));
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined && (wanted.has(key.toUpperCase()) || key === 'SINGULARITY_HUB_HOME')) {
			env[key] = value;
		}
	}
	return env;
}

/**
 * Starts the Hub as an independent process: detached, no console window, no stdio shared with the parent,
 * unref'd so the parent can exit. Does not wait for it; callers poll discover().
 */
export function spawnHub(nodePath: string, main: string = HUB_MAIN, env: NodeJS.ProcessEnv = process.env): number | undefined {
	const child = spawn(nodePath, [main], {
		detached: true,
		stdio: 'ignore',
		windowsHide: true,
		env: hubEnvironment(env),
	});
	child.on('error', () => { /* reported by discovery timing out */ });
	child.unref();
	return child.pid;
}
