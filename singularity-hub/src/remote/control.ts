import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { join } from 'node:path';
import { hubHome } from '../paths';
import { readSecureFile } from '../secure';

/** What the IDE uses to drive the gateway: start it on request, then talk to its admin port with the secret only the user's account can read. */
export interface GatewayInfo { pid: number; publicPort: number; adminPort: number; startedAt: string }

export const remoteDirectory = (home = hubHome()): string => join(home, 'remote');

export function readGatewayInfo(home = hubHome()): GatewayInfo | undefined {
	try {
		const info = JSON.parse(readSecureFile(join(remoteDirectory(home), 'gateway.json'))) as Partial<GatewayInfo>;
		if (!Number.isInteger(info.pid) || !Number.isInteger(info.publicPort) || !Number.isInteger(info.adminPort)) { return undefined; }
		try { process.kill(info.pid as number, 0); } catch { return undefined; }
		return info as GatewayInfo;
	} catch { return undefined; }
}

export function adminRequest<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown, home = hubHome(), timeoutMs = 20000): Promise<T> {
	const info = readGatewayInfo(home);
	if (!info) { return Promise.reject(new Error('O acesso remoto não está ativo.')); }
	const token = readSecureFile(join(remoteDirectory(home), 'admin.token'));
	const payload = body === undefined ? undefined : JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: info.adminPort, path, method, timeout: timeoutMs, agent: false, headers: { 'x-admin-token': token, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', chunk => { text += chunk; });
			res.on('end', () => {
				let parsed: unknown;
				try { parsed = JSON.parse(text || '{}'); } catch { parsed = {}; }
				if ((res.statusCode ?? 500) >= 400) { reject(new Error(String((parsed as { error?: unknown }).error ?? `HTTP ${res.statusCode}`))); } else { resolve(parsed as T); }
			});
		});
		req.on('timeout', () => req.destroy(new Error('timeout')));
		req.on('error', reject);
		if (payload) { req.write(payload); }
		req.end();
	});
}

/** Starts the gateway process detached from the IDE and waits for it to report its ports. Never called automatically. */
export async function startGateway(nodePath: string, home = hubHome()): Promise<GatewayInfo> {
	const existing = readGatewayInfo(home);
	if (existing) { return existing; }
	const entry = join(__dirname, 'main.js');
	const child = spawn(nodePath, [entry], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, SINGULARITY_HUB_HOME: home } });
	child.unref();
	for (let i = 0; i < 60; i++) {
		await new Promise(resolve => setTimeout(resolve, 150));
		const info = readGatewayInfo(home);
		if (info) { return info; }
	}
	throw new Error('O gateway remoto não iniciou.');
}

export async function stopGateway(home = hubHome()): Promise<boolean> {
	if (!readGatewayInfo(home)) { return false; }
	await adminRequest('POST', '/admin/stop', {}, home).catch(() => undefined);
	for (let i = 0; i < 40; i++) {
		if (!readGatewayInfo(home)) { return true; }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return false;
}

export const gatewayRunning = (home = hubHome()): boolean => fs.existsSync(join(remoteDirectory(home), 'gateway.json')) && !!readGatewayInfo(home);
