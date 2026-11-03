import * as fs from 'fs';

/**
 * Line log in the state directory. Callers pass short messages and scalar fields (method names, sizes,
 * close codes). Request params, headers and tokens must never be passed in: nothing here redacts, so the
 * rule is "do not log them".
 */
export class Logger {
	constructor(private readonly file: string | undefined, private readonly maxBytes = 1_000_000) { }

	log(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, string | number | boolean>): void {
		if (!this.file) {
			return;
		}
		const line = `${new Date().toISOString()} ${level} ${message}${fields ? ' ' + JSON.stringify(fields) : ''}\n`;
		try {
			if (fs.existsSync(this.file) && fs.statSync(this.file).size > this.maxBytes) {
				fs.renameSync(this.file, this.file + '.1');
			}
			fs.appendFileSync(this.file, line, { mode: 0o600 });
		} catch {
			// logging must never take the Hub down
		}
	}
}
