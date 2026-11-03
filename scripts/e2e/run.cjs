'use strict';
// Real-user E2E of the Singularity IDE on Windows: real mouse and keyboard, isolated profile, temporary workspace.
//
//   node scripts/e2e/run.cjs --dev <repo>          run from source (needs `npm run compile-client`)
//   node scripts/e2e/run.cjs --exe <path-to-exe>   run a packaged build
//   options: --out <dir> (screenshots and report.json), --hub (also check the Singularity Hub), --keep (do not delete the temp profile)
//
// Every OS-level input goes through lib.guard(): if the foreground window is not this instance of the IDE, the run stops
// instead of typing into something else.

const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./lib.cjs');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const dev = arg('dev', ''), exe = arg('exe', ''), withHub = !!arg('hub', false), keep = !!arg('keep', false);
if (!dev && !exe) { console.error('usage: run.cjs --dev <repo> | --exe <path> [--out dir] [--hub] [--keep]'); process.exit(2); }
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'e2e-out')));
fs.mkdirSync(outDir, { recursive: true });

const profile = lib.tempProfile('e2e');
const workspace = path.join(profile, 'ws');
const hubHome = path.join(profile, 'hub', 'state');
const port = 9400 + Math.floor(Math.random() * 400);
const gitOut = path.join(profile, 'git-status.txt');
const report = { mode: dev ? 'dev' : 'packaged', started: new Date().toISOString(), steps: [] };
const hubCli = () => {
	const cli = path.join(dev || path.dirname(exe), dev ? 'singularity-hub' : 'resources\\app\\singularity-hub', 'dist', 'cli.js');
	try {
		return JSON.parse(execFileSync(process.env.SINGULARITY_E2E_NODE || 'node', [cli, 'status'], { env: { ...process.env, SINGULARITY_HUB_HOME: hubHome }, encoding: 'utf8' }));
	} catch (e) {
		// `status` exits with 1 and prints { running: false } when there is no Hub
		return JSON.parse(String(e.stdout || '{"running":false}'));
	}
};

async function step(name, fn) {
	const t0 = Date.now();
	try {
		const detail = await fn();
		report.steps.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? undefined });
		console.log(`  ok   ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`);
	} catch (e) {
		report.steps.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
		console.log(`  FAIL ${name}: ${e.message}`);
		throw e;
	}
}

const assert = (cond, msg) => { if (!cond) { throw new Error(msg); } };

/** Re-checks the foreground before a block of input; one attempt to take it back, then give up. */
async function front() {
	try { lib.guard(profile); } catch { await lib.bringToFront(profile); }
	lib.guard(profile);
}

async function waitFor(fn, ms = 20000, every = 300) {
	const end = Date.now() + ms;
	for (; ;) {
		const v = await fn();
		if (v) { return v; }
		if (Date.now() > end) { throw new Error('timed out'); }
		await lib.sleep(every);
	}
}

async function launchAndWait(files) {
	lib.launch({ exe: exe || undefined, dev: dev || undefined, profile, workspace, port, files, env: { SINGULARITY_HUB_HOME: hubHome } });
	const page = await lib.cdp(port);
	await waitFor(async () => page.evaluate('window.__singularityWorkbenchRestored === true'), 90000);
	await waitFor(async () => page.evaluate("!document.getElementById('singularity-intro')"), 20000);
	await lib.bringToFront(profile);
	return page;
}

