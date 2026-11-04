import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Session } from './protocol';
import { ensureSecureDir, readSecureFile, writeFileAtomic } from './secure';

export interface Turn {
	prompt: string;
	result?: string;
	status: Session['status'];
	at: number;
}

interface Record {
	version: 1;
	session: Session;
	turns: Turn[];
}

const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const maxTurns = 20;
const archiveRetention = 30 * 24 * 60 * 60 * 1000;

export class SessionHistory {
	private readonly records = new Map<string, Record>();

	/** One directory can hold the records of several agent services; each adapter only ever reads and lists its own. */
	constructor(private readonly directory: string, private readonly helper: string, private readonly harness = 'opencode') { }

	load(): void {
		if (!existsSync(this.directory)) { return; }
		for (const file of readdirSync(this.directory).filter(name => name.endsWith('.dpapi')).slice(0, 2000)) {
			const id = file.slice(0, -6);
			if (!idPattern.test(id)) { continue; }
			try {
				const input = Buffer.from(readSecureFile(join(this.directory, file)), 'base64');
				const decrypted = spawnSync(this.helper, ['unprotect-recovery'], { input, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
				if (decrypted.status !== 0) { continue; }
				try {
					const record: Record = JSON.parse(decrypted.stdout.toString('utf8'));
					if (record.version !== 1 || record.session?.id !== id || !Array.isArray(record.turns) || record.turns.length > maxTurns ||
						!Number.isFinite(record.session.updatedAt)) { continue; }
						if ((record.session.harness ?? 'opencode') !== this.harness) { continue; }
					if (record.session.historical && Date.now() - record.session.updatedAt! > archiveRetention) {
						rmSync(join(this.directory, file), { force: true });
					} else {
						this.records.set(id, record);
					}
				} finally { decrypted.stdout.fill(0); }
			} catch { /* A corrupt or unprotected record is never displayed. */ }
		}
	}

	list(): Session[] {
		return [...this.records.values()].map(({ session }) => ({ ...session, status: session.status === 'running' || session.status === 'waiting' ? 'failed' : session.status, historical: true }));
	}

	turns(id: string): Turn[] {
		return this.records.get(id)?.turns.map(turn => ({ ...turn })) ?? [];
	}

	save(session: Session, turn?: Turn, replaceLast = false): void {
		const previous = this.records.get(session.id);
		const turns = previous?.turns.slice() ?? [];
		if (turn) {
			if (replaceLast && turns.length) { turns.pop(); }
			turns.push(turn);
		}
		const { prompt, result, ...metadata } = session;
		const record: Record = { version: 1, session: metadata, turns: turns.slice(-maxTurns) };
		const input = Buffer.from(JSON.stringify(record));
		try {
			const encrypted = spawnSync(this.helper, ['protect-recovery'], { input, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
			if (encrypted.status !== 0 || !encrypted.stdout?.length) { throw new Error('Não foi possível proteger o histórico da sessão.'); }
			ensureSecureDir(this.directory);
			writeFileAtomic(join(this.directory, session.id + '.dpapi'), encrypted.stdout.toString('base64'));
			this.records.set(session.id, record);
		} finally { input.fill(0); }
	}

	delete(id: string): void {
		if (!this.records.has(id)) { return; }
		rmSync(join(this.directory, id + '.dpapi'), { force: true });
		this.records.delete(id);
	}
}
