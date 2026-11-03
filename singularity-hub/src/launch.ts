import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** A real Node.js: SINGULARITY_NODE_PATH, else node(.exe) from PATH. (The IDE's own Electron binary is not a Node.) */
export function findNode(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.SINGULARITY_NODE_PATH && fs.existsSync(env.SINGULARITY_NODE_PATH)) {
		return env.SINGULARITY_NODE_PATH;
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
