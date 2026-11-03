'use strict';
// Real-input check of the update command in the dev build, against the official GitHub Releases API (anonymous):
// "Check for Singularity Updates" runs from the Command Palette and reports the result.
// There are no public releases yet, so the expected answer is "the most recent version of the channel".
//
//   node scripts/e2e/update-check.cjs --dev D:\dev\singularity [--out <dir>]

const fs = require('fs'), os = require('os'), path = require('path');
const lib = require('./lib.cjs');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const dev = arg('dev', 'D:\\dev\\singularity');
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'update-out')));
fs.mkdirSync(outDir, { recursive: true });
const port = 9990 + Math.floor(Math.random() * 8);
const profile = lib.tempProfile('update');
const workspace = path.join(profile, 'ws');
fs.mkdirSync(workspace, { recursive: true });
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`); };

(async () => {
	let page;
	try {
		lib.launch({ dev, profile, workspace, port, env: { SINGULARITY_HUB_HOME: path.join(profile, 'hub') } });
		page = await lib.cdp(port);
		for (let i = 0; i < 180 && !(await page.evaluate('window.__singularityWorkbenchRestored === true')); i++) { await lib.sleep(500); }
		for (let i = 0; i < 40 && !(await page.evaluate("!document.getElementById('singularity-intro')")); i++) { await lib.sleep(500); }
		await lib.bringToFront(profile);
		await lib.sleep(2000);
		await lib.runCommand(profile, 'Check for Singularity Updates', 300);
		const text = await (async () => {
			for (let i = 0; i < 40; i++) {
				const t = await page.evaluate("[...document.querySelectorAll('.notifications-toasts .notification-list-item, .notifications-list-container .notification-list-item')].map(e => e.innerText).join(' | ')");
				if (/mais recente|nao foi possível|não foi possível/i.test(t)) { return t; }
				await lib.sleep(500);
			}
			return '';
		})();
		check('the command reaches GitHub and reports the most recent version of the stable channel', /mais recente do canal stable/i.test(text), { message: text.slice(0, 200) });
		await page.screenshot(path.join(outDir, 'verificar-atualizacoes.png'));
	} catch (e) {
		check('check ran to completion', false, { error: e.message });
	} finally {
		try { if (page) { page.close(); } } catch { /* ignore */ }
		await lib.closeApp(profile);
		const ok = results.length > 0 && results.every(r => r.ok);
		fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ dev, results, ok, finished: new Date().toISOString() }, null, 2));
		lib.rmrf(profile);
		console.log(ok ? 'UPDATE CHECK PASSED' : 'UPDATE CHECK FAILED');
		process.exit(ok ? 0 : 1);
	}
})();
