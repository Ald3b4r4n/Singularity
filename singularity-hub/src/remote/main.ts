import { join } from 'node:path';
import { hubHome } from '../paths';
import { remoteDirectory } from './control';
import { RemoteGateway } from './gateway';

/**
 * Entry point of the remote gateway process. It is started only by an explicit user action in the IDE (never at login), listens on
 * loopback only and exits when asked to or when its parent asks it to stop.
 */

async function main(): Promise<void> {
	const home = hubHome();
	// Fixed ports are for tests that must keep the same browser origin across a gateway restart; both are loopback-only like the defaults.
	const port = (name: string): number | undefined => { const value = Number(process.env[name]); return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : undefined; };
	const gateway = new RemoteGateway({ directory: remoteDirectory(home), hubHome: home, webDir: join(__dirname, '..', '..', 'web'), publicPort: port('SINGULARITY_REMOTE_PUBLIC_PORT'), adminPort: port('SINGULARITY_REMOTE_ADMIN_PORT') });
	await gateway.start();
	const stop = (): void => { void gateway.stop().finally(() => process.exit(0)); };
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
}

if (require.main === module) {
	main().catch(error => { console.error(String((error as Error).message)); process.exit(1); });
}
