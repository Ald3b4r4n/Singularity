'use strict';
// E2E of the Singularity Browser (the integrated browser of the IDE) with real keyboard and mouse, on an isolated profile.
// A local HTTP server (127.0.0.1) serves the test pages; what the browser really requested is judged from the server log,
// not from the DOM of the IDE (the page lives in its own WebContentsView).
//
//   node scripts/e2e/browser-check.cjs --out <dir> [--dev <repo>] [--exe <packaged exe>]

const fs = require('fs'), path = require('path'), http = require('http');
const lib = require('./lib.cjs');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const exe = arg('exe');
const dev = exe ? undefined : arg('dev', 'D:\\dev\\singularity');
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'browser-out')));
const profile = path.join(outDir, 'profile');
const workspace = path.join(outDir, 'ws');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'hello.txt'), 'hello from the editor\n');
const port = 9700 + Math.floor(Math.random() * 90);
const log = (...a) => { const l = new Date().toISOString() + ' ' + a.join(' '); console.log(l); fs.appendFileSync(path.join(outDir, 'progress.log'), l + '\n'); };
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };

// ---------- local test server ----------
const hits = [];
let report;
const PAGE = (title, body, extra = '') => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0;font:28px system-ui;background:#fff;color:#111">${body}${extra}`;
const server = http.createServer((req, res) => {
	let body = '';
	req.on('data', c => { body += c; });
	req.on('end', () => {
		hits.push(`${req.method} ${req.url}`);
		if (req.method === 'POST' && req.url === '/report') { report = JSON.parse(body); res.end('ok'); return; }
		res.setHeader('content-type', 'text/html; charset=utf-8');
		if (req.url.startsWith('/a.html')) { res.end(PAGE('Singularity Test A', '<a href="/b.html" style="display:block;height:100vh;padding:24px;color:#0b57d0">PAGE A: click anywhere to go to B</a>')); }
		else if (req.url.startsWith('/b.html')) { res.end(PAGE('Singularity Test B', '<div style="padding:24px">PAGE B</div>')); }
		else if (req.url.startsWith('/iso.html')) {
			res.end(PAGE('Isolation probe', '<div style="padding:24px">probe</div>', `<script>
(async () => {
  const r = { require: typeof require, process: typeof process, module: typeof module, vscode: typeof vscode, acquireVsCodeApi: typeof acquireVsCodeApi, electron: typeof electron, ipcRenderer: typeof ipcRenderer, helpers: typeof __vscode_helpers === 'object' ? Object.keys(__vscode_helpers).sort().join(',') : typeof __vscode_helpers };
  try { const f = await fetch('file:///C:/Windows/win.ini'); r.fileFetch = 'allowed ' + f.status; } catch (e) { r.fileFetch = 'blocked'; }
  try { r.cookiesBefore = document.cookie; document.cookie = 'probe=1; path=/'; } catch (e) { r.cookie = 'error'; }
  await fetch('/report', { method: 'POST', body: JSON.stringify(r) });
})();</script>`));
		} else { res.statusCode = 404; res.end('not found'); }
	});
});

// ---------- helpers ----------
const sleep = lib.sleep;
async function waitFor(fn, ms, every = 500) { const end = Date.now() + ms; for (; ;) { const v = await fn().catch(() => undefined); if (v) { return v; } if (Date.now() > end) { return undefined; } await sleep(every); } }
const sentHits = () => hits.filter(h => !h.startsWith('POST'));

async function openApp(extraSettings) {
	lib.launch({ exe, dev, profile, workspace, port, env: { SINGULARITY_HUB_HOME: path.join(outDir, 'hub') }, settings: { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', ...(extraSettings || {}) } });
	const page = await lib.cdp(port);
	for (let i = 0; i < 180 && !(await page.evaluate('window.__singularityWorkbenchRestored === true')); i++) { await sleep(500); }
	for (let i = 0; i < 40 && !(await page.evaluate("!document.getElementById('singularity-intro')")); i++) { await sleep(500); }
	await lib.bringToFront(profile);
	await sleep(5000);
	return page;
}

// bringToFront taps ALT, which focuses the VS Code menu bar and swallows the next keys: use it only when the window is not in front
async function retry(fn) { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 3 || /guard:/.test(e.message)) { throw e; } await sleep(1000); } } }
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

