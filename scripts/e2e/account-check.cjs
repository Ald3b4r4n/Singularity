'use strict';
// Real-input check of the GitHub account feature in the IDE (dev build), without network:
//   1. the status bar item is there and says how to sign in;
//   2. the account entry is available without starting a real OAuth flow;
//   3. the account commands are listed in the Command Palette.
//
//   node scripts/e2e/account-check.cjs --dev D:\dev\singularity [--out <dir>]

const fs = require('fs'), path = require('path');
const lib = require('./lib.cjs');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const dev = arg('dev', 'D:\\dev\\singularity');
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'account-out')));
fs.mkdirSync(outDir, { recursive: true });
const port = 9700 + Math.floor(Math.random() * 200);
const profile = lib.tempProfile('account');
const workspace = path.join(profile, 'ws');
fs.mkdirSync(workspace, { recursive: true });

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`); };

(async () => {
	let page;
	try {
		lib.launch({ dev, profile, workspace, port, env: { SINGULARITY_HUB_HOME: path.join(profile, 'hub') } });
		page = await lib.cdp(port);
		for (let i = 0; i < 180 && !(await page.evaluate('window.__singularityWorkbenchRestored === true')); i++) { await lib.sleep(500); }
		for (let i = 0; i < 40 && !(await page.evaluate("!document.getElementById('singularity-intro')")); i++) { await lib.sleep(500); }
		await lib.bringToFront(profile);
		await lib.sleep(2500);

		await lib.keys(profile, '{F1}'); await lib.sleep(600);
		lib.paste(profile, 'Sign In with GitHub'); await lib.sleep(900);
		const palette = await page.evaluate("document.querySelector('.quick-input-widget')?.innerText || ''");
		check('Command Palette lists "Sign In with GitHub"', /Sign In with GitHub/.test(palette));
		lib.keys(profile, '{ESC}'); await lib.sleep(500);

		const bar = await page.evaluate("[...document.querySelectorAll('.statusbar-item')].map(e => e.innerText).join(' | ')");
		check('status bar item shows the GitHub account entry', /GitHub/.test(bar), { statusBar: bar.slice(0, 200) });
		check('account discovery does not start an OAuth flow', !(await page.evaluate("!!document.querySelector('.modal-dialog, .notifications-toasts .notification-list-item')")));

		await page.screenshot(path.join(outDir, 'account-ready.png'));
	} catch (e) {
		check('check ran to completion', false, { error: e.message });
		try { if (page) { await page.screenshot(path.join(outDir, 'failure.png')); } } catch { /* ignore */ }
	} finally {
		try { if (page) { page.close(); } } catch { /* ignore */ }
		await lib.closeApp(profile);
		try { require('child_process').execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'singularity-hub', 'dist', 'cli.js'), 'stop'], { env: { ...process.env, SINGULARITY_HUB_HOME: path.join(profile, 'hub') }, stdio: 'ignore' }); } catch { /* no isolated Hub */ }
		fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ dev, results, ok: results.every(r => r.ok), finished: new Date().toISOString() }, null, 2));
		lib.rmrf(profile);
		const ok = results.length > 0 && results.every(r => r.ok);
		console.log(ok ? 'ACCOUNT CHECK PASSED' : 'ACCOUNT CHECK FAILED');
		process.exit(ok ? 0 : 1);
	}
})();
