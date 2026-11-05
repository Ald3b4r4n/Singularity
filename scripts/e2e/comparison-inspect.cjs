'use strict';
// Reopens real E2E results for a visual regression. It never submits a prompt.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');
const WebSocket = require('../../singularity-hub/node_modules/ws');
const ui = require('./lib.cjs');
const exe = path.resolve(process.argv[2]), root = path.resolve(process.argv[3]);
const dist = path.join(path.dirname(exe), 'resources/app/singularity-hub/dist');
const { HubConnection } = require(path.join(dist, 'client'));
const home = path.join(root, 'hub'), workspace = path.join(root, 'workspace'), profile = path.join(root, 'inspection-profile');
const env = { ...process.env, SINGULARITY_HUB_HOME: home, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), OPENCODE_API_KEY: '', OPENCODE_ZEN_API_KEY: '', OPENCODE_GO_API_KEY: '' };
let child, client, browser;
const port = 31000 + Math.floor(Math.random() * 2000);
async function until(fn) { for (let i = 0; i < 240; i++) { const v = await fn(); if (v) { return v; } await ui.sleep(250); } throw new Error('Inspection timed out.'); }
async function doc(fn, args) {
	for (const t of (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(t => t.type === 'iframe')) {
		const s = new WebSocket(t.webSocketDebuggerUrl);
		try { await once(s, 'open'); const reply = once(s, 'message'); s.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(() => { const d=document.querySelector('iframe#active-frame')?.contentDocument; return d?.querySelector('#mode-comparison') ? (${fn.toString()})(d,${JSON.stringify(args ?? null)}) : undefined; })()`, returnByValue: true } })); const v = JSON.parse((await reply)[0]).result?.result?.value; if (v !== undefined) { return v; } } finally { s.close(); }
	}
}
(async () => {
	child = spawn(path.join(dist, '../runtime/node.exe'), [path.join(dist, 'main.js')], { env, windowsHide: true, stdio: 'ignore' });
	client = await until(async () => { try { return await HubConnection.connect({ home, clientName: 'comparison-inspection' }); } catch {} });
	ui.launch({ exe, profile, workspace, port, env, settings: { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'singularity.agents.hub.autoStart': false, 'singularity.update.checkAutomatically': false, 'workbench.colorTheme': 'Event Minimal Dark' } });
	await ui.waitPage(port); browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('workbench'));
	await until(() => doc(d => { d.querySelector('#mode-comparison').click(); return true; }));
	for (const [count, name, needle] of [[2, 'dois-agentes', 'COMPARISON-OK'], [3, 'tres-agentes', 'THREE-AGENTS-OK'], [2, 'recuperacao', 'Without tools']]) {
		const runs = await client.request('comparisons.list', { workspace });
		const r = runs.find(r => r.participants.length === count && r.prompt.includes(needle));
		await until(() => doc((d, id) => { const s = d.querySelector('#comparison-run'); if (!s || ![...s.options].some(o => o.value === id)) { return false; } s.value=id; s.dispatchEvent(new Event('change', { bubbles: true })); return true; }, r.id));
		for (const p of r.participants) { await doc((d,id) => { d.querySelector(`[data-cmp="inspect"][data-participant="${id}"]`).click(); return true; },p.id); }
		await until(() => doc((d,count) => d.querySelectorAll('.comparison-diff').length === count, count));
		await doc(d => { d.querySelector('.list').scrollTop=0; return true; });
		await page.screenshot({ path:path.join(root,name+'.png') });
	}
	const sidebar = await page.locator('body').count();
	if (!sidebar || !fs.existsSync(path.join(root,'tres-agentes.png'))) { throw new Error('No inspected UI.'); }
	console.log('Packaged comparison inspection passed. Saved readable two- and three-agent results without new inference.');
})().catch(e => { console.error(e);process.exitCode=1; }).finally(async()=>{if(client){await client.request('hub.shutdown',{}).catch(()=>{});client.close();}if(browser){await ui.closeApp(profile).catch(()=>{});await browser.close();}if(child?.exitCode===null){await ui.sleep(1200);if(child.exitCode===null){child.kill();}}});
