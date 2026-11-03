import * as os from 'os';
import * as path from 'path';

export const FILES = {
	connection: 'connection.json',
	token: 'hub.token',
	lock: 'hub.lock',
	log: 'hub.log',
} as const;

/**
 * Per-user state directory: %LOCALAPPDATA%\Singularity\Hub.
 * SINGULARITY_HUB_HOME overrides it (isolated profiles and tests); it is a different "user slot",
 * so one Hub can run per directory.
 */
export function hubHome(env: NodeJS.ProcessEnv = process.env): string {
	if (env.SINGULARITY_HUB_HOME) {
		return path.resolve(env.SINGULARITY_HUB_HOME);
	}
	if (process.platform === 'win32') {
		return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Singularity', 'Hub');
	}
	return path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'singularity', 'hub');
}

export function file(home: string, name: keyof typeof FILES): string {
	return path.join(home, FILES[name]);
}
