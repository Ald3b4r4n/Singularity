import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { startHub, StartOptions, StartResult } from '../instance';

// Tests must never touch the real per-user directory: anything that falls back to the default lands in a throwaway one.
process.env.SINGULARITY_HUB_HOME = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sing-default-')), 'state');

export const MAIN = path.join(__dirname, '..', 'main.js');

export function tempHome(label = 'hub'): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `sing-${label}-`)), 'state');
}

export function cleanup(home: string): void {
	fs.rmSync(path.dirname(home), { recursive: true, force: true });
}

export async function startInProcess(home: string, options: StartOptions = {}): Promise<Extract<StartResult, { kind: 'started' }>> {
	const r = await startHub({ home, ...options });
	if (r.kind !== 'started') {
		throw new Error('expected a fresh Hub');
	}
	return r;
}

export interface UpgradeAttempt { status: number; headers: http.IncomingHttpHeaders }

/** Sends a raw WebSocket upgrade request with exactly the headers given and reports the HTTP status (101 = accepted). */
export function attemptUpgrade(port: number, opts: { path?: string; headers?: Record<string, string | undefined> }): Promise<UpgradeAttempt> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = {
			Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
		};
		for (const [k, v] of Object.entries(opts.headers ?? {})) {
			if (v === undefined) { delete headers[k]; } else { headers[k] = v; }
		}
		const req = http.request({ host: '127.0.0.1', port, path: opts.path ?? '/ws', headers, agent: false });
		req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode ?? 101, headers: res.headers }); });
		req.on('response', res => { res.resume(); resolve({ status: res.statusCode ?? 0, headers: res.headers }); });
		req.on('error', reject);
		req.end();
	});
}

export function httpGet(port: number, pathName: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		http.get({ host: '127.0.0.1', port, path: pathName, headers, agent: false }, res => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', c => { body += c; });
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
		}).on('error', reject);
	});
}

export function spawnMain(home: string): ChildProcess {
	return spawn(process.execPath, [MAIN], { env: { ...process.env, SINGULARITY_HUB_HOME: home }, stdio: 'ignore', windowsHide: true });
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 10_000, everyMs = 100): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (; ;) {
		const v = await fn();
		if (v) {
			return v;
		}
		if (Date.now() > deadline) {
			throw new Error('waitFor timed out');
		}
		await sleep(everyMs);
	}
}

export const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
