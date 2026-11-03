import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import { identityProof, tokenMatches } from './auth';
import { file, hubHome } from './paths';
import { ConnectionInfo, IDENTITY_PATH } from './protocol';
import { readSecureFile } from './secure';

export interface Discovered { info: ConnectionInfo; token: string; home: string }

export class DiscoveryError extends Error {
	constructor(readonly reason: 'no-hub' | 'unprotected' | 'invalid-info' | 'unreachable' | 'identity-mismatch', message: string) {
		super(message);
	}
}

function parseInfo(text: string): ConnectionInfo {
	let v: Partial<ConnectionInfo>;
	try {
		v = JSON.parse(text) as Partial<ConnectionInfo>;
	} catch {
		throw new DiscoveryError('invalid-info', 'connection.json is not valid JSON');
	}
	if (v.v !== 1 || typeof v.instanceId !== 'string' || !Number.isInteger(v.port) || (v.port as number) < 1024 || (v.port as number) > 65535 || !Number.isInteger(v.pid)) {
		throw new DiscoveryError('invalid-info', 'connection.json has unexpected content');
	}
	return v as ConnectionInfo;
}

function fetchIdentity(port: number, nonce: string, timeoutMs: number): Promise<{ instanceId?: unknown; proof?: unknown }> {
	return new Promise((resolve, reject) => {
		const req = http.get({ host: '127.0.0.1', port, path: IDENTITY_PATH, headers: { 'x-singularity-nonce': nonce }, agent: false, timeout: timeoutMs }, res => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', chunk => { body += chunk; if (body.length > 4096) { req.destroy(); } });
			res.on('end', () => {
				try { resolve(res.statusCode === 200 ? JSON.parse(body) as { instanceId?: unknown; proof?: unknown } : {}); } catch { resolve({}); }
			});
		});
		req.on('timeout', () => req.destroy(new Error('timeout')));
		req.on('error', reject);
	});
}

/**
 * Finds the running Hub of this user and proves it is the real one.
 * 1. The state directory and both files must be restricted to the current user.
 * 2. The server must answer a fresh nonce with an HMAC only the token holder can compute.
 * Only then is the token returned for use in an Authorization header.
 */
export async function discover(home: string = hubHome(), timeoutMs = 2000): Promise<Discovered> {
	if (!fs.existsSync(file(home, 'connection')) || !fs.existsSync(file(home, 'token'))) {
		throw new DiscoveryError('no-hub', 'No Hub is running');
	}
	let infoText: string;
	let token: string;
	try {
		infoText = readSecureFile(file(home, 'connection'));
		token = readSecureFile(file(home, 'token')).trim();
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') {
			throw new DiscoveryError('no-hub', 'No Hub is running');
		}
		throw new DiscoveryError('unprotected', 'Connection files are missing or not protected for the current user');
	}
	const info = parseInfo(infoText);
	const nonce = crypto.randomBytes(18).toString('base64url');
	let answer: { instanceId?: unknown; proof?: unknown };
	try {
		answer = await fetchIdentity(info.port, nonce, timeoutMs);
	} catch {
		throw new DiscoveryError('unreachable', 'The Hub did not answer');
	}
	if (answer.instanceId !== info.instanceId || typeof answer.proof !== 'string' || !tokenMatches(answer.proof, identityProof(token, info.instanceId, nonce))) {
		throw new DiscoveryError('identity-mismatch', 'The process on the Hub port could not prove it is the Hub');
	}
	return { info, token, home };
}
