import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Pairing codes avoid look-alike characters (0/O, 1/I/L) so they can be read from a screen and typed on a phone. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const newToken = (): string => randomBytes(32).toString('base64url');
export const newId = (): string => randomBytes(9).toString('base64url');
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Eight characters from a 31-symbol alphabet: about 40 bits, valid for two minutes and for one claim. */
export function newPairingCode(): string {
	const bytes = randomBytes(8);
	let code = '';
	for (const byte of bytes) { code += CODE_ALPHABET[byte % CODE_ALPHABET.length]; }
	return code.slice(0, 4) + '-' + code.slice(4);
}

export const normalizeCode = (value: unknown): string | undefined => {
	if (typeof value !== 'string') { return undefined; }
	const code = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
	if (code.length !== 8 || [...code].some(char => !CODE_ALPHABET.includes(char))) { return undefined; }
	return code.slice(0, 4) + '-' + code.slice(4);
};

export function sameSecret(a: string, b: string): boolean {
	const left = createHash('sha256').update(a).digest();
	const right = createHash('sha256').update(b).digest();
	return timingSafeEqual(left, right);
}

export const bearerOf = (header: string | string[] | undefined): string | undefined => {
	if (typeof header !== 'string') { return undefined; }
	const match = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(header);
	return match?.[1];
};

/** A short, stable label for confirming a device on the computer: it never reveals the token. */
export const fingerprintOf = (secret: string): string => hashToken(secret).slice(0, 8).toUpperCase().replace(/(.{4})(.{4})/, '$1-$2');

/**
 * Host allow-list against DNS rebinding: loopback names, plus the private-network names the user explicitly allowed
 * (the Tailscale name of this computer). Anything else is refused, whatever port it comes from.
 */
export function hostAllowed(host: string | undefined, port: number, extra: readonly string[]): boolean {
	if (!host) { return false; }
	const name = host.toLowerCase();
	const base = name.startsWith('[') ? name.slice(0, name.indexOf(']') + 1) : name.split(':')[0];
	const portPart = name.startsWith('[') ? name.slice(name.indexOf(']') + 1) : name.slice(base.length);
	if (['127.0.0.1', 'localhost', '[::1]'].includes(base)) { return portPart === `:${port}`; }
	// behind Tailscale Serve the browser addresses the standard HTTPS port, so no port is part of the Host header
	return extra.includes(base) && (portPart === '' || portPart === ':443');
}

/** The browser sends Origin on cross-site requests and on fetch POSTs; it must be the page's own origin. */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
	if (origin === undefined) { return true; }
	try { return new URL(origin).host.toLowerCase() === host?.toLowerCase(); } catch { return false; }
}
