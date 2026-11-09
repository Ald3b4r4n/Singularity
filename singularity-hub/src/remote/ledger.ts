/**
 * Persistent, verifiable idempotency for the instructions a phone sends to an agent.
 *
 * Every send is identified by device + session + the request id the phone made for that one operation, and is bound to a keyed digest
 * of (session, text): the same id can never be reused for another instruction or another session, and the text itself is not kept.
 * The state is written to disk BEFORE the Hub is asked to run anything, so a gateway that dies at any moment still knows what it was
 * doing. A request whose outcome is not known is never sent again by itself; it is reconciled against what the Hub recorded, and when
 * that is not conclusive it stays "unknown" until the person decides.
 *
 * This is deliberately not an exactly-once protocol: if the connection drops after the Hub received the instruction and before it
 * answered, the Hub history is the only evidence, and when it does not settle the question the ledger says so instead of guessing.
 */
import { createHmac, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { ensureSecureDir, writeFileAtomic } from '../secure';

export type RequestState = 'received' | 'processing' | 'confirmed' | 'failed-before-send' | 'unknown' | 'reconciled';
export type Resolution = 'sent' | 'not-sent' | 'discarded';

export interface LedgerRecord {
	key: string;
	deviceId: string;
	sessionId: string;
	requestId: string;
	digest: string;
	state: RequestState;
	createdAt: number;
	updatedAt: number;
	attempts: number;
	/** How a record that was "unknown" got settled. */
	resolution?: Resolution;
	by?: 'history' | 'person';
	note?: string;
}

interface File { v: 1; salt: string; records: LedgerRecord[] }

export type Decision =
	| { kind: 'dispatch'; record: LedgerRecord }
	| { kind: 'duplicate'; record: LedgerRecord }
	| { kind: 'in-progress'; record: LedgerRecord }
	| { kind: 'unknown'; record: LedgerRecord }
	| { kind: 'conflict' }
	| { kind: 'blocked'; reason: string };

export class LedgerError extends Error { }

const TERMINAL: RequestState[] = ['confirmed', 'reconciled', 'failed-before-send'];
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export class RequestLedger {
	private readonly file: string;
	private readonly lockFile: string;
	private salt = '';
	private records = new Map<string, LedgerRecord>();
	private readonly inflight = new Set<string>();
	private blockedReason: string | undefined;
	private locked = false;
	private closed = false;
	private readonly now: () => number;
	private readonly retentionMs: number;
	private readonly maxRecords: number;

	constructor(private readonly directory: string, options: { now?: () => number; retentionMs?: number; maxRecords?: number } = {}) {
		this.file = join(directory, 'requests.json');
		this.lockFile = join(directory, 'requests.lock');
		this.now = options.now ?? Date.now;
		this.retentionMs = options.retentionMs ?? 48 * 3_600_000;
		this.maxRecords = options.maxRecords ?? 1000;
	}

	get blocked(): string | undefined { return this.blockedReason; }

	/** Takes the single-writer lock and loads the file. A damaged or unreadable file blocks sending instead of being silently replaced. */
	open(): void {
		this.closed = false;
		ensureSecureDir(this.directory);
		this.acquire();
		let text: string | undefined;
		try { text = fs.readFileSync(this.file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.blockedReason = 'O registro de envios não pôde ser lido.'; return; } }
		if (text === undefined) { this.salt = randomBytes(32).toString('hex'); this.persist(); return; }
		try {
			const parsed = JSON.parse(text) as Partial<File>;
			if (parsed.v !== 1 || typeof parsed.salt !== 'string' || parsed.salt.length < 32 || !Array.isArray(parsed.records)) { throw new Error('shape'); }
			this.salt = parsed.salt;
			for (const record of parsed.records) {
				if (!record || typeof record.key !== 'string' || typeof record.digest !== 'string' || typeof record.state !== 'string') { throw new Error('record'); }
				this.records.set(record.key, record);
			}
		} catch {
			this.blockedReason = 'O registro de envios está corrompido. Por segurança, nenhum envio remoto será feito até você revisar e reiniciar o registro na IDE.';
			return;
		}
		// whatever was being sent when the previous gateway stopped has an unknown outcome
		let changed = false;
		for (const record of this.records.values()) { if (record.state === 'received' || record.state === 'processing') { record.state = 'unknown'; record.updatedAt = this.now(); record.note = 'O gateway parou durante o envio.'; changed = true; } }
		this.sweep();
		if (changed) { this.persist(); }
	}

	private acquire(): void {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const fd = fs.openSync(this.lockFile, 'wx');
				fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: this.now() }));
				fs.closeSync(fd);
				this.locked = true;
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw new LedgerError('Não foi possível travar o registro de envios.'); }
				let owner: { pid?: number } | undefined;
				try { owner = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')) as { pid?: number }; } catch { /* damaged lock */ }
				if (owner?.pid && owner.pid !== process.pid && pidAlive(owner.pid)) { throw new LedgerError('Outro gateway está usando o registro de envios.'); }
				try { fs.rmSync(this.lockFile, { force: true }); } catch { /* retry */ }
			}
		}
		throw new LedgerError('Não foi possível travar o registro de envios.');
	}

	close(): void { this.closed = true; if (this.locked) { try { fs.rmSync(this.lockFile, { force: true }); } catch { /* ignore */ } this.locked = false; } }

	digest(sessionId: string, text: string): string { return createHmac('sha256', this.salt).update(sessionId).update('\n').update(text).digest('hex'); }

	private persist(): void {
		// a ledger that was closed belongs to a gateway that is gone: it never writes over what a newer one is doing
		if (this.closed) { throw new LedgerError('O registro de envios foi fechado.'); }
		try { writeFileAtomic(this.file, JSON.stringify({ v: 1, salt: this.salt, records: [...this.records.values()] } satisfies File)); } catch { throw new LedgerError('Não foi possível gravar o registro de envios.'); }
	}

	private sweep(): void {
		const limit = this.now() - this.retentionMs;
		for (const [key, record] of this.records) { if (TERMINAL.includes(record.state) && record.updatedAt < limit) { this.records.delete(key); } }
		while (this.records.size > this.maxRecords) {
			const oldest = [...this.records.values()].filter(record => TERMINAL.includes(record.state)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
			if (!oldest) { break; }
			this.records.delete(oldest.key);
		}
	}

	private set(record: LedgerRecord, state: RequestState, extra: Partial<LedgerRecord> = {}): LedgerRecord {
		Object.assign(record, extra, { state, updatedAt: this.now() });
		this.persist();
		return record;
	}

	/** Decides what to do with a send and, when it must be dispatched, persists "processing" first. */
	begin(deviceId: string, sessionId: string, requestId: string, text: string): Decision {
		if (this.blockedReason) { return { kind: 'blocked', reason: this.blockedReason }; }
		const key = `${deviceId}:${sessionId}:${requestId}`;
		const digest = this.digest(sessionId, text);
		const existing = this.records.get(key);
		if (existing) {
			if (existing.digest !== digest) { return { kind: 'conflict' }; }
			if (existing.state === 'confirmed' || existing.state === 'reconciled') { return { kind: 'duplicate', record: existing }; }
			if (this.inflight.has(key)) { return { kind: 'in-progress', record: existing }; }
			if (existing.state === 'unknown') { return { kind: 'unknown', record: existing }; }
			if (existing.state === 'received' || existing.state === 'processing') { this.set(existing, 'unknown', { note: 'O envio ficou sem resposta.' }); return { kind: 'unknown', record: existing }; }
			// failed before it was sent: the same operation may be tried again with the same id
			this.inflight.add(key);
			try { return { kind: 'dispatch', record: this.set(existing, 'processing', { attempts: existing.attempts + 1 }) }; } catch (error) { this.inflight.delete(key); throw error; }
		}
		this.sweep();
		const record: LedgerRecord = { key, deviceId, sessionId, requestId, digest, state: 'received', createdAt: this.now(), updatedAt: this.now(), attempts: 1 };
		this.records.set(key, record);
		this.inflight.add(key);
		try { this.persist(); this.set(record, 'processing'); } catch (error) { this.records.delete(key); this.inflight.delete(key); throw error; }
		return { kind: 'dispatch', record };
	}

	get(deviceId: string, sessionId: string, requestId: string): LedgerRecord | undefined { return this.records.get(`${deviceId}:${sessionId}:${requestId}`); }

	confirm(record: LedgerRecord): LedgerRecord { this.inflight.delete(record.key); return this.set(record, 'confirmed'); }
	failedBeforeSend(record: LedgerRecord, note: string): LedgerRecord { this.inflight.delete(record.key); return this.set(record, 'failed-before-send', { note }); }
	/** The connection was lost after the instruction may have reached the Hub: not failed, not confirmed. */
	unknown(record: LedgerRecord, note: string): LedgerRecord { this.inflight.delete(record.key); return this.set(record, 'unknown', { note }); }

	/** The Hub's own history showed the instruction: settled without sending anything. */
	reconciled(record: LedgerRecord): LedgerRecord { return this.set(record, 'reconciled', { resolution: 'sent', by: 'history' }); }

	/** The person decides an unknown request: it can be tried again with the same id, or dropped. */
	resolve(record: LedgerRecord, action: 'retry' | 'discard'): LedgerRecord {
		if (record.state !== 'unknown') { throw new LedgerError('Só um envio em estado desconhecido pode ser resolvido.'); }
		return action === 'retry' ? this.set(record, 'failed-before-send', { resolution: 'not-sent', by: 'person', note: 'Liberado pela pessoa para nova tentativa.' }) : this.set(record, 'reconciled', { resolution: 'discarded', by: 'person' });
	}

	counts(): Record<RequestState, number> & { blocked: boolean } {
		const counts = { received: 0, processing: 0, confirmed: 0, 'failed-before-send': 0, unknown: 0, reconciled: 0, blocked: !!this.blockedReason };
		for (const record of this.records.values()) { counts[record.state]++; }
		return counts;
	}

	/** Metadata of the settled-by-nobody requests, for the IDE. No text and no digest. */
	unresolved(): Array<{ sessionId: string; requestId: string; state: RequestState; createdAt: number; note?: string }> {
		return [...this.records.values()].filter(record => record.state === 'unknown').map(({ sessionId, requestId, state, createdAt, note }) => ({ sessionId, requestId, state, createdAt, ...(note ? { note } : {}) }));
	}

	/** Explicit restart of a blocked ledger: the damaged file is kept aside, never deleted. */
	reset(): void {
		if (fs.existsSync(this.file)) { try { fs.renameSync(this.file, `${this.file}.corrupt-${this.now()}`); } catch { throw new LedgerError('Não foi possível guardar o registro antigo.'); } }
		this.records = new Map();
		this.salt = randomBytes(32).toString('hex');
		this.blockedReason = undefined;
		this.persist();
	}
}
