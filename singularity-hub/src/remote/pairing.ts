import { fingerprintOf, newId, newPairingCode, newToken, normalizeCode, sameSecret } from './security';

export const PAIRING_TTL_MS = 2 * 60 * 1000;
const CLAIM_TTL_MS = 3 * 60 * 1000;
const MAX_CLAIMS = 4;

export interface Claim {
	id: string;
	deviceName: string;
	createdAt: number;
	expiresAt: number;
	/** What the phone shows and the computer shows: the user compares them before approving. */
	fingerprint: string;
	status: 'pending' | 'approved' | 'denied';
	/** Only the phone knows this; it is what lets it collect the token, once. */
	secret: string;
	token?: string;
}

/**
 * The pairing handshake:
 *   1. the computer opens a request and shows a short code (valid for two minutes, one claim);
 *   2. the phone sends the code and a device name and receives a claim id and a claim secret;
 *   3. the computer shows the device name and a fingerprint and the user approves or denies;
 *   4. the phone polls with its claim secret and receives the device token exactly once.
 * A code that was claimed, expired or guessed wrongly never works again.
 */
export class Pairing {
	private request?: { code: string; expiresAt: number; claimed: boolean };
	private readonly claims = new Map<string, Claim>();

	constructor(private readonly authorize: (name: string) => { token: string }, private readonly now: () => number = Date.now) { }

	start(): { code: string; expiresAt: number } {
		this.request = { code: newPairingCode(), expiresAt: this.now() + PAIRING_TTL_MS, claimed: false };
		return { code: this.request.code, expiresAt: this.request.expiresAt };
	}

	cancel(): void { this.request = undefined; }

	active(): { expiresAt: number } | undefined {
		return this.request && !this.request.claimed && this.request.expiresAt > this.now() ? { expiresAt: this.request.expiresAt } : undefined;
	}

	/** Returns the claim or undefined; the caller counts every undefined as a failed attempt. */
	claim(code: unknown, deviceName: unknown): { id: string; secret: string; fingerprint: string; expiresAt: number } | undefined {
		this.sweep();
		const normalized = normalizeCode(code);
		const request = this.request;
		if (!normalized || !request || request.claimed || request.expiresAt <= this.now() || !sameSecret(normalized, request.code)) { return undefined; }
		if (typeof deviceName !== 'string' || !deviceName.trim() || this.claims.size >= MAX_CLAIMS) { return undefined; }
		request.claimed = true;
		const secret = newToken();
		const claim: Claim = { id: newId(), deviceName: deviceName.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40) || 'Android', createdAt: this.now(), expiresAt: this.now() + CLAIM_TTL_MS, fingerprint: fingerprintOf(secret), status: 'pending', secret };
		this.claims.set(claim.id, claim);
		this.request = undefined;
		return { id: claim.id, secret, fingerprint: claim.fingerprint, expiresAt: claim.expiresAt };
	}

	pending(): Array<Pick<Claim, 'id' | 'deviceName' | 'fingerprint' | 'createdAt' | 'expiresAt'>> {
		this.sweep();
		return [...this.claims.values()].filter(claim => claim.status === 'pending').map(({ id, deviceName, fingerprint, createdAt, expiresAt }) => ({ id, deviceName, fingerprint, createdAt, expiresAt }));
	}

	/** The computer's decision. Approving creates the device; the token waits for the phone to collect it. */
	decide(id: string, approve: boolean): boolean {
		this.sweep();
		const claim = this.claims.get(id);
		if (!claim || claim.status !== 'pending') { return false; }
		if (approve) { claim.token = this.authorize(claim.deviceName).token; claim.status = 'approved'; } else { claim.status = 'denied'; }
		return true;
	}

	/** What the phone sees. The token is handed over once and then forgotten. */
	poll(id: unknown, secret: unknown): { status: 'pending' | 'approved' | 'denied' | 'expired'; token?: string } {
		this.sweep();
		const claim = typeof id === 'string' ? this.claims.get(id) : undefined;
		if (!claim || typeof secret !== 'string' || !sameSecret(secret, claim.secret)) { return { status: 'expired' }; }
		if (claim.status === 'approved') {
			const token = claim.token;
			this.claims.delete(claim.id);
			return { status: 'approved', token };
		}
		if (claim.status === 'denied') { this.claims.delete(claim.id); return { status: 'denied' }; }
		return { status: 'pending' };
	}

	private sweep(): void {
		const t = this.now();
		for (const [id, claim] of this.claims) { if (claim.expiresAt <= t) { this.claims.delete(id); } }
		if (this.request && this.request.expiresAt <= t) { this.request = undefined; }
	}
}
