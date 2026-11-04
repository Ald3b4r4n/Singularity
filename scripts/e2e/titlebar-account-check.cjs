'use strict';
// E2E of the GitHub account entry in the title bar, through the real UI of the IDE (isolated profile, real keyboard and mouse).
// The owner approves the device code in the browser; this script never types credentials and never reads or prints tokens.
//   A. signed out: the title bar offers "Entrar com GitHub" (and not the Copilot "Sign In"); a real click starts the device flow
//   B. signed in: the same place shows avatar + login; a click opens the account menu with the publishing state
//   C. restart: the entry shows the same account at once, with no new login
//   D. sign out from the title bar menu: back to "Entrar com GitHub", nothing left behind
//   V. visual states: Dark, Light, high contrast, narrow window, enlarged interface
//
//   node scripts/e2e/titlebar-account-check.cjs --out <dir> [--dev <repo> | --exe <packaged exe>] [--login Ald3b4r4n]

const fs = require('fs'), path = require('path');
const lib = require('./lib.cjs');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const exe = arg('exe');
const dev = exe ? undefined : arg('dev', 'D:\\dev\\singularity');
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'titlebar-out')));
const profile = path.resolve(arg('profile', path.join(outDir, 'profile')));
const expectedLogin = arg('login', 'Ald3b4r4n');
const workspace = path.join(outDir, 'ws');
fs.mkdirSync(workspace, { recursive: true });
const port = 9700 + Math.floor(Math.random() * 90);
const codeFiles = [];
const log = (...a) => { const l = new Date().toISOString() + ' ' + a.join(' '); console.log(l); fs.appendFileSync(path.join(outDir, 'progress.log'), l + '\n'); };
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
const sleep = lib.sleep;

async function waitFor(fn, ms, every = 700) { const end = Date.now() + ms; for (; ;) { const v = await fn().catch(() => undefined); if (v) { return v; } if (Date.now() > end) { return undefined; } await sleep(every); } }
async function retry(fn) { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 3 || /guard:/.test(e.message)) { throw e; } await sleep(1000); } } }

// bringToFront taps ALT, which focuses the VS Code menu bar and swallows the next keys: use it only when the window is not in front
async function front() {
	const w = (await retry(() => lib.appWindows(profile)))[0];
	if (w && (await retry(() => lib.foreground())).hwnd === w.hwnd) { return; }
	await retry(() => lib.bringToFront(profile));
	await sleep(300);
	await retry(() => lib.keys(profile, '{ESC}'));
	await sleep(300);
}
async function key(keys, wait = 600) { await front(); await retry(() => lib.keys(profile, keys)); await sleep(wait); }
async function paste(text, wait = 400) { await front(); await retry(() => lib.paste(profile, text)); await sleep(wait); }

