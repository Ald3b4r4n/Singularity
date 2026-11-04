'use strict';
// Shared helpers to drive the Singularity IDE through its real UI (real keyboard and mouse of Windows), for the E2E scripts.
// Every input is sent to the window of this instance only (lib.cjs guards it). Nothing here reads or prints a token.

const fs = require('fs'), path = require('path');
const lib = require('./lib.cjs');

function createUi({ exe, dev, profile, workspace, port, outDir, env = {}, baseSettings = {} }) {
	const sleep = lib.sleep;
	const log = (...a) => { const l = new Date().toISOString() + ' ' + a.join(' '); console.log(l); fs.appendFileSync(path.join(outDir, 'progress.log'), l + '\n'); };
	const results = [];
	const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); return !!ok; };
	const codeFiles = [];

	async function waitFor(fn, ms, every = 700) { const end = Date.now() + ms; for (; ;) { const v = await fn().catch(() => undefined); if (v) { return v; } if (Date.now() > end) { return undefined; } await sleep(every); } }
	async function retry(fn) { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 3 || /guard:/.test(e.message)) { throw e; } await sleep(1000); } } }

	// bringToFront taps ALT, which focuses the VS Code menu bar and swallows the next keys: only when the window is not in front
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

	const settingsFile = () => path.join(profile, 'data', 'User', 'settings.json');
	function setSetting(k, v) {
		const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
		if (v === undefined) { delete s[k]; } else { s[k] = v; }
		fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
	}

	async function openApp(settings) {
		lib.launch({ exe, dev, profile, workspace, port, env, settings: { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'workbench.colorTheme': 'Event Minimal Dark', ...baseSettings, ...(settings || {}) } });
		const page = await lib.cdp(port);
		for (let i = 0; i < 180 && !(await page.evaluate('window.__singularityWorkbenchRestored === true')); i++) { await sleep(500); }
		for (let i = 0; i < 40 && !(await page.evaluate("!document.getElementById('singularity-intro')")); i++) { await sleep(500); }
		await lib.bringToFront(profile);
		const hwnd = lib.appWindows(profile)[0].hwnd;
		lib.ps(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class RS0 { [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c); }'; [void][RS0]::ShowWindow([IntPtr]${hwnd},9); [void][RS0]::MoveWindow([IntPtr]${hwnd},40,40,1300,820,$true)`);
		await sleep(7000);
		return page;
	}

	async function palette(page, title) {
		const state = () => page.evaluate("JSON.stringify({ v: (document.querySelector('.quick-input-widget:not(.hidden) input') || {}).value, f: (document.querySelector('.quick-input-widget:not(.hidden) .quick-input-list-entry') || {}).innerText })").then(JSON.parse);
		for (let attempt = 0; attempt < 3; attempt++) {
			await key('{F1}', 800);
			await paste(title, 0);
			for (let i = 0; i < 20; i++) {
				await sleep(250);
				const s = await state();
				// the list text can lose highlighted letters in innerText, so the first entry is matched by the command's first word
				if ((s.v || '').includes(title) && (s.f || '').includes(title.split(' ')[0])) { await key('{ENTER}', 1200); return; }
			}
			await key('{ESC}', 500);
		}
		throw new Error(`the Command Palette did not accept "${title}"`);
	}

	function shot(file) {
		const w = lib.appWindows(profile)[0];
		lib.ps(`Add-Type -AssemblyName System.Drawing; $r=New-Object SG.W+RECT; [void][SG.W]::GetWindowRect([IntPtr]${w.hwnd},[ref]$r); $b=New-Object System.Drawing.Bitmap ($r.R-$r.L),($r.B-$r.T); $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($r.L,$r.T,0,0,$b.Size); $b.Save('${file}')`);
	}
	const snap = async name => { await front(); await sleep(400); shot(path.join(outDir, name)); log('screenshot', name); };

	/** Real mouse click at the centre of the element returned by the JS expression `elementExpr` (evaluated in the page). */
	async function mouseClickEl(page, elementExpr) {
		const g = await page.evaluate(`(() => { const e = ${elementExpr}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: window.devicePixelRatio, ow: window.outerWidth, oh: window.outerHeight, iw: window.innerWidth, ih: window.innerHeight }; })()`);
		if (!g) { throw new Error('element not found: ' + elementExpr.slice(0, 80)); }
		const border = (g.ow - g.iw) / 2;
		await front();
		await retry(() => lib.click(profile, Math.round((g.x + border) * g.dpr), Math.round((g.y + (g.oh - g.ih) - border) * g.dpr)));
		await sleep(700);
	}
	const mouseClick = (page, selector) => mouseClickEl(page, `document.querySelector(${JSON.stringify(selector)})`);

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

	/** Waits for the device-code modal, saves the code for the owner (a transient file, deleted at the end), accepts with Enter. */
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
	const entryState = page => page.evaluate(`(() => { const e = document.querySelector('${ENTRY}'); if (!e) return null; const r = e.getBoundingClientRect(); return { mode: e.classList.contains('signed-in') ? 'signed-in' : 'signed-out', text: e.innerText.trim(), visible: r.width > 0 && r.height > 0, tooltip: (e.closest('.action-item') || e).title || '' }; })()`);
	const toasts = page => page.evaluate("[...document.querySelectorAll('.notifications-toasts .notification-list-item')].map(e => e.innerText.replace(/\\s+/g, ' ').trim())");

	return { fs, path, lib, sleep, log, results, check, codeFiles, waitFor, retry, front, key, paste, setSetting, settingsFile, openApp, palette, snap, mouseClick, mouseClickEl, nativeDialog, acceptDeviceCode, ENTRY, entryState, toasts };
}

module.exports = { createUi };