(async () => {
	console.log(`Singularity E2E (${report.mode}), profile ${profile}`);
	console.log('Using the real Windows mouse and keyboard; every input is guarded by the foreground window.');
	let page;
	try {
		await step('temporary workspace with a git repository', async () => {
			fs.mkdirSync(workspace, { recursive: true });
			fs.writeFileSync(path.join(workspace, 'notes.txt'), 'primeira linha\n');
			const git = (...a) => execFileSync('git', a, { cwd: workspace, stdio: 'ignore' });
			git('init', '-q'); git('config', 'user.email', 'e2e@example.invalid'); git('config', 'user.name', 'e2e'); git('add', '-A'); git('commit', '-q', '-m', 'init');
			return { workspace };
		});

		await step('launch, opening plays and leaves, window comes to the front', async () => {
			page = await launchAndWait();
			const marks = Object.fromEntries(await page.marks());
			await page.screenshot(path.join(outDir, '01-started.png'));
			return { editorRestoredMs: marks['code/didRestoreEditors'], overlayEndMs: marks['singularity/introEnd'], title: (await lib.appWindows(profile))[0].title };
		});

		await step('open a file with Ctrl+P and type into it', async () => {
			await front();
			lib.keys(profile, '^p'); await lib.sleep(700); lib.paste(profile, 'notes.txt'); await lib.sleep(700); lib.keys(profile, '{ENTER}'); await lib.sleep(1500);
			assert(/notes\.txt/.test(await page.evaluate('document.title')), 'notes.txt is not the active editor');
			lib.keys(profile, '^{END}'); lib.paste(profile, 'linha digitada pelo E2E\n'); await lib.sleep(500); lib.keys(profile, '^s'); await lib.sleep(1200);
			const text = fs.readFileSync(path.join(workspace, 'notes.txt'), 'utf8');
			assert(text.includes('linha digitada pelo E2E'), 'typed text did not reach the file on disk');
			return { bytes: text.length };
		});

		await step('switch to Event Minimal Light and back to Dark', async () => {
			await front();
			const kind = () => page.evaluate("document.querySelector('.monaco-workbench')?.classList.contains('vs-dark') ? 'dark' : 'light'");
			const pick = async name => { lib.keys(profile, '^k'); await lib.sleep(400); lib.keys(profile, '^t'); await lib.sleep(1200); lib.paste(profile, name); await lib.sleep(700); lib.keys(profile, '{ENTER}'); await lib.sleep(1500); };
			assert(await kind() === 'dark', 'default theme is not dark');
			await pick('Event Minimal Light'); assert(await kind() === 'light', 'did not switch to light');
			await page.screenshot(path.join(outDir, '02-light.png'));
			await pick('Event Minimal Dark'); assert(await kind() === 'dark', 'did not switch back to dark');
			return { switched: true };
		});

		await step('terminal runs a command', async () => {
			await front();
			await lib.runCommand(profile, 'Terminal: Create New Terminal', 6000);
			lib.paste(profile, `git status --short | Out-File -Encoding ascii '${gitOut}'`);
			await lib.sleep(500); lib.keys(profile, '{ENTER}');
			await waitFor(() => fs.existsSync(gitOut), 15000);
			const out = fs.readFileSync(gitOut, 'utf8');
			assert(/notes\.txt/.test(out), `git status did not list notes.txt: ${out}`);
			return { gitStatus: out.trim() };
		});

		await step('Source Control view shows the change', async () => {
			await front();
			await lib.runCommand(profile, 'Source Control: Focus on Source Control View', 2500);
			const seen = await page.evaluate("(document.querySelector('.scm-view')?.innerText || '').includes('notes.txt')");
			assert(seen, 'notes.txt is not listed in the Source Control view');
			await page.screenshot(path.join(outDir, '03-git.png'));
		});

		await step('Command Palette lists Singularity commands', async () => {
			await front();
			lib.keys(profile, '{F1}'); await lib.sleep(600); lib.paste(profile, 'Singularity:'); await lib.sleep(900);
			const text = await page.evaluate("document.querySelector('.quick-input-widget')?.innerText || ''");
			lib.keys(profile, '{ESC}');
			assert(/Singularity/.test(text) && /agentes|Hub|Agents/i.test(text), 'Singularity commands not found in the palette');
		});

		await step('built-in extensions are present', async () => {
			await front();
			await lib.runCommand(profile, 'Extensions: Show Built-in Extensions', 1500);
			lib.paste(profile, 'singularity'); await lib.sleep(2500);
			const text = await page.evaluate("document.querySelector('.extensions-viewlet')?.innerText || document.body.innerText");
			assert(/Singularity Event Minimal Themes/.test(text) && /Singularity Agents/.test(text) && /Singularity Welcome/.test(text), 'one of the Singularity built-in extensions is missing');
			await page.screenshot(path.join(outDir, '04-extensions.png'));
		});

		await step('Singularity Agents panel opens', async () => {
			await front();
			await lib.runCommand(profile, 'Singularity: Abrir painel de agentes', 7000);
			const text = await page.evaluate("document.body.innerText");
			assert(/Singularity Agents/.test(text), 'Singularity Agents panel not visible');
			await page.screenshot(path.join(outDir, '05-agents.png'));
			if (withHub) { const st = hubCli(); assert(st.running && st.sessions === 0, 'Hub is not running with 0 sessions: ' + JSON.stringify(st)); return { hub: st }; }
		});

		let before;
		await step('close the window like a user', async () => {
			page.close();
			if (withHub) { before = hubCli(); }
			const r = await lib.closeApp(profile);
			assert(lib.appProcesses(profile).length === 0, 'IDE processes are still running');
			if (withHub) { assert(hubCli().running, 'Hub did not survive closing the IDE'); }
			return { forced: r.forced, hubAlive: withHub ? hubCli().running : undefined };
		});

		await step('reopen: workspace and the edited file are restored', async () => {
			page = await launchAndWait();
			const title = await page.evaluate('document.title');
			assert(/notes\.txt/.test(title), 'the edited file was not restored: ' + title);
			if (withHub) { const st = hubCli(); assert(st.instanceId === before.instanceId, 'reconnected to a different Hub instance'); return { sameHub: true, title }; }
			return { title };
		});

		if (withHub) {
			await step('explicit Hub shutdown releases its files', async () => {
				await front();
				await lib.runCommand(profile, 'Singularity: Encerrar o Hub', 3000);
				await waitFor(() => !fs.existsSync(path.join(hubHome, 'connection.json')), 10000);
				assert(!hubCli().running, 'Hub still running');
			});
		}

		await step('final close and cleanup', async () => {
			page.close();
			await lib.closeApp(profile);
			assert(lib.appProcesses(profile).length === 0, 'IDE processes left');
		});
		report.ok = true;
	} catch (e) {
		report.ok = false; report.error = e.message;
		try { if (page) { await page.screenshot(path.join(outDir, 'failure.png')); } } catch { /* ignore */ }
		try { await lib.closeApp(profile); } catch { /* ignore */ }
	} finally {
		report.finished = new Date().toISOString();
		fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
		if (!keep) { lib.rmrf(profile); }
		console.log(report.ok ? 'E2E PASSED' : 'E2E FAILED: ' + report.error);
		console.log('Windows input control released.');
		process.exit(report.ok ? 0 : 1);
	}
})();
