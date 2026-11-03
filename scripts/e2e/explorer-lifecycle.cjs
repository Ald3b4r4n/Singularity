'use strict';
// Lifecycle outside the test harness: the packaged IDE is started the way a user starts it, through a shortcut opened
// by Windows Explorer, so the IDE's parent process is explorer.exe, not this script. Then:
//   open the Agents panel (real keyboard) -> Hub running -> close the window -> Hub still running ->
//   start again from the shortcut -> the same Hub instance answers -> explicit shutdown -> nothing left running.
//
//   node scripts/e2e/explorer-lifecycle.cjs --exe "D:\dev\VSCode-win32-x64\Singularity IDE.exe" [--out <dir>]
//
// The Hub uses the per-user state folder (%LOCALAPPDATA%\Singularity\Hub), because an Explorer-started process does not
// inherit this script's environment. The run refuses to start if a Hub is already running there, so a user's Hub is
// never touched; the Hub it creates is shut down at the end.

const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./lib.cjs');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const exe = arg('exe', '');
if (!exe) { console.error('usage: explorer-lifecycle.cjs --exe <path>'); process.exit(2); }
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'explorer-lifecycle-out')));
fs.mkdirSync(outDir, { recursive: true });

const profile = lib.tempProfile('explorer');
const workspace = path.join(profile, 'ws');
const port = 9500 + Math.floor(Math.random() * 300);
const hubHome = path.join(process.env.LOCALAPPDATA, 'Singularity', 'Hub');
const hubNode = path.join(path.dirname(exe), 'resources', 'app', 'singularity-hub', 'runtime', 'node.exe');
const hubCli = path.join(path.dirname(exe), 'resources', 'app', 'singularity-hub', 'dist', 'cli.js');
const hubStatus = () => { try { return JSON.parse(execFileSync(hubNode, [hubCli, 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch (e) { return JSON.parse(String(e.stdout || '{"running":false}')); } };
const log = (...a) => console.log(...a);
const steps = [];
const step = async (name, fn) => { try { const d = await fn(); steps.push({ name, ok: true, detail: d }); log('  ok   ' + name + (d ? '  ' + JSON.stringify(d) : '')); } catch (e) { steps.push({ name, ok: false, error: e.message }); log('  FAIL ' + name + ': ' + e.message); throw e; } };
const waitFor = async (fn, ms, every = 300) => { const end = Date.now() + ms; for (; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await lib.sleep(every); } };

function makeShortcut(lnk) {
	const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(profile, 'data')}`, `--extensions-dir=${path.join(profile, 'ext')}`, workspace].join(' ');
	const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}'); $s.TargetPath='${exe}'; $s.Arguments='${args}'; $s.WorkingDirectory='${path.dirname(exe)}'; $s.Save()`;
	lib.ps(ps);
}
// explorer.exe exits with a non-zero code even when it opens the shortcut, so the outcome is judged by the process, not by it
const startFromShortcut = lnk => { const c = require('child_process').spawn('explorer.exe', [lnk], { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref(); };

(async () => {
	log('Explorer lifecycle, packaged build:', exe);
	let page;
	let failed = null;
	try {
		await step('precondition: no Hub is running for this user', async () => {
			const st = hubStatus();
			if (st.running) { throw new Error('a Hub of this user is already running (pid ' + st.pid + '); refusing to touch it'); }
			return { running: false };
		});
		await step('temporary workspace and shortcut', async () => {
			fs.mkdirSync(workspace, { recursive: true });
			fs.writeFileSync(path.join(workspace, 'a.txt'), 'x\n');
			const lnk = path.join(profile, 'Singularity IDE (teste).lnk');
			makeShortcut(lnk);
			return { shortcut: lnk };
		});
		const lnk = path.join(profile, 'Singularity IDE (teste).lnk');
		await step('start from the shortcut through Explorer; the IDE parent is explorer.exe', async () => {
			startFromShortcut(lnk);
			page = await lib.cdp(port);
			await waitFor(() => page.evaluate('window.__singularityWorkbenchRestored === true'), 90000);
			const ids = lib.appProcesses(profile);
			const parent = lib.ps(`(Get-CimInstance Win32_Process -Filter 'ProcessId=${ids[0]}').ParentProcessId`);
			const parentName = lib.ps(`(Get-Process -Id ${parent} -ErrorAction SilentlyContinue).ProcessName`);
			if (parentName.toLowerCase() !== 'explorer') { throw new Error('parent is ' + parentName); }
			await lib.bringToFront(profile);
			return { pid: ids[0], parent: parentName };
		});
		await step('open the Agents panel with the keyboard; the Hub starts and connects', async () => {
			await lib.runCommand(profile, 'Singularity: Abrir painel de agentes', 8000);
			const st = await waitFor(() => { const s = hubStatus(); return s.running ? s : null; }, 30000);
			if (st.sessions !== 0) { throw new Error('expected 0 sessions: ' + JSON.stringify(st)); }
			const image = lib.ps(`(Get-Process -Id ${st.pid}).Path`);
			if (image.toLowerCase() !== hubNode.toLowerCase()) { throw new Error('Hub not on its bundled runtime: ' + image); }
			await page.screenshot(path.join(outDir, '01-hub-connected.png'));
			return { hubPid: st.pid, instanceId: st.instanceId, image };
		});
		var first;
		await step('close the window: the Hub keeps running', async () => {
			first = hubStatus();
			page.close();
			await lib.closeApp(profile);
			if (lib.appProcesses(profile).length) { throw new Error('IDE still running'); }
			await lib.sleep(1500);
			const st = hubStatus();
			if (!st.running || st.instanceId !== first.instanceId) { throw new Error('Hub did not survive: ' + JSON.stringify(st)); }
			return { hubAlive: true, pid: st.pid };
		});
		await step('start again from the shortcut: reconnects to the same Hub instance', async () => {
			startFromShortcut(lnk);
			page = await lib.cdp(port);
			await waitFor(() => page.evaluate('window.__singularityWorkbenchRestored === true'), 90000);
			await lib.bringToFront(profile);
			await lib.runCommand(profile, 'Singularity: Abrir painel de agentes', 8000);
			await lib.sleep(2000);
			const st = hubStatus();
			if (st.instanceId !== first.instanceId) { throw new Error('a different Hub instance answered: ' + st.instanceId); }
			await page.screenshot(path.join(outDir, '02-reconnected.png'));
			return { sameInstance: true };
		});
		await step('explicit shutdown from the IDE releases the Hub', async () => {
			await lib.runCommand(profile, 'Singularity: Encerrar o Hub', 3000);
			await waitFor(() => !hubStatus().running, 15000);
			const left = fs.readdirSync(hubHome).filter(n => ['connection.json', 'token', 'hub.token', 'lock', 'hub.lock'].includes(n));
			if (left.length) { throw new Error('state files left behind: ' + left.join(',')); }
			return { hubFilesLeft: left.length };
		});
		await step('close the IDE and leave nothing running', async () => {
			page.close();
			await lib.closeApp(profile);
			if (lib.appProcesses(profile).length) { throw new Error('IDE still running'); }
		});
	} catch (e) {
		failed = e.message;
		try { if (page) { await page.screenshot(path.join(outDir, 'failure.png')); } } catch { /* ignore */ }
	} finally {
		try { await lib.closeApp(profile); } catch { /* ignore */ }
		try { if (hubStatus().running) { execFileSync(hubNode, [hubCli, 'stop'], { stdio: 'ignore' }); } } catch { /* ignore */ }
		fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ exe, steps, ok: !failed, error: failed, finished: new Date().toISOString() }, null, 2));
		lib.rmrf(profile);
		log(failed ? 'EXPLORER LIFECYCLE FAILED: ' + failed : 'EXPLORER LIFECYCLE PASSED');
		process.exit(failed ? 1 : 0);
	}
})();
