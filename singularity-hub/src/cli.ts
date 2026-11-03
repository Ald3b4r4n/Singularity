// Manual control of the Hub: node dist/cli.js status | start | stop
import { HubConnection } from './client';
import { discover } from './discovery';
import { findNode, spawnHub } from './launch';
import { hubHome } from './paths';

async function main(): Promise<number> {
	const command = process.argv[2];
	const home = hubHome();
	if (command === 'status') {
		try {
			const c = await HubConnection.connect({ home, clientName: 'singularity-cli' });
			const sessions = await c.request<unknown[]>('sessions.list');
			console.log(JSON.stringify({ running: true, pid: c.hello.hub.pid, port: c.info.port, instanceId: c.hello.hub.instanceId, sessions: sessions.length }));
			c.close();
			return 0;
		} catch (e) {
			console.log(JSON.stringify({ running: false, reason: (e as Error).message }));
			return 1;
		}
	}
	if (command === 'stop') {
		try {
			const c = await HubConnection.connect({ home, clientName: 'singularity-cli' });
			await c.request('hub.shutdown', {});
			console.log('stopping');
			return 0;
		} catch (e) {
			console.log('not running: ' + (e as Error).message);
			return 1;
		}
	}
	if (command === 'start') {
		const node = findNode();
		if (!node) {
			console.log('node not found');
			return 1;
		}
		spawnHub(node);
		for (let i = 0; i < 40; i++) {
			await new Promise(r => setTimeout(r, 250));
			try { const d = await discover(home); console.log(JSON.stringify({ running: true, pid: d.info.pid, port: d.info.port })); return 0; } catch { /* keep waiting */ }
		}
		console.log('did not start');
		return 1;
	}
	console.log('usage: node dist/cli.js status | start | stop');
	return 2;
}

main().then(code => process.exit(code));
