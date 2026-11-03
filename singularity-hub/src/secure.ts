import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// Absolute paths: a PATH entry (Git's GNU whoami, a planted icacls.exe) must never stand in for the Windows tools.
const system32 = (exe: string): string => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', exe);

export interface WindowsUser { name: string; sid: string }

let cachedUser: WindowsUser | undefined;

/** The Windows account running this process, from whoami (name and SID). */
export function currentWindowsUser(): WindowsUser {
	if (!cachedUser) {
		const out = execFileSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).trim();
		const m = /^"([^"]+)","(S-[0-9-]+)"$/.exec(out);
		if (!m) {
			throw new Error('Could not determine the current Windows user.');
		}
		cachedUser = { name: m[1], sid: m[2] };
	}
	return cachedUser;
}

const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9\\]/g, '');

/** Principals listed by icacls for a path (first line carries the path, the rest are indented). */
export function aclPrincipals(target: string): string[] {
	const out = execFileSync(system32('icacls.exe'), [target], { encoding: 'utf8', windowsHide: true });
	const principals: string[] = [];
	for (const raw of out.split(/\r?\n/)) {
		let line = raw;
		if (line.startsWith(target)) {
			line = line.slice(target.length);
		}
		const i = line.indexOf(':(');
		if (i > 0) {
			principals.push(line.slice(0, i).trim());
		}
	}
	return principals;
}

/**
 * True only if the ACL has at least one entry and every entry belongs to the current user.
 * Fails closed: anything unparseable or unexpected is "not secure".
 */
export function isOwnerOnly(target: string): boolean {
	if (process.platform !== 'win32') {
		const mode = fs.statSync(target).mode & 0o777;
		return (mode & 0o077) === 0;
	}
	try {
		const user = fold(currentWindowsUser().name);
		const principals = aclPrincipals(target);
		return principals.length > 0 && principals.every(p => fold(p) === user);
	} catch {
		return false;
	}
}

/** Creates the directory and restricts it to the current user (no inherited entries). */
export function ensureSecureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	if (process.platform === 'win32') {
		const { sid } = currentWindowsUser();
		execFileSync(system32('icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore' });
	} else {
		fs.chmodSync(dir, 0o700);
	}
	if (!isOwnerOnly(dir)) {
		throw new Error(`The state directory ${dir} is not restricted to the current user; refusing to continue.`);
	}
}

/** Write to a temp file in the same directory, flush, then rename over the target. */
export function writeFileAtomic(target: string, data: string): void {
	const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
	const fd = fs.openSync(tmp, 'wx', 0o600);
	try {
		fs.writeSync(fd, data);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		fs.renameSync(tmp, target);
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		throw e;
	}
}

/** Reads a file only if both the file and its directory are owner-only. */
export function readSecureFile(target: string): string {
	if (!isOwnerOnly(path.dirname(target)) || !isOwnerOnly(target)) {
		throw new Error('Connection files are not protected for the current user.');
	}
	return fs.readFileSync(target, 'utf8');
}
