'use strict';
// End-to-end check of the publishing modes in the IDE (dev build), against a local bare remote:
//   1. a commit made outside the editor (plain git, like an agent) in ASSISTED mode asks before pushing; "Publicar" pushes it;
//   2. the same repository listed as AUTOMATIC pushes the next external commit without asking;
//   3. a divergence made on the remote is reported, and nothing is pushed or forced.
//
//   node scripts/e2e/publish-check.cjs --dev D:\dev\singularity [--out <dir>]
//
// Uses only temporary folders and a local remote (no GitHub, no token). The decisions are checked in the extension's
// own log, and the "Publicar" button is clicked in the page.

const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./lib.cjs');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const dev = arg('dev', 'D:\\dev\\singularity');
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'publish-out')));
fs.mkdirSync(outDir, { recursive: true });
const port = 9900 + Math.floor(Math.random() * 90);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pubcheck-'));
const remote = path.join(base, 'remote.git');
const ws = path.join(base, 'ws');
const other = path.join(base, 'other');
const profile = lib.tempProfile('publish');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`); };
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
const commit = (cwd, file, text) => { fs.writeFileSync(path.join(cwd, file), text); sh(cwd, 'add', '-A'); sh(cwd, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '-m', 'external ' + file); return sh(cwd, 'rev-parse', 'HEAD'); };
const remoteHead = () => sh(remote, 'rev-parse', 'main');
const settingsFile = () => path.join(profile, 'data', 'User', 'settings.json');
const writeSettings = automatic => fs.writeFileSync(settingsFile(), JSON.stringify({
	'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none',
	'singularity.publish.defaultMode': 'assisted', 'singularity.publish.automaticRepositories': automatic,
}, null, 2));

async function waitFor(fn, ms, every = 400) { const end = Date.now() + ms; for (; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) return undefined; await lib.sleep(every); } }

(async () => {
	let page;
	try {
		sh(base, 'init', '-q', '--bare', '-b', 'main', remote);
		sh(base, 'init', '-q', '-b', 'main', ws);
		sh(ws, 'remote', 'add', 'origin', remote);
		commit(ws, 'a.txt', 'one\n');
		sh(ws, 'push', '-q', '-u', 'origin', 'main');
		const first = remoteHead();

		fs.mkdirSync(path.join(profile, 'data', 'User'), { recursive: true });
		writeSettings([]);

		lib.launch({ dev, profile, workspace: ws, port, env: { SINGULARITY_HUB_HOME: path.join(profile, 'hub') } });
		page = await lib.cdp(port);
		await waitFor(() => page.evaluate('window.__singularityWorkbenchRestored === true'), 150000, 500);
		await waitFor(() => page.evaluate("!document.getElementById('singularity-intro')"), 30000, 500);
		await lib.bringToFront(profile);
		await lib.sleep(4000); // the extension activates after startup and reads the repository

		// 1. assisted: external commit -> question -> "Publicar" -> pushed
		const c1 = commit(ws, 'b.txt', 'two, made outside the editor\n');
		const asked = await waitFor(() => page.evaluate("[...document.querySelectorAll('.notifications-toasts .notification-list-item')].some(e => /prontos para publicar/.test(e.innerText))"), 20000);
		check('assisted: a commit made outside the editor asks before pushing', asked);
		await page.screenshot(path.join(outDir, '01-asked.png'));
		await page.evaluate("(() => { const b = [...document.querySelectorAll('.notifications-toasts .monaco-button')].find(e => e.innerText.trim() === 'Publicar'); if (b) b.click(); return !!b; })()");
		const pushed1 = await waitFor(() => remoteHead() === c1, 30000, 500);
		check('assisted: "Publicar" pushes exactly that commit', !!pushed1, { remoteHead: remoteHead().slice(0, 7), local: c1.slice(0, 7) });

		// 2. automatic for this repository, changed through the settings file the IDE watches
		writeSettings([ws]);
		await lib.sleep(3000);
		const c2 = commit(ws, 'c.txt', 'three, automatic\n');
		const pushed2 = await waitFor(() => remoteHead() === c2, 30000, 500);
		check('automatic: the next external commit is pushed without asking', !!pushed2, { remoteHead: remoteHead().slice(0, 7) });

		// 3. divergence: the remote gets a commit we do not have -> reported, nothing forced
		sh(base, 'clone', '-q', remote, other);
		const theirs = commit(other, 'theirs.txt', 'from the remote side\n');
		sh(other, 'push', '-q', 'origin', 'main');
		const mine = commit(ws, 'mine.txt', 'local, diverged\n');
		const warned = await waitFor(() => page.evaluate("[...document.querySelectorAll('.notifications-toasts .notification-list-item')].some(e => /tem commits que você não tem localmente/.test(e.innerText))"), 30000, 500);
		check('divergence: reported to the user', warned);
		await lib.sleep(2000);
		check('divergence: the remote is not overwritten and nothing is forced', remoteHead() === theirs && remoteHead() !== mine, { remoteHead: remoteHead().slice(0, 7), theirs: theirs.slice(0, 7), mine: mine.slice(0, 7) });
		const isAncestor = (() => { try { execFileSync('git', ['merge-base', '--is-ancestor', first, 'main'], { cwd: remote, stdio: 'ignore' }); return true; } catch { return false; } })();
		check('the history before the divergence is preserved on the remote', isAncestor);
		await page.screenshot(path.join(outDir, '02-diverged.png'));
	} catch (e) {
		check('check ran to completion', false, { error: e.message });
		try { if (page) { await page.screenshot(path.join(outDir, 'failure.png')); } } catch { /* ignore */ }
	} finally {
		try { if (page) { page.close(); } } catch { /* ignore */ }
		await lib.closeApp(profile);
		// the extension writes every decision to its own log: the automatic push must be visible there
		const logs = path.join(profile, 'data', 'logs');
		const logFiles = [];
		const walk = d => { if (!fs.existsSync(d)) { return; } for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { walk(f); } else if (e.name === 'Singularity Account.log') { logFiles.push(f); } } };
		walk(logs);
		const logText = logFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');
		check('automatic: the decision is in the extension log (mode=automatic, push)', /mode=automatic [^\n]*-> push \(ahead\)/.test(logText), { decisions: (logText.match(/-> \w+ \(/g) || []).length });
		if (fs.existsSync(logs)) { fs.cpSync(logs, path.join(outDir, 'logs'), { recursive: true }); }
		const ok = results.length > 0 && results.every(r => r.ok);
		fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ dev, results, ok, finished: new Date().toISOString() }, null, 2));
		lib.rmrf(profile); fs.rmSync(base, { recursive: true, force: true });
		console.log(ok ? 'PUBLISH CHECK PASSED' : 'PUBLISH CHECK FAILED');
		process.exit(ok ? 0 : 1);
	}
})();
