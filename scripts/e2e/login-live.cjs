'use strict';
// Live GitHub login of the official Singularity OAuth App, in the dev build, with a persistent profile.
// The owner approves each device code in the browser; this script never types credentials or tokens.
//   1. "Sign In with GitHub"  -> device code written to <out>/device-code-1.txt -> owner approves -> status bar shows the login
//   2. close and reopen the IDE -> the session is still there (no new login)
//   3. "Authorize GitHub Publishing" -> device code written to <out>/device-code-2.txt -> owner approves -> "Publicação autorizada ..."
//   4. "Remove GitHub Publishing Authorization" and "Sign Out of GitHub" -> both removed locally
//
//   node scripts/e2e/login-live.cjs --dev D:\dev\singularity --out <dir> --profile <persistent dir>

const fs = require('fs'), path = require('path');
const lib = require('./lib.cjs');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const dev = arg('dev', 'D:\\dev\\singularity');
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'login-out')));
const profile = path.resolve(arg('profile', path.join(outDir, 'profile')));
const workspace = path.join(outDir, 'ws');
fs.mkdirSync(outDir, { recursive: true }); fs.mkdirSync(workspace, { recursive: true });
const port = 9800 + Math.floor(Math.random() * 90);
const log = (...a) => { const line = new Date().toISOString() + ' ' + a.join(' '); console.log(line); fs.appendFileSync(path.join(outDir, 'progress.log'), line + '\n'); };
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`); };

// messages: toasts and modal dialogs (the device code is shown in a modal dialog, which does not hide by itself)
const notifications = page => page.evaluate("[...document.querySelectorAll('.notifications-toasts .notification-list-item, .notifications-list-container .notification-list-item, .monaco-dialog-box')].map(e => e.innerText).join(' | ')");
const statusText = page => page.evaluate("[...document.querySelectorAll('.statusbar-item')].map(e => e.innerText).join(' | ')");
const codeDialogOpen = page => page.evaluate("[...document.querySelectorAll('.monaco-dialog-box')].some(e => /Copiar código/.test(e.innerText))");

/** Polls the message area every second until the text matches, or the time runs out. */
async function waitText(page, re, ms) {
	const end = Date.now() + ms;
	for (; ;) {
		const t = await notifications(page).catch(() => '');
		if (re.test(t)) { return t; }
		if (Date.now() > end) { return undefined; }
		await lib.sleep(1000);
	}
}

/** Polls the status bar until the predicate holds (the account shows there, without depending on a message that hides itself). */
async function waitStatus(page, predicate, ms) {
	const end = Date.now() + ms;
	for (; ;) {
		const t = await statusText(page).catch(() => '');
		if (predicate(t)) { return t; }
		if (Date.now() > end) { return undefined; }
		await lib.sleep(1000);
	}
}

async function openApp() {
	lib.launch({ dev, profile, workspace, port, env: { SINGULARITY_HUB_HOME: path.join(outDir, 'hub') }, settings: { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none' } });
	const page = await lib.cdp(port);
	for (let i = 0; i < 180 && !(await page.evaluate('window.__singularityWorkbenchRestored === true')); i++) { await lib.sleep(500); }
	for (let i = 0; i < 40 && !(await page.evaluate("!document.getElementById('singularity-intro')")); i++) { await lib.sleep(500); }
	await lib.bringToFront(profile);
	await lib.sleep(3000);
	return page;
}

/**
 * The device flow starts only when the modal's "Copiar código e abrir GitHub" button is chosen. A DOM click is tried first; the
 * choice is accepted when the modal closes. If it stays open, a real mouse click is sent at the button's position.
 */
async function pressCopyAndOpen(page, profileDir) {
	const info = await page.evaluate("(() => { const b = [...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find(e => /Copiar código/.test(e.innerText)); if (!b) { return null; } b.click(); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: window.devicePixelRatio, ow: window.outerWidth, oh: window.outerHeight, iw: window.innerWidth, ih: window.innerHeight }; })()");
	if (!info) { log('copy-and-open button not found'); return false; }
	const closed = async ms => { const end = Date.now() + ms; while (Date.now() < end) { if (!(await codeDialogOpen(page))) { return true; } await lib.sleep(500); } return false; };
	if (await closed(4000)) { log('choice accepted (DOM click): the modal closed'); return true; }
	// real mouse click, relative to the window's top-left corner, in physical pixels (window frame and device scale taken into account)
	const border = (info.ow - info.iw) / 2;
	const x = Math.round((info.x + border) * info.dpr);
	const y = Math.round((info.y + (info.oh - info.ih) - border) * info.dpr);
	await lib.bringToFront(profileDir);
	lib.click(profileDir, x, y);
	const ok = await closed(10000);
	log(ok ? 'choice accepted (mouse click): the modal closed' : 'choice NOT accepted: the modal is still open');
	return ok;
}

/** Opens the Command Palette, types the title and checks the typed text before Enter (keys sent too early are lost). */
async function runPaletteCommand(page, title) {
	const inputValue = () => page.evaluate("(() => { const i = document.querySelector('.quick-input-widget input'); return i ? i.value : null; })()");
	for (let attempt = 0; attempt < 3; attempt++) {
		// keys go to the foreground window, which can be a secondary window of the same process: bring the main window first
		await lib.bringToFront(profile);
		lib.keys(profile, '{F1}');
		let open = false;
		for (let i = 0; i < 20 && !open; i++) { await lib.sleep(250); open = (await inputValue()) !== null; }
		if (!open) { continue; }
		await lib.bringToFront(profile);
		lib.paste(profile, title);
		for (let i = 0; i < 20; i++) {
			await lib.sleep(200);
			// the palette prefixes the text with ">" (e.g. "> Sign In with GitHub"); Enter is sent only once the filtered list
			// shows the command first, because Enter sent while the list is still updating does nothing
			const first = await page.evaluate("(() => { const e = document.querySelector('.quick-input-widget:not(.hidden) .quick-input-list-entry'); return e ? e.innerText : ''; })()");
			if (((await inputValue()) || '').includes(title) && first.includes(title)) {
				await lib.bringToFront(profile);
				lib.keys(profile, '{ENTER}');
				await lib.sleep(800);
				return;
			}
		}
		lib.keys(profile, '{ESC}');
		await lib.sleep(400);
	}
	throw new Error(`the Command Palette did not accept "${title}"`);
}

/** Runs a palette command with the keyboard. When `codeFile` is given, the device code shown in the modal is saved there (no token). */
async function run(page, title, codeFile) {
	await runPaletteCommand(page, title);
	if (!codeFile) { return undefined; }
	const shown = await waitText(page, /código/, 30000);
	const m = shown && /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(shown);
	if (!m) { return undefined; }
	fs.writeFileSync(codeFile, `${m[1]}\nAbra: https://github.com/login/device\n(válido por 15 minutos)\n`);
	log('device code saved to', codeFile);
	await pressCopyAndOpen(page, profile);
	return m[1];
}

