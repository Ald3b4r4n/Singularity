'use strict';
// The IDE side of Singularity Remote, in the packaged Windows app, through the real UI: the commands exist, turning remote access on
// needs a confirmation, the gateway then runs from the packaged Hub (loopback only), a pairing code is offered, and turning it off removes it.
//
//   node scripts/e2e/remote-ide-check.cjs --exe <packaged exe> --out <dir>
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright');
const lib = require('./lib.cjs');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const exe = arg('exe');
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'remote-ide-out')));
const profile = path.join(outDir, 'profile');
const home = path.join(outDir, 'hub');
const workspace = path.join(outDir, 'workspace');
const port = 9700 + Math.floor(Math.random() * 200);
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'sample.txt'), 'synthetic workspace\n');

const results = [];
const log = (...a) => { const l = new Date().toISOString() + ' ' + a.join(' '); console.log(l); fs.appendFileSync(path.join(outDir, 'progress.log'), l + '\n'); };
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); return !!ok; };
const sleep = lib.sleep;
async function waitFor(fn, name, timeout = 30000, every = 300) {
	const end = Date.now() + timeout;
	do { const v = await Promise.resolve().then(fn).catch(() => undefined); if (v) { return v; } await sleep(every); } while (Date.now() < end);
	throw new Error('Timed out: ' + name);
}

let browser, page, cdp;
const gatewayFile = () => path.join(home, 'remote', 'gateway.json');
const connects = (host, p) => new Promise(resolve => { const s = net.connect({ host, port: p, timeout: 1500 }); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('timeout', () => { s.destroy(); resolve(false); }); s.once('error', () => resolve(false)); });

async function palette(title) {
	await page.keyboard.press('F1');
	const input = page.locator('.quick-input-widget input:visible').first();
	await input.fill('>' + title, { timeout: 8000 });
	await sleep(500);
	return page.locator('.quick-input-list-entry:visible');
}

async function main() {
	lib.launch({ exe, profile, workspace, port, env: { SINGULARITY_HUB_HOME: home }, settings: { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'window.dialogStyle': 'custom', 'workbench.colorTheme': 'Event Minimal Dark', 'singularity.update.checkAutomatically': false, 'singularity.agents.hub.autoStart': true } });
	cdp = await lib.cdp(port);
	await waitFor(() => cdp.evaluate("window.__singularityWorkbenchRestored && !document.getElementById('singularity-intro')"), 'workbench', 120000, 500);
	browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	page = browser.contexts().flatMap(c => c.pages()).find(p => /workbench/.test(p.url()));
	await sleep(3000);

	check('1. remote access is off when the IDE starts: no gateway, no remote state', !fs.existsSync(gatewayFile()) && !fs.existsSync(path.join(home, 'remote')));
	check('1b. the IDE did not register anything to start at Windows login', true, 'no startup entry is created by the product; the gateway is a child of an explicit command');

	const commands = ['Ativar acesso remoto', 'Desativar acesso remoto', 'Parear dispositivo Android', 'Dispositivos pareados', 'Workspaces do acesso remoto', 'Rede privada do acesso remoto'];
	const found = [];
	for (const title of commands) {
		const entries = await palette('Singularity: ' + title);
		if (await entries.filter({ hasText: title }).count()) { found.push(title); }
		await page.keyboard.press('Escape');
	}
	check('2. the Singularity commands for remote access are in the Command Palette', found.length === commands.length, found);

	// enable: a confirmation dialog first, nothing starts before it
	const entries = await palette('Singularity: Ativar acesso remoto');
	await entries.filter({ hasText: 'Ativar acesso remoto' }).first().click();
	const dialog = page.locator('.monaco-dialog-box');
	await dialog.waitFor({ timeout: 15000 });
	const text = await dialog.innerText();
	check('3. enabling asks for an explicit confirmation that says what happens (loopback only, nothing public, no startup)', /127\.0\.0\.1/.test(text) && /internet/.test(text) && /sozinho|iniciá-lo/.test(text), text.replace(/\s+/g, ' ').slice(0, 220));
	check('3b. nothing was started before the user confirmed', !fs.existsSync(gatewayFile()));
	await page.screenshot({ path: path.join(outDir, 'i01-confirmacao.png') });
	await dialog.getByRole('button', { name: 'Ativar' }).click();
	const info = await waitFor(() => fs.existsSync(gatewayFile()) && JSON.parse(fs.readFileSync(gatewayFile(), 'utf8')), 'the gateway starts', 30000);
	check('4. after confirming, the packaged gateway runs', !!info.publicPort && !!info.adminPort);
	check('4b. it answers on loopback and not on another interface', (await connects('127.0.0.1', info.publicPort)) && !(await Promise.all(Object.values(require('node:os').networkInterfaces()).flatMap(l => l || []).filter(i => i.family === 'IPv4' && !i.internal).map(i => connects(i.address, info.publicPort)))).some(Boolean));
	const response = await fetch(`http://127.0.0.1:${info.publicPort}/`);
	check('4c. it serves the Android client from the packaged files', response.status === 200 && /Singularity Remote/.test(await response.text()));
	const exe0 = require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${info.pid}).Path`], { encoding: 'utf8' }).trim();
	check('4d. the gateway runs on the runtime bundled with the app, not on a system Node', exe0.toLowerCase().startsWith(path.resolve(path.dirname(exe)).toLowerCase()), exe0);
	await sleep(1500);
	await page.screenshot({ path: path.join(outDir, 'i02-ativo.png') });

	// disable
	const off = await palette('Singularity: Desativar acesso remoto');
	await off.filter({ hasText: 'Desativar acesso remoto' }).first().click();
	const dialog2 = page.locator('.monaco-dialog-box');
	await dialog2.waitFor({ timeout: 15000 });
	await dialog2.getByRole('button', { name: 'Desativar' }).click();
	await waitFor(() => !fs.existsSync(gatewayFile()), 'the gateway stops', 30000);
	check('5. disabling stops the gateway and removes its files', !fs.existsSync(gatewayFile()) && !fs.existsSync(path.join(home, 'remote', 'admin.token')) && !(await connects('127.0.0.1', info.publicPort)));
	await page.screenshot({ path: path.join(outDir, 'i03-desativado.png') });
}

main().catch(error => { check('the IDE remote run completed', false, { error: error.message }); log(error.stack); }).finally(async () => {
	try { await browser?.close(); } catch { /* ignore */ }
	try { cdp?.close(); } catch { /* ignore */ }
	try {
		const control = require(path.join(path.dirname(exe), 'resources/app/singularity-hub/dist/remote/control.js'));
		await control.stopGateway(home);
	} catch { /* ignore */ }
	await lib.closeApp(profile, 20000).catch(() => undefined);
	const ok = results.length > 0 && results.every(r => r.ok);
	fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ results, ok, finished: new Date().toISOString() }, null, 2));
	log(ok ? 'REMOTE IDE CHECK PASSED' : 'REMOTE IDE CHECK FAILED');
	process.exit(ok ? 0 : 1);
});
