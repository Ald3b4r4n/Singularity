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
	const gateway = new RemoteGateway({ directory: remoteDirectory(home), hubHome: home, webDir: join(__dirname, '..', '..', 'web') });
	await gateway.start();
	const stop = (): void => { void gateway.stop().finally(() => process.exit(0)); };
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
}

if (require.main === module) {
	main().catch(error => { console.error(String((error as Error).message)); process.exit(1); });
}
