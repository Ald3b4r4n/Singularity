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

/** Environment for the Hub: keep the user's essentials, drop editor/Electron variables. */
export function hubEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined && !/^(ELECTRON_|VSCODE_|ORIGINAL_XDG|CHROME_)/i.test(key)) {
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