(async () => {
	let page;
	try {
		page = await openApp();

		const code1 = await run(page, 'Sign In with GitHub', path.join(outDir, 'device-code-1.txt'));
		check('sign-in issued a device code from GitHub', !!code1, { code: code1 });
		const bar0 = await waitStatus(page, t => !/Entrar no GitHub/.test(t), 900000);
		check('the owner approved the device code and the status bar shows the account', !!bar0, { statusBar: (bar0 || await statusText(page)).slice(0, 160) });
		await page.screenshot(path.join(outDir, '01-conectado.png'));
		page.close();
		await lib.closeApp(profile);

		page = await openApp();
		await lib.sleep(4000);
		const bar2 = await statusText(page);
		check('after a restart the session is still there (no new login)', !/Entrar no GitHub/.test(bar2), { statusBar: bar2.slice(0, 160) });
		await page.screenshot(path.join(outDir, '02-depois-reinicio.png'));

		const code2 = await run(page, 'Authorize GitHub Publishing', path.join(outDir, 'device-code-2.txt'));
		check('publishing authorization issued a second device code', !!code2, { code: code2 });
		const authorized = await waitText(page, /Publicação autorizada|não foi concedida|outra conta|Não foi possível|não concluída/, 900000);
		check('publishing authorization granted (repo scope verified)', !!authorized && /Publicação autorizada/.test(authorized), { message: authorized ? authorized.slice(0, 160) : undefined });
		await page.screenshot(path.join(outDir, '03-publicacao-autorizada.png'));

		await run(page, 'Remove GitHub Publishing Authorization');
		await lib.sleep(2500);
		await page.screenshot(path.join(outDir, '04-autorizacao-removida.png'));
		await run(page, 'Sign Out of GitHub');
		const bar3 = await waitStatus(page, t => /Entrar no GitHub/.test(t), 20000);
		check('sign-out returns the status bar to "Entrar no GitHub"', !!bar3, { statusBar: (bar3 || await statusText(page)).slice(0, 160) });
		await page.screenshot(path.join(outDir, '05-desconectado.png'));
	} catch (e) {
		check('the live run completed', false, { error: e.message });
		try { if (page) { await page.screenshot(path.join(outDir, 'failure.png')); } } catch { /* ignore */ }
	} finally {
		try { if (page) { page.close(); } } catch { /* ignore */ }
		await lib.closeApp(profile);
		const ok = results.length > 0 && results.every(r => r.ok);
		fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ dev, results, ok, finished: new Date().toISOString() }, null, 2));
		log(ok ? 'LIVE LOGIN CHECK PASSED' : 'LIVE LOGIN CHECK FAILED');
		process.exit(ok ? 0 : 1);
	}
})();