async function openApp(settings) {
	lib.launch({ exe, dev, profile, workspace, port, env: { SINGULARITY_HUB_HOME: path.join(outDir, 'hub') }, settings: { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'workbench.colorTheme': 'Event Minimal Dark', ...(settings || {}) } });
	const page = await lib.cdp(port);
	for (let i = 0; i < 180 && !(await page.evaluate('window.__singularityWorkbenchRestored === true')); i++) { await sleep(500); }
	for (let i = 0; i < 40 && !(await page.evaluate("!document.getElementById('singularity-intro')")); i++) { await sleep(500); }
	await lib.bringToFront(profile);
	// Windows remembers the last window bounds, so every run starts from the same normal size
	const hwnd0 = lib.appWindows(profile)[0].hwnd;
	lib.ps(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class RS0 { [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c); }'; [void][RS0]::ShowWindow([IntPtr]${hwnd0},9); [void][RS0]::MoveWindow([IntPtr]${hwnd0},40,40,1300,820,$true)`);
	await sleep(7000);
	return page;
}

function setSetting(k, v) {
	const f = path.join(profile, 'data', 'User', 'settings.json');
	const s = JSON.parse(fs.readFileSync(f, 'utf8'));
	if (v === undefined) { delete s[k]; } else { s[k] = v; }
	fs.writeFileSync(f, JSON.stringify(s, null, 2));
}

function shot(file) {
	const w = lib.appWindows(profile)[0];
	lib.ps(`Add-Type -AssemblyName System.Drawing; $r=New-Object SG.W+RECT; [void][SG.W]::GetWindowRect([IntPtr]${w.hwnd},[ref]$r); $b=New-Object System.Drawing.Bitmap ($r.R-$r.L),($r.B-$r.T); $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($r.L,$r.T,0,0,$b.Size); $b.Save('${file}')`);
}
const snap = async name => { await front(); await sleep(500); shot(path.join(outDir, name)); log('screenshot', name); };

/** Real mouse click at the centre of the first element matching `selector`. */
async function mouseClick(page, selector) {
	const g = await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: window.devicePixelRatio, ow: window.outerWidth, oh: window.outerHeight, iw: window.innerWidth, ih: window.innerHeight }; })()`);
	if (!g) { throw new Error('element not found: ' + selector); }
	const border = (g.ow - g.iw) / 2;
	await front();
	await retry(() => lib.click(profile, Math.round((g.x + border) * g.dpr), Math.round((g.y + (g.oh - g.ih) - border) * g.dpr)));
	await sleep(900);
}

/** The native modal (#32770) of this instance, if any: { hwnd, text } (EnumWindows + UI Automation). */
function nativeDialog() {
	const ids = lib.appProcesses(profile);
	if (!ids.length) { return undefined; }
	const out = lib.ps(`Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition 'using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices; public class DlgFind { public delegate bool CB(IntPtr h, IntPtr l); [DllImport("user32.dll")] static extern bool EnumWindows(CB cb, IntPtr l); [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n); public static long Find(uint[] pids) { long found = 0; var set = new HashSet<uint>(pids); EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); var c = new StringBuilder(64); GetClassName(h, c, 64); if (set.Contains(p) && IsWindowVisible(h) && c.ToString() == "#32770") { found = h.ToInt64(); } return true; }, IntPtr.Zero); return found; } }'
