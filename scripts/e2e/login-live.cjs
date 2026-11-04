'use strict';
// Live GitHub login of the official Singularity OAuth App, driven through the real UI of the dev build (isolated persistent profile).
// The owner approves each device code in the browser; this script never types credentials and never reads or prints tokens.
//   1. "Sign In with GitHub" -> native modal -> device code saved -> Enter on the dialog -> owner approves -> status bar shows the login
//   2. close and reopen the IDE with the same profile -> the same login is shown (session persisted)
//   3. "Authorize GitHub Publishing" -> second code -> manage picker reports publishing as authorized
//   4. "Remove GitHub Publishing Authorization" -> picker reports not authorized; "Sign Out of GitHub" -> status bar back to sign-in
//   5. logs and the profile folder are scanned for token patterns; device-code files are deleted at the end
//
//   node scripts/e2e/login-live.cjs --out <dir> --login Ald3b4r4n [--dev <repo>] [--profile <dir>]

const fs = require('fs'), path = require('path');
const lib = require('./lib.cjs');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const dev = arg('dev', 'D:\\dev\\singularity');
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'login-out')));
const profile = path.resolve(arg('profile', path.join(outDir, 'profile')));
const expectedLogin = arg('login', 'Ald3b4r4n');
const workspace = path.join(outDir, 'ws');
fs.mkdirSync(outDir, { recursive: true }); fs.mkdirSync(workspace, { recursive: true });
const port = 9800 + Math.floor(Math.random() * 90);
const codeFiles = [];
const log = (...a) => { const line = new Date().toISOString() + ' ' + a.join(' '); console.log(line); fs.appendFileSync(path.join(outDir, 'progress.log'), line + '\n'); };
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`); };

const statusText = page => page.evaluate("[...document.querySelectorAll('.statusbar-item')].map(e => e.innerText.trim()).filter(Boolean).join(' | ')");
async function waitFor(fn, ms, every = 1000) { const end = Date.now() + ms; for (; ;) { const v = await fn().catch(() => undefined); if (v) { return v; } if (Date.now() > end) { return undefined; } await lib.sleep(every); } }

/** The native modal (#32770) of this instance, if any: { hwnd, text }. Read through UI Automation. */
function nativeDialog() {
	const ids = lib.appProcesses(profile);
	if (!ids.length) { return undefined; }
	// The dialog is a top-level #32770 window owned by the app, but UI Automation lists it under the main window, so it is found
	// with EnumWindows and its text is read through its handle.
	const out = lib.ps(`Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition 'using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices; public class DlgFind { public delegate bool CB(IntPtr h, IntPtr l); [DllImport("user32.dll")] static extern bool EnumWindows(CB cb, IntPtr l); [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n); public static long Find(uint[] pids) { long found = 0; var set = new HashSet<uint>(pids); EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); var c = new StringBuilder(64); GetClassName(h, c, 64); if (set.Contains(p) && IsWindowVisible(h) && c.ToString() == "#32770") { found = h.ToInt64(); } return true; }, IntPtr.Zero); return found; } }'