const tabs = page => page.evaluate("[...document.querySelectorAll('.tabs-container .tab')].map(t => ({ label: t.getAttribute('aria-label') || '', active: t.classList.contains('active'), group: [...document.querySelectorAll('.editor-group-container')].findIndex(g => g.contains(t)) }))");
const browserTabs = async page => (await tabs(page)).filter(t => /Singularity Test|Isolation|Browser|127\.0\.0\.1/i.test(t.label));
const groups = page => page.evaluate("document.querySelectorAll('.editor-group-container:not(.empty), .editor-group-container').length");

/** Real mouse click at the centre of the first element matching `selector` (window frame and device scale taken into account). */
async function mouseClick(page, selector, dy = 0) {
	const g = await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 + ${dy}, dpr: window.devicePixelRatio, ow: window.outerWidth, oh: window.outerHeight, iw: window.innerWidth, ih: window.innerHeight }; })()`);
	if (!g) { throw new Error('element not found: ' + selector); }
	const border = (g.ow - g.iw) / 2;
	await front();
	await retry(() => lib.click(profile, Math.round((g.x + border) * g.dpr), Math.round((g.y + (g.oh - g.ih) - border) * g.dpr)));
	await sleep(800);
}

function shot(file) {
	const w = lib.appWindows(profile)[0];
	lib.ps(`Add-Type -AssemblyName System.Drawing; $r=New-Object SG.W+RECT; [void][SG.W]::GetWindowRect([IntPtr]${w.hwnd},[ref]$r); $b=New-Object System.Drawing.Bitmap ($r.R-$r.L),($r.B-$r.T); $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($r.L,$r.T,0,0,$b.Size); $b.Save('${file}')`);
}
// Bringing the window to the front and capturing it go through PowerShell and the OS focus; another application taking the focus at that
// moment is a harness problem, not a product one, so the capture is retried before it is reported.
const snap = async name => {
	for (let attempt = 1; ; attempt++) {
		try { await front(); await sleep(500); shot(path.join(outDir, name)); break; } catch (error) { if (attempt >= 3) { throw error; } log('screenshot retry', name, String(error.message).slice(0, 120).replace(/\s+/g, ' ')); await sleep(1500); }
	}
	log('screenshot', name);
};

function setTheme(theme) {
	const f = path.join(profile, 'data', 'User', 'settings.json');
	const s = JSON.parse(fs.readFileSync(f, 'utf8'));
	s['workbench.colorTheme'] = theme;
	fs.writeFileSync(f, JSON.stringify(s, null, 2));
}

(async () => {
	await new Promise(r => server.listen(0, '127.0.0.1', r));
	const base = `http://127.0.0.1:${server.address().port}`;
	let page;
	try {
		page = await openApp({ 'workbench.colorTheme': 'Event Minimal Dark' });

		// 1. open the browser with the title-bar shortcut / palette
		await palette(page, 'Singularity Browser: Open Browser');
		const t1 = await browserTabs(page);
		check('1. the Singularity Browser opens as an editor tab', t1.length === 1, t1);
		const idText = await page.evaluate('document.body.innerText');
		check('1b. the browser presents itself as "Singularity Browser" (welcome title)', /Singularity Browser/.test(idText));
		const shareLabel = await page.evaluate("(() => { const b = document.querySelector('.browser-share-toggle'); return b ? b.getAttribute('aria-label') : null; })()");
		check('1c. no tab starts shared with an agent (sharing is an explicit per-tab opt-in)', !shareLabel || shareLabel === 'Share with Agent', shareLabel);
		await snap('01-aberto-dark.png');

		// 1d. effective value of workbench.browser.enableChatTools in the Settings UI (product default must be off)
		await palette(page, 'Preferences: Open Settings (UI)');
		await paste('@id:workbench.browser.enableChatTools', 1500);
		const chatTools = await waitFor(() => page.evaluate("(() => { const c = document.querySelector('.settings-editor .setting-item-bool input, .settings-editor .setting-item-bool [role=checkbox], .settings-editor .setting-value-checkbox'); return c ? (c.getAttribute('aria-checked') ?? String(c.checked)) : undefined; })()"), 8000);
		check('1d. agents cannot drive browser pages by default (enableChatTools is off)', chatTools === 'false', chatTools);
		await snap('01b-configuracao-agentes.png');
		await key('^w', 800);

		// 2. address bar
		await key('^l');
		await paste(`${base}/a.html`);
		await key('{ENTER}', 1500);
		const okA = await waitFor(async () => sentHits().includes('GET /a.html'), 15000);
		check('2. the address bar loads a local page (server received GET /a.html)', !!okA, sentHits());
		const labelA = await waitFor(async () => (await browserTabs(page)).find(t => /Test A/.test(t.label)), 10000);
		check('2b. the tab title follows the page title', !!labelA, labelA && labelA.label);
		await snap('02-pagina-a-dark.png');

		// 3. navigate by clicking a link with the real mouse
		const region = '.editor-group-container .editor-container';
		await mouseClick(page, region, 120);
		const okB = await waitFor(async () => sentHits().includes('GET /b.html'), 10000);
		check('3. a real mouse click on a link navigates (server received GET /b.html)', !!okB, sentHits());
		await snap('03-pagina-b-dark.png');

		// 4. back / forward / reload
		const before = sentHits().length;
		await key('%{LEFT}', 1500);
		const backA = await waitFor(async () => (await browserTabs(page)).find(t => /Test A/.test(t.label)), 8000);
		check('4a. Alt+Left goes back to page A', !!backA, backA && backA.label);
		await key('%{RIGHT}', 1500);
		const fwdB = await waitFor(async () => (await browserTabs(page)).find(t => /Test B/.test(t.label)), 8000);
		check('4b. Alt+Right goes forward to page B', !!fwdB, fwdB && fwdB.label);
		const reqBefore = sentHits().filter(h => h === 'GET /b.html').length;
		await key('{F5}', 1500);
		const reloaded = await waitFor(async () => sentHits().filter(h => h === 'GET /b.html').length > reqBefore, 8000);
		check('4c. F5 reloads the page (a new request reached the server)', !!reloaded, { before: reqBefore, requests: sentHits().length - before });

		// 5. isolation probe
		await key('^l');
		await paste(`${base}/iso.html`);
		await key('{ENTER}', 1500);
		await waitFor(async () => report, 10000);
		check('5a. the page cannot reach Node/Electron/VS Code APIs', !!report && ['require', 'process', 'module', 'vscode', 'acquireVsCodeApi', 'electron', 'ipcRenderer'].every(k => report[k] === 'undefined'), report);
		check('5a2. the only bridge visible to the page is the helper pair (no IPC, no IDE API)', !!report && report.helpers === 'getElement,getFrameToken', report && report.helpers);
		check('5b. the page cannot read local files through file://', !!report && report.fileFetch === 'blocked', report && report.fileFetch);
		const ghTokenLeak = hits.some(h => /gho_|ghp_|token/i.test(h));
		check('5c. no GitHub credential or token reached the page', !ghTokenLeak);

		// 6. two tabs
		await palette(page, 'Singularity Browser: Open Browser');
		const two = await browserTabs(page);
		check('6. a second browser tab can be opened', two.length >= 2, two.map(t => t.label));

		// 7. editor and browser side by side: hello.txt in the right group, the browser visible in the left group
		await key('^p', 800);
		await paste('hello.txt', 800);
		await key('{ENTER}', 1500);
		await key('^{]}', 1500);
		await mouseClick(page, '.editor-group-container:first-child .tab[aria-label^="Isolation"]');
		const sides = await page.evaluate("[...document.querySelectorAll('.editor-group-container')].map(c => { const t = c.querySelector('.tab.active'); return t ? t.getAttribute('aria-label') : null; })");
		check('7. the browser (left) and the editor (right) are visible side by side', sides.length >= 2 && /Isolation|Browser/.test(sides[0] || '') && /hello.txt/.test(sides[1] || ''), sides);
		await snap('04-lado-a-lado-dark.png');

		// 8. DevTools with the real F12 key on the page
		const devtoolsBefore = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(t => /devtools/i.test(t.url)).length;
		await mouseClick(page, '.editor-group-container:first-child .editor-container', 150);
		await key('{F12}', 3000);
		const devtoolsAfter = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(t => /devtools/i.test(t.url)).length;
		check('8. F12 opens Developer Tools for the page', devtoolsAfter > devtoolsBefore, { before: devtoolsBefore, after: devtoolsAfter });
		await snap('05-devtools-dark.png');
		await key('{F12}', 1500);

		// 9. themes
		setTheme('Event Minimal Light');
		await sleep(3000);
		const light = await page.evaluate("document.querySelector('.monaco-workbench').className");
		check('9a. Event Minimal Light applies to the browser UI', /\bvs\b/.test(light) && !/vs-dark/.test(light), light.slice(0, 80));
		await snap('06-light.png');
		setTheme('Event Minimal Dark');
		await sleep(3000);
		const dark = await page.evaluate("document.querySelector('.monaco-workbench').className");
		check('9b. Event Minimal Dark applies back', /vs-dark/.test(dark));

		// 10. resize
		const w0 = await page.evaluate('window.innerWidth');
		const hwnd = lib.appWindows(profile)[0].hwnd;
		lib.ps(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class RS { [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c); }'; [void][RS]::ShowWindow([IntPtr]${hwnd},9); [void][RS]::MoveWindow([IntPtr]${hwnd},60,40,1000,680,$true)`);
		await sleep(2500);
		const dims = await page.evaluate('({ w: window.innerWidth, scroll: document.documentElement.scrollWidth })');
		check('10. resizing the window re-lays out the browser without horizontal overflow', dims.w < w0 && dims.scroll <= dims.w + 1, { before: w0, after: dims });
		await snap('07-redimensionado.png');

		// 12. regression (terminal, Git, extensions): focus the editor first, because keys sent while the page has focus go to the page
		await mouseClick(page, '.editor-group-container:last-child .tab.active');
		await palette(page, 'Terminal: Create New Terminal');
		check('12a. regression: the integrated terminal still opens', !!(await waitFor(() => page.evaluate("!!document.querySelector('.terminal-wrapper, .xterm')"), 10000)));
		await mouseClick(page, '.activitybar [aria-label^="Source Control"]');
		log('sidebar text:', JSON.stringify(await page.evaluate("((document.querySelector('.sidebar') || {}).innerText || '').slice(0, 200)")));
		await snap('09-scm.png');
		check('12b. regression: the Source Control view still opens', !!(await waitFor(() => page.evaluate("/source control|repositor/i.test((document.querySelector('.sidebar') || {}).innerText || '')"), 8000)));
		await key('^+x', 1500);
		check('12c. regression: the Extensions view still opens', !!(await waitFor(() => page.evaluate("[...document.querySelectorAll('.activitybar .action-item.checked a')].some(a => /extensions/i.test(a.getAttribute('aria-label') || ''))"), 8000)));

		// 11. close and reopen
		page.close();
		const closed = await lib.closeApp(profile, 30000);
		log('closeApp', JSON.stringify(closed));
		check('11a. the IDE closes normally (no forced kill)', closed.forced === 0, closed);
		const n = sentHits().length;
		page = await openApp({ 'workbench.colorTheme': 'Event Minimal Dark' });
		const restored = (await waitFor(async () => { const t = await browserTabs(page); return t.length ? t : undefined; }, 20000)) || [];
		log('restore debug:', JSON.stringify(await page.evaluate("({ tabs: document.querySelectorAll('.tab').length, containers: document.querySelectorAll('.tabs-container').length, labels: [...document.querySelectorAll('.tab')].map(t => t.getAttribute('aria-label')), href: location.pathname.slice(-30) })")));
		check('11. after closing and reopening, the browser tabs are restored', restored.length >= 1, restored.map(t => t.label));
		await snap('08-reaberto-dark.png');
		await mouseClick(page, '.tab[aria-label^="Isolation"]').catch(() => { });
		const reloadedAfter = await waitFor(async () => sentHits().length > n, 10000);
		check('11b. the restored page loads again when its tab is shown', !!reloadedAfter, { newRequests: sentHits().length - n });
	} catch (e) {
		check('the browser run completed', false, { error: e.message });
		try { if (page) { await snap('failure.png'); } } catch { /* ignore */ }
	} finally {
		try { if (page) { page.close(); } } catch { /* ignore */ }
		await lib.closeApp(profile);
		server.close();
		const ok = results.length > 0 && results.every(r => r.ok);
		fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ build: exe ? 'packaged' : 'dev', results, requests: sentHits(), ok, finished: new Date().toISOString() }, null, 2));
		log(ok ? 'BROWSER CHECK PASSED' : 'BROWSER CHECK FAILED');
		process.exit(ok ? 0 : 1);
	}
})();
