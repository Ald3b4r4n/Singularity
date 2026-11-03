import * as fs from 'fs';
import { newId, newToken } from './auth';
import { discover, Discovered } from './discovery';
import { Logger } from './logger';
import { file, hubHome } from './paths';
import { ConnectionInfo, HUB_VERSION, PROTOCOL } from './protocol';
import { ensureSecureDir, writeFileAtomic } from './secure';
import { HubServer, ServerLimits } from './server';

export type StartResult =
	| { kind: 'started'; server: HubServer; info: ConnectionInfo; token: string; release: () => Promise<void> }
	| { kind: 'already-running'; existing: Discovered };

export interface StartOptions {
	home?: string;
	limits?: Partial<ServerLimits>;
	onShutdownRequested?: () => void;
	/** How long to wait for another starter to finish before giving up. */
	waitMs?: number;
}

interface LockContent { pid: number; nonce: string; startedAt: string }

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function readLock(lockPath: string): LockContent | undefined {
	try {
		return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockContent;
	} catch {
		return undefined;
	}
}

/**
 * Single instance per state directory.
 *
 * A pid or a lock file alone proves nothing (pids are reused, files survive crashes), so the decision is:
 *  - exclusive-create hub.lock; the winner becomes the Hub,
 *  - a loser asks "is there a Hub that can prove its identity?" (discover). If yes, it exits,
 *  - if not, the lock is stale only when its owner pid is dead or the lock is old and no Hub ever came up.
 */
export async function startHub(options: StartOptions = {}): Promise<StartResult> {
	const home = options.home ?? hubHome();
	ensureSecureDir(home);
	const lockPath = file(home, 'lock');
	const deadline = Date.now() + (options.waitMs ?? 10_000);
	const logger = new Logger(file(home, 'log'));

	for (; ;) {
		let lockFd: number | undefined;
		const mine: LockContent = { pid: process.pid, nonce: newId(), startedAt: new Date().toISOString() };
		try {
			lockFd = fs.openSync(lockPath, 'wx', 0o600);
			fs.writeSync(lockFd, JSON.stringify(mine));
			fs.closeSync(lockFd);
			lockFd = undefined;
		} catch (e) {
			if (lockFd !== undefined) {
				fs.closeSync(lockFd);
			}
			if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw e;
			}
			try {
				return { kind: 'already-running', existing: await discover(home, 1500) };
			} catch {
				// nobody answered for the lock: either the owner is still starting up, or the lock is stale
			}
			const owner = readLock(lockPath);
			const age = (() => { try { return Date.now() - fs.statSync(lockPath).mtimeMs; } catch { return 0; } })();
			const stale = !owner || !pidAlive(owner.pid) || age > 30_000;
			if (stale) {
				const again = readLock(lockPath);
				if ((again?.nonce ?? '') === (owner?.nonce ?? '')) {
					fs.rmSync(lockPath, { force: true });
					logger.log('warn', 'removed stale lock');
				}
				continue;
			}
			if (Date.now() > deadline) {
				throw new Error('Another Hub is starting but did not become ready in time.');
			}
			await sleep(150);
			continue;
		}

		// We own the lock. From here on, any failure must release it.
		const token = newToken();
		const instanceId = newId();
		const startedAt = new Date().toISOString();
		const server = new HubServer({ token, instanceId, startedAt, logger, limits: options.limits, onShutdownRequested: options.onShutdownRequested });
		try {
			const port = await server.listen();
			const info: ConnectionInfo = { v: 1, instanceId, pid: process.pid, port, startedAt, hubVersion: HUB_VERSION, protocol: PROTOCOL };
			// Token first, connection.json last: discovery trusts a Hub only once both exist.
			writeFileAtomic(file(home, 'token'), token + '\n');
			writeFileAtomic(file(home, 'connection'), JSON.stringify(info, null, 2));
			logger.log('info', 'hub started', { port, pid: process.pid });
			const release = async (): Promise<void> => {
				await server.close();
				// Only remove what is ours: a newer Hub may already own the files.
				const lock = readLock(lockPath);
				if (lock?.nonce === mine.nonce) {
					for (const name of ['connection', 'token', 'lock'] as const) {
						fs.rmSync(file(home, name), { force: true });
					}
				}
				logger.log('info', 'hub stopped');
			};
			return { kind: 'started', server, info, token, release };
		} catch (e) {
			await server.close().catch(() => undefined);
			for (const name of ['connection', 'token', 'lock'] as const) {
				fs.rmSync(file(home, name), { force: true });
			}
			throw e;
		}
	}
}
