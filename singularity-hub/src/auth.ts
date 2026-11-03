import * as crypto from 'crypto';

export const newToken = (): string => crypto.randomBytes(32).toString('base64url');
export const newId = (): string => crypto.randomUUID();

const sha256 = (s: string): Buffer => crypto.createHash('sha256').update(s).digest();

/** Constant-time comparison (both sides are hashed first, so length does not leak). */
export function tokenMatches(presented: string, expected: string): boolean {
	return crypto.timingSafeEqual(sha256(presented), sha256(expected));
}

/** Extracts the token from an "Authorization: Bearer <token>" header value. */
export function bearerToken(header: string | undefined): string | undefined {
	const m = /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(header ?? '');
	return m ? m[1] : undefined;
}

/**
 * Proof that the server knows the token, without revealing it. The client sends a fresh nonce to
 * /identity and checks this before it ever sends the token in an Authorization header, so a process
 * squatting on a stale port cannot harvest the token.
 */
export function identityProof(token: string, instanceId: string, nonce: string): string {
	return crypto.createHmac('sha256', token).update(`singularity-hub/1|${instanceId}|${nonce}`).digest('base64url');
}

export const isNonce = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(s);

/** After `max` failures inside `windowMs`, refuse every attempt for `lockMs`. */
export class FailureLimiter {
	private failures: number[] = [];
	private lockedUntil = 0;

	constructor(private readonly max = 5, private readonly windowMs = 60_000, private readonly lockMs = 30_000, private readonly now: () => number = Date.now) { }

	check(): { allowed: boolean; retryAfterMs: number } {
		const t = this.now();
		return t < this.lockedUntil ? { allowed: false, retryAfterMs: this.lockedUntil - t } : { allowed: true, retryAfterMs: 0 };
	}

	fail(): void {
		const t = this.now();
		this.failures = this.failures.filter(f => t - f < this.windowMs);
		this.failures.push(t);
		if (this.failures.length >= this.max) {
			this.lockedUntil = t + this.lockMs;
			this.failures = [];
		}
	}

	success(): void {
		this.failures = [];
	}
}

/** Token bucket per connection. */
export class RateBucket {
	private tokens: number;
	private last: number;

	constructor(private readonly perSecond: number, private readonly burst: number, private readonly now: () => number = Date.now) {
		this.tokens = burst;
		this.last = now();
	}

	take(): boolean {
		const t = this.now();
		this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.perSecond);
		this.last = t;
		if (this.tokens < 1) {
			return false;
		}
		this.tokens -= 1;
		return true;
	}
}