$h=[DlgFind]::Find([uint32[]]@(${ids.join(',')}))
if($h -ne 0){ $e=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$h); $t=($e.FindAll('Descendants',[System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Text' } | ForEach-Object { $_.Current.Name }) -join ' '; [pscustomobject]@{hwnd=[int64]$h;text=$t} | ConvertTo-Json -Compress }`);
	return out ? JSON.parse(out) : undefined;
}

async function openApp() {
	lib.launch({ dev, profile, workspace, port, env: { SINGULARITY_HUB_HOME: path.join(outDir, 'hub') }, settings: { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none' } });
	const page = await lib.cdp(port);
	for (let i = 0; i < 180 && !(await page.evaluate('window.__singularityWorkbenchRestored === true')); i++) { await lib.sleep(500); }
	for (let i = 0; i < 40 && !(await page.evaluate("!document.getElementById('singularity-intro')")); i++) { await lib.sleep(500); }
	await lib.bringToFront(profile);
	await lib.sleep(6000);
	return page;
}

/** Command Palette with the real keyboard. Enter is sent only when the filtered list shows the command first. */
async function palette(page, title) {
	const state = () => page.evaluate("JSON.stringify({ v: (document.querySelector('.quick-input-widget:not(.hidden) input') || {}).value, f: (document.querySelector('.quick-input-widget:not(.hidden) .quick-input-list-entry') || {}).innerText })").then(JSON.parse);
	for (let attempt = 0; attempt < 3; attempt++) {
		await lib.bringToFront(profile); // the browser opened for the approval may be in front; input is sent only to this instance
		lib.keys(profile, '{F1}');
		await lib.sleep(800);
		lib.paste(profile, title);
		for (let i = 0; i < 20; i++) {
			await lib.sleep(250);
			const s = await state();
			if ((s.v || '').includes(title) && (s.f || '').includes(title)) { lib.keys(profile, '{ENTER}'); await lib.sleep(800); return; }
		}
		lib.keys(profile, '{ESC}'); await lib.sleep(500);
	}
	throw new Error(`the Command Palette did not accept "${title}"`);
}

/** Waits for the device-code modal, saves the code, and accepts it with Enter (the default button is "Copiar código e abrir GitHub"). */
async function acceptDeviceCode(label) {
	const dlg = await waitFor(async () => { const d = nativeDialog(); return d && /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/.test(d.text) ? d : undefined; }, 30000, 500);
	if (!dlg) { return undefined; }
	const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(dlg.text)[1];
	const file = path.join(outDir, `device-code-${label}.txt`);
	fs.writeFileSync(file, `${code}\nAbra: https://github.com/login/device\n(válido por 15 minutos)\n`);
	codeFiles.push(file);
	log('device code saved to', file);
	const fg = lib.foreground();
	if (fg.hwnd !== dlg.hwnd) { throw new Error('the device-code dialog is not in the foreground; no input sent'); }
	lib.ps("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')");
	// accepted = the dialog that carried this code is gone (any other native window is not this prompt)
	const closed = await waitFor(async () => { const d = nativeDialog(); return !d || !d.text.includes(code); }, 10000, 500);
	log(closed ? 'modal accepted: the dialog closed' : 'modal still open after Enter');
	return closed ? code : undefined;
}

/** Opens the manage picker through the status bar item and returns its entries, then closes it. */
async function managePicker(page) {
	await lib.bringToFront(profile);
	await page.evaluate("(() => { const e = [...document.querySelectorAll('.statusbar-item')].find(x => /GitHub|Ald3b4r4n/.test(x.innerText) && x.querySelector('a')); if (e) { e.querySelector('a').click(); } })()");
	await lib.sleep(1500);
	const entries = await page.evaluate("[...document.querySelectorAll('.quick-input-widget:not(.hidden) .quick-input-list-entry')].map(e => e.innerText.replace(/\\s+/g, ' ').trim())");
	lib.keys(profile, '{ESC}');
	await lib.sleep(500);
	return entries;
}

const isSignedIn = t => t.includes(expectedLogin);

(async () => {
	let page;
	try {
		page = await openApp();
		let bar = await statusText(page);
		if (!isSignedIn(bar)) {
			await palette(page, 'Sign In with GitHub');
			const code1 = await acceptDeviceCode('1');
			check('sign-in: device code issued and accepted in the native modal', !!code1);
			bar = await waitFor(async () => { const t = await statusText(page); return isSignedIn(t) ? t : undefined; }, 900000, 2000);
			check(`sign-in: the status bar shows the account ${expectedLogin}`, !!bar, { statusBar: (bar || await statusText(page)).slice(0, 120) });
		} else {
			check(`sign-in: session already present for ${expectedLogin}`, true);
		}
		await page.screenshot(path.join(outDir, '01-conectado.png'));
		const entries1 = await managePicker(page);
		check('manage picker shows the account as connected', entries1.some(e => e.includes(expectedLogin) && /Conectada/.test(e)), { entries: entries1 });
		const avatar = lib.ps(`Get-ChildItem -Path '${profile}' -Recurse -Filter 'avatar-*.png' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Length`);
		check('the avatar was cached on disk', Number(avatar) > 0, { bytes: avatar });
		page.close();
		await lib.closeApp(profile);

		page = await openApp();
		await lib.sleep(3000);
		bar = await statusText(page);
		check(`persistence: after restart the status bar shows ${expectedLogin} without a new login`, isSignedIn(bar), { statusBar: bar.slice(0, 120) });
		check('persistence: no authorization dialog appeared on startup', !nativeDialog());
		await page.screenshot(path.join(outDir, '02-depois-reinicio.png'));

		await palette(page, 'Authorize GitHub Publishing');
		const code2 = await acceptDeviceCode('2');
		check('publishing: second device code issued and accepted', !!code2);
		const authorized = await waitFor(async () => { const e = await managePicker(page); return e.some(x => /Publicação: autorizada/.test(x)) ? e : undefined; }, 900000, 4000);
		check('publishing: the picker reports publishing as authorized (repo verified by the extension)', !!authorized, { entries: authorized });
		await page.screenshot(path.join(outDir, '03-publicacao-autorizada.png'));

		await palette(page, 'Remove GitHub Publishing Authorization');
		await lib.sleep(2500);
		const entries3 = await managePicker(page);
		check('publishing: removal returns the picker to "não autorizada"', entries3.some(x => /Publicação: não autorizada/.test(x)), { entries: entries3 });

		await palette(page, 'Sign Out of GitHub');
		bar = await waitFor(async () => { const t = await statusText(page); return /Entrar no GitHub/.test(t) ? t : undefined; }, 20000);
		check('sign-out: the status bar returns to "Entrar no GitHub"', !!bar, { statusBar: (bar || await statusText(page)).slice(0, 120) });
		await page.screenshot(path.join(outDir, '04-desconectado.png'));
	} catch (e) {
		check('the live run completed', false, { error: e.message });
		try { if (page) { await page.screenshot(path.join(outDir, 'failure.png')); } } catch { /* ignore */ }
	} finally {
		try { if (page) { page.close(); } } catch { /* ignore */ }
		await lib.closeApp(profile);
		// no token may be left in logs or state files
		const hits = lib.ps(`(Get-ChildItem -Path '${profile}' -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Length -lt 20MB } | Select-String -Pattern 'gh[opusr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}' -List -ErrorAction SilentlyContinue | Measure-Object).Count`);
		check('no GitHub token pattern in the profile (logs and state)', Number(hits) === 0, { files: hits });
		for (const f of codeFiles) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
		const ok = results.length > 0 && results.every(r => r.ok);
		fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ dev, expectedLogin, results, ok, finished: new Date().toISOString() }, null, 2));
		log(ok ? 'LIVE LOGIN CHECK PASSED' : 'LIVE LOGIN CHECK FAILED');
		process.exit(ok ? 0 : 1);
	}
})();
