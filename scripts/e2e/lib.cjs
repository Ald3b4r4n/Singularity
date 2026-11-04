'use strict';
// Small helpers for real, human-like E2E runs of the Singularity IDE on Windows.
//
//  - app control: launch with an isolated profile, wait for the DevTools page, close gracefully, clean up;
//  - CDP (DevTools protocol): evaluate in the page, screenshot, read performance marks;
//  - OS-level input (mouse and keyboard) that is ALWAYS preceded by a foreground-window guard, so a keystroke
//    can never land in another application: if the Singularity window is not the foreground window of the
//    expected process, nothing is sent and the call throws.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- PowerShell (inline commands only) ----------

const WIN32 = `
Add-Type -Namespace SG -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, int extra);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
'@
`;

function ps(code) {
	return execFileSync(process.env.SINGULARITY_E2E_POWERSHELL || 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', WIN32 + code], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
}

// ---------- processes and windows ----------

/** Processes of this app instance: image name "Singularity IDE" whose command line mentions the profile dir. */
function appProcesses(profileDir) {
	const needle = profileDir.replace(/'/g, "''");
	const out = ps(`Get-CimInstance Win32_Process -Filter "Name='Singularity IDE.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { $_.ProcessId } | ConvertTo-Json -Compress`);
	if (!out) { return []; }
	const v = JSON.parse(out);
	return Array.isArray(v) ? v : [v];
}

/** The main window of the instance: [{ pid, hwnd, title }]. */
function appWindows(profileDir) {
	const ids = appProcesses(profileDir);
	if (!ids.length) { return []; }
	const out = ps(`Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [pscustomobject]@{ pid = $_.Id; hwnd = [int64]$_.MainWindowHandle; title = $_.MainWindowTitle } } | ConvertTo-Json -Compress`);
	if (!out) { return []; }
	const v = JSON.parse(out);
	return Array.isArray(v) ? v : [v];
}

function foreground() {
	const out = ps(`$h=[SG.W]::GetForegroundWindow(); $p=0; [void][SG.W]::GetWindowThreadProcessId($h,[ref]$p); $n=(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName; [pscustomobject]@{hwnd=[int64]$h;pid=$p;name=$n} | ConvertTo-Json -Compress`);
	return JSON.parse(out);
}

/** Brings the window to the front and verifies it, or throws. */
async function bringToFront(profileDir) {
	for (let attempt = 0; attempt < 6; attempt++) {
		const wins = appWindows(profileDir);
		if (!wins.length) { throw new Error('no Singularity window for this profile'); }
		const w = wins[0];
		// ALT key tap lets SetForegroundWindow through the foreground lock
		ps(`$h=[IntPtr]${w.hwnd}; if([SG.W]::IsIconic($h)){[void][SG.W]::ShowWindow($h,9)}; [SG.W]::keybd_event(0x12,0,0,0); [SG.W]::keybd_event(0x12,0,2,0); [void][SG.W]::SetForegroundWindow($h)`);
		await sleep(400);
		if (foreground().hwnd === w.hwnd) { return w; }
	}
	throw new Error('could not bring the Singularity window to the foreground');
}

/** Throws unless the foreground window is the main window of this instance. */
function guard(profileDir) {
	const wins = appWindows(profileDir);
	const fg = foreground();
	if (!wins.some(w => w.hwnd === fg.hwnd)) {
		throw new Error(`guard: foreground window is "${fg.name}" (pid ${fg.pid}), not Singularity; no input sent`);
	}
	return fg;
}

// ---------- OS-level input (guarded) ----------

const SEND_ESCAPES = /[+^%~(){}[\]]/g;

/** SendKeys syntax, e.g. "^p", "{ENTER}", "{F1}". Guarded. */
function keys(profileDir, sendKeysText) {
	guard(profileDir);
	ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKeysText.replace(/'/g, "''")}')`);
}

/** Types text by pasting it through the clipboard (robust for any character). Guarded. */
function paste(profileDir, text) {
	guard(profileDir);
	const b64 = Buffer.from(text, 'utf8').toString('base64');
	ps(`Add-Type -AssemblyName System.Windows.Forms; $t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); Set-Clipboard -Value $t; [System.Windows.Forms.SendKeys]::SendWait('^v')`);
}

/** Left click at a position relative to the window's top-left corner. Guarded, and the point must be inside the window. */
function click(profileDir, x, y) {
	const w = guard(profileDir) && appWindows(profileDir)[0];
	ps(`$r=New-Object SG.W+RECT; [void][SG.W]::GetWindowRect([IntPtr]${w.hwnd},[ref]$r); $ax=$r.L+${x}; $ay=$r.T+${y}; if($ax -ge $r.R -or $ay -ge $r.B -or ${x} -lt 0 -or ${y} -lt 0){ throw 'click outside the window' }; [void][SG.W]::SetCursorPos($ax,$ay); Start-Sleep -Milliseconds 150; [SG.W]::mouse_event(2,0,0,0,0); [SG.W]::mouse_event(4,0,0,0,0)`);
}

/** Runs a command from the Command Palette. Guarded. */
async function runCommand(profileDir, title, wait = 700) {
	keys(profileDir, '{F1}');
	await sleep(600);
	paste(profileDir, title);
	await sleep(500);
	keys(profileDir, '{ENTER}');
	await sleep(wait);
}

// ---------- DevTools protocol ----------

async function pages(port) {
	const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
	return list.filter(x => x.type === 'page' && /workbench/.test(x.url));
}

async function waitPage(port, timeoutMs = 60000, index = 0) {
	const end = Date.now() + timeoutMs;
	for (; ;) {
		try { const p = await pages(port); if (p[index]) { return p[index]; } } catch { /* not up yet */ }
		if (Date.now() > end) { throw new Error('workbench page did not appear'); }
		await sleep(250);
	}
}

async function cdp(port, index = 0) {
	const WS = require(path.join(__dirname, '..', '..', 'singularity-hub', 'node_modules', 'ws'));
	const target = await waitPage(port, 30000, index);
	const ws = new WS(target.webSocketDebuggerUrl);
	await new Promise(r => ws.once('open', r));
	let id = 0; const pending = new Map();
	ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } });
	const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
	return {
		evaluate: async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value,
		screenshot: async file => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; },
		marks: async () => JSON.parse(await (async () => (await send('Runtime.evaluate', { expression: "JSON.stringify(performance.getEntriesByType('mark').map(m => [m.name, Math.round(m.startTime)]))", returnByValue: true })).result.value)()),
		close: () => ws.close(),
	};
}

// ---------- app lifecycle ----------

/**
 * options: { exe, dev (repo path), profile, workspace, port, env }
 * Dev mode runs scripts\code.bat from the repo, packaged mode runs the exe.
 */
function launch(options) {
	const profile = options.profile;
	fs.mkdirSync(path.join(profile, 'data', 'User'), { recursive: true });
	const settings = path.join(profile, 'data', 'User', 'settings.json');
	if (!fs.existsSync(settings)) {
		fs.writeFileSync(settings, JSON.stringify({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', ...(options.settings ?? {}) }, null, 2));
	}
	const args = [`--remote-debugging-port=${options.port}`, `--user-data-dir=${path.join(profile, 'data')}`, `--extensions-dir=${path.join(profile, 'ext')}`];
	if (options.dev) { args.push(`--shared-data-dir=${path.join(profile, 'shared')}`); }
	if (options.workspace) { args.push(options.workspace); }
	if (options.files) { args.push(...options.files); }
	const env = { ...process.env, ...options.env };
	if (options.dev) { env.VSCODE_SKIP_PRELAUNCH = '1'; }
	const child = options.dev
		? spawn('cmd.exe', ['/c', path.join(options.dev, 'scripts', 'code.bat'), ...args], { cwd: options.dev, env, detached: true, stdio: 'ignore', windowsHide: false })
		: spawn(options.exe, args, { cwd: path.dirname(options.exe), env, detached: true, stdio: 'ignore' });
	child.unref();
	return child;
}

/** Closes the windows of the instance the way a user would (title-bar close), then force-kills only what is left of it. */
async function closeApp(profileDir, graceMs = 12000) {
	const wins = appWindows(profileDir);
	if (wins.length) { ps(`Get-Process -Id ${wins.map(w => w.pid).join(',')} -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }`); }
	const end = Date.now() + graceMs;
	while (Date.now() < end && appProcesses(profileDir).length) { await sleep(500); }
	const left = appProcesses(profileDir);
	if (left.length) { ps(`Stop-Process -Id ${left.join(',')} -Force -ErrorAction SilentlyContinue`); await sleep(500); }
	return { forced: left.length };
}

function tempProfile(label = 'e2e') {
	return fs.mkdtempSync(path.join(os.tmpdir(), `singularity-${label}-`));
}

function rmrf(p) {
	fs.rmSync(p, { recursive: true, force: true });
}

module.exports = { sleep, ps, appProcesses, appWindows, foreground, bringToFront, guard, keys, paste, click, runCommand, pages, waitPage, cdp, launch, closeApp, tempProfile, rmrf, SEND_ESCAPES };