$h=[DlgFind]::Find([uint32[]]@(${ids.join(',')}))
if($h -ne 0){ $e=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$h); $t=($e.FindAll('Descendants',[System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Text' } | ForEach-Object { $_.Current.Name }) -join ' '; [pscustomobject]@{hwnd=[int64]$h;text=$t} | ConvertTo-Json -Compress }`);
	return out ? JSON.parse(out) : undefined;
}

/** Waits for the device-code modal, saves the code for the owner, and accepts it with Enter (default button). */
async function acceptDeviceCode(label) {
	const dlg = await waitFor(async () => { const d = nativeDialog(); return d && /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/.test(d.text) ? d : undefined; }, 30000, 500);
	if (!dlg) { return undefined; }
	const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(dlg.text)[1];
	const file = path.join(outDir, `device-code-${label}.txt`);
	fs.writeFileSync(file, `${code}\nAbra: https://github.com/login/device\n(válido por 15 minutos)\n`);
	codeFiles.push(file);
	log('device code saved to', file);
	if ((await retry(() => lib.foreground())).hwnd !== dlg.hwnd) { throw new Error('the device-code dialog is not in the foreground; no input sent'); }
	lib.ps("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')");
	const closed = await waitFor(async () => { const d = nativeDialog(); return !d || !d.text.includes(code); }, 10000, 500);
	log(closed ? 'modal accepted: the dialog closed' : 'modal still open after Enter');
	return closed ? code : undefined;
}

const ENTRY = '.singularity-account-entry';
const entryState = page => page.evaluate(`(() => { const e = document.querySelector('${ENTRY}'); if (!e) return null; const r = e.getBoundingClientRect(); const img = e.querySelector('img.avatar'); return { mode: e.classList.contains('signed-in') ? 'signed-in' : 'signed-out', text: e.innerText.trim(), visible: r.width > 0 && r.height > 0, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], avatarLoaded: !!img && img.complete && img.naturalWidth > 0, tooltip: (e.closest('.action-item') || e).title || '' }; })()`);
const statusText = page => page.evaluate("[...document.querySelectorAll('.statusbar-item')].map(e => e.innerText.trim()).filter(Boolean).join(' | ')");
const copilotSignIn = page => page.evaluate("[...document.querySelectorAll('.titlebar-container [aria-label]')].some(e => e.getAttribute('aria-label') === 'Sign In')");
const pickerEntries = page => page.evaluate("[...document.querySelectorAll('.quick-input-widget:not(.hidden) .quick-input-list-entry')].map(e => e.innerText.replace(/\\s+/g, ' ').trim())");

(async () => {
	let page;
	try {
		page = await openApp();

		// A. signed out
		let st = await waitFor(async () => (await entryState(page)), 20000);
		const alreadySignedIn = !!st && st.mode === 'signed-in';
		if (alreadySignedIn) { log('session already present: scenario A (signed out) was run before in this profile'); }
		else {
		check('A1. the title bar offers "Entrar com GitHub" when signed out', !!st && st.mode === 'signed-out' && /Entrar com GitHub/.test(st.text) && st.visible, st);
		check('A2. the Copilot "Sign In" button is gone from the title bar', !(await copilotSignIn(page)));
		await snap('01-desconectado-dark.png');
		await mouseClick(page, ENTRY);
		const code1 = await acceptDeviceCode('1');
		check('A3. a real click on the title bar entry starts the GitHub device flow (not Copilot)', !!code1);
		const chatSetupOpen = await page.evaluate("!!document.querySelector('.chat-setup-dialog, .chat-setup-view, [class*=\"chat-setup\"]')");
		check('A4. no Copilot setup was opened', !chatSetupOpen);
		}

		// B. signed in (the owner approves the code in the browser)
		st = await waitFor(async () => { const s = await entryState(page); return s && s.mode === 'signed-in' ? s : undefined; }, 900000, 2000);
		check(`B1. after approval the title bar shows ${expectedLogin}`, !!st && st.text.includes(expectedLogin), st);
		check('B2. the avatar image is shown', !!st && st.avatarLoaded, st && st.avatarLoaded);
		await snap('02-conectado-dark.png');
		await mouseClick(page, ENTRY);
		const menu = await waitFor(async () => { const e = await pickerEntries(page); return e.length ? e : undefined; }, 8000);
		check('B3. clicking the entry opens the account menu with account, publishing state, switch and sign out', !!menu && menu.some(e => e.includes(expectedLogin)) && menu.some(e => /Publicação: (não )?autorizada/.test(e)) && menu.some(e => /Trocar de conta/.test(e)) && menu.some(e => /Sair da conta/.test(e)), menu);
		await snap('03-menu-conta-dark.png');
		await key('{ESC}', 600);
		check('B4. the status bar shows the same account (complementary, not a second login)', (await statusText(page)).includes(expectedLogin), await statusText(page));
		page.close();
		check('B5. the IDE closes normally', (await lib.closeApp(profile, 30000)).forced === 0);

		// C. restart
		page = await openApp();
		st = await waitFor(async () => { const s = await entryState(page); return s && s.mode === 'signed-in' ? s : undefined; }, 20000);
		check(`C1. after restart the title bar shows ${expectedLogin} without a new login`, !!st && st.text.includes(expectedLogin) && st.avatarLoaded, st);
		check('C2. no authorization dialog appeared and the Copilot Sign In is still absent', !nativeDialog() && !(await copilotSignIn(page)));
		check('C3. the status bar agrees with the title bar', (await statusText(page)).includes(expectedLogin));

		// V. visual states (signed in)
		setSetting('workbench.colorTheme', 'Event Minimal Light'); await sleep(3500);
		st = await entryState(page);
		check('V1. Event Minimal Light: the entry is visible', !!st && st.visible, st);
		await snap('04-conectado-light.png');
		setSetting('workbench.colorTheme', 'Default High Contrast'); await sleep(3500);
		st = await entryState(page);
		check('V2. high contrast: the entry is visible', !!st && st.visible, st);
		await snap('05-alto-contraste.png');
		setSetting('workbench.colorTheme', 'Event Minimal Dark'); await sleep(3000);
		setSetting('window.zoomLevel', 2); await sleep(3500);
		st = await entryState(page);
		check('V3. enlarged interface (zoom +2): the entry is visible and inside the window', !!st && st.visible && st.rect[0] + st.rect[2] <= (await page.evaluate('window.innerWidth')), st);
		await snap('06-zoom.png');
		setSetting('window.zoomLevel', undefined); await sleep(3000);
		const hwnd = lib.appWindows(profile)[0].hwnd;
		lib.ps(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class RS { [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c); }'; [void][RS]::ShowWindow([IntPtr]${hwnd},9); [void][RS]::MoveWindow([IntPtr]${hwnd},40,40,700,640,$true)`);
		await sleep(3000);
		st = await entryState(page);
		check('V4. narrow window (700 px): the entry stays visible, reduced to the avatar', !!st && st.visible && st.rect[0] + st.rect[2] <= (await page.evaluate('window.innerWidth')), st);
		await snap('07-janela-estreita.png');
		lib.ps(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class RS { [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r); }'; [void][RS]::MoveWindow([IntPtr]${hwnd},40,40,1300,820,$true)`);
		await sleep(2500);

		// D. sign out from the title bar menu: entry -> menu -> "Sair da conta" with the keyboard
		await mouseClick(page, ENTRY);
		await waitFor(async () => (await pickerEntries(page)).length, 8000);
		await key('{DOWN}{DOWN}{DOWN}', 500);
		const focused = await page.evaluate("(document.querySelector('.quick-input-widget:not(.hidden) .quick-input-list-entry.focused, .quick-input-widget:not(.hidden) .monaco-list-row.focused') || {}).innerText || ''");
		check('D1. the menu item under the cursor is "Sair da conta"', /Sair da conta/.test(focused), focused.replace(/\s+/g, ' '));
		await key('{ENTER}', 1500);
		st = await waitFor(async () => { const s = await entryState(page); return s && s.mode === 'signed-out' ? s : undefined; }, 15000);
		check('D2. after sign out the title bar returns to "Entrar com GitHub"', !!st && /Entrar com GitHub/.test(st.text), st);
		check('D3. the status bar no longer shows the account and no false indicator remains', !(await statusText(page)).includes(expectedLogin) && /Entrar no GitHub/.test(await statusText(page)), await statusText(page));
		await snap('08-desconectado-final.png');
		page.close();
		await lib.closeApp(profile, 30000);
		page = await openApp();
		st = await waitFor(async () => (await entryState(page)), 20000);
		check('D4. after sign out and restart the session stays closed', !!st && st.mode === 'signed-out', st);
	} catch (e) {
		check('the title bar run completed', false, { error: e.message });
		try { if (page) { await snap('failure.png'); } } catch { /* ignore */ }
	} finally {
		try { if (page) { page.close(); } } catch { /* ignore */ }
		await lib.closeApp(profile, 30000);
		const hits = lib.ps(`(Get-ChildItem -Path '${profile}' -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Length -lt 20MB } | Select-String -Pattern 'gh[opusr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}' -List -ErrorAction SilentlyContinue | Measure-Object).Count`);
		check('no GitHub token pattern in the profile (logs and state)', Number(hits) === 0, { files: hits });
		for (const f of codeFiles) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
		const ok = results.length > 0 && results.every(r => r.ok);
		fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ build: exe ? 'packaged' : 'dev', expectedLogin, results, ok, finished: new Date().toISOString() }, null, 2));
		log(ok ? 'TITLEBAR ACCOUNT CHECK PASSED' : 'TITLEBAR ACCOUNT CHECK FAILED');
		process.exit(ok ? 0 : 1);
	}
})();
