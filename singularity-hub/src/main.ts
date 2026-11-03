// Entry point of the Hub process: `node dist/main.js`.
// Stays alive until hub.shutdown, a termination signal, or a fatal error. Closing IDE windows does not stop it.
import { startHub } from './instance';

async function main(): Promise<void> {
	let stopping = false;
	let release: (() => Promise<void>) | undefined;
	const stop = async (code: number): Promise<void> => {
		if (stopping) {
			return;
		}
		stopping = true;
		try {
			await release?.();
		} finally {
			process.exit(code);
		}
	};

	const result = await startHub({ onShutdownRequested: () => { void stop(0); } });
	if (result.kind === 'already-running') {
		// Another Hub of this user is healthy; this process is redundant.
		process.exit(0);
	}
	release = result.release;
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
		process.on(signal, () => { void stop(0); });
	}
	process.on('uncaughtException', () => { void stop(1); });
	process.on('unhandledRejection', () => { void stop(1); });
}

main().catch(() => process.exit(1));
