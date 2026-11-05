'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');
const WebSocket = require('../../singularity-hub/node_modules/ws');
const ui = require('./lib.cjs');
const exe = path.resolve(process.argv[2]), root = path.resolve(process.argv[3]);
assert(!fs.existsSync(root), 'Use a new synthetic fixture directory.');
const home = path.join(root, 'hub'), workspace = path.join(root, 'workspace'), profile = path.join(root, 'profile');
const dist = path.join(path.dirname(exe), 'resources/app/singularity-hub/dist');
const { HubConnection } = require(path.join(dist, 'client'));
const { SessionHistory } = require(path.join(dist, 'history'));
const runtime = path.join(dist, '../runtime/node.exe');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, '.gitattributes'), '* -text\n');
for (const name of ['sample.txt', 'removed.txt', 'old-name.txt']) { fs.writeFileSync(path.join(workspace, name), 'base\n'); }
for (let i = 0; i < 24; i++) { fs.writeFileSync(path.join(workspace, `part-${i}.txt`), 'base\n'); }
fs.writeFileSync(path.join(workspace, 'fixture.cjs'), `const fs=require('node:fs');fs.writeFileSync('sample.txt','SOLUTION-OK\\n');fs.rmSync('removed.txt');fs.renameSync('old-name.txt','renamed.txt');fs.writeFileSync('new.bin',Buffer.from([0,1,2,255]));fs.writeFileSync('large-new.txt','x'.repeat(100000));fs.mkdirSync('nested',{recursive:true});fs.writeFileSync('nested/new.txt','new\\n');for(let i=0;i<24;i++){fs.writeFileSync('part-'+i+'.txt','changed\\n');}\n`);
fs.writeFileSync(path.join(workspace, 'check.test.cjs'), `const fs=require('node:fs'),assert=require('node:assert/strict');require('node:test').test('independent solution check',()=>{assert.equal(fs.readFileSync('sample.txt','utf8'),'SOLUTION-OK\\n');assert.equal(fs.existsSync('removed.txt'),false);assert.equal(fs.readFileSync('renamed.txt','utf8'),'base\\n');assert.deepEqual(fs.readFileSync('new.bin'),Buffer.from([0,1,2,255]));assert.equal(fs.statSync('large-new.txt').size,100000);for(let i=0;i<24;i++){assert.equal(fs.readFileSync('part-'+i+'.txt','utf8'),'changed\\n');}});\n`);
const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true }).trim();
git('init', '-q'); git('add', '.'); git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', 'commit', '-qm', 'synthetic base');
const base = git('rev-parse', 'HEAD');
const env = { ...process.env, SINGULARITY_HUB_HOME: home };
let child, client, browser, page;
const port = 23000 + Math.floor(Math.random() * 5000);
const report = { base, checks: [] };
const check = (name, ok, detail) => { assert(ok, name); report.checks.push({ name, ok: true, detail }); console.log(name); };
async function until(fn, label, ms = 180000) {
	const end = Date.now() + ms;
	while (Date.now() < end) { const value = await fn(); if (value) { return value; } await ui.sleep(150); }
	throw new Error('Timed out: ' + label);
}
async function startHub() {
	child = spawn(runtime, [path.join(dist, 'main.js')], { env, windowsHide: true, stdio: 'ignore' });
	return until(async () => { try { return await HubConnection.connect({ home, clientName: 'solution-e2e' }); } catch {} }, 'packaged Hub');
}
async function doc(fn, args) {
	for (const target of (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(t => t.type === 'iframe')) {
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		try {
			await once(socket, 'open'); const reply = once(socket, 'message');
			socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(() => {const d=document.querySelector('iframe#active-frame')?.contentDocument;return d?.querySelector('#mode-comparison')?(${fn.toString()})(d,${JSON.stringify(args ?? null)}):undefined;})()`, returnByValue: true } }));
			const response = JSON.parse((await reply)[0]);
			if (response.result?.exceptionDetails) { throw new Error(response.result.exceptionDetails.text); }
			const value = response.result?.result?.value; if (value !== undefined) { return value; }
		} finally { socket.close(); }
	}
}
const list = () => client.request('comparisons.list', { workspace });
const solutions = () => client.request('solutions.list', { workspace });
const shot = name => page.screenshot({ path: path.join(root, name) });
async function button(action) {
	return until(() => doc((d, action) => { const b=d.querySelector(`[data-solution="${action}"]`);if(!b||b.disabled){return false;}b.click();return true; },action), action);
}
async function review(id) { await doc((d,id) => { const s=d.querySelector('#comparison-run');s.value=id;s.dispatchEvent(new Event('change',{bubbles:true}));return true; },id); }
async function openSolution(id) {
	await doc((d,id) => { const s=d.querySelector('[data-cmp="reviewSolution"]');if(s){s.click();return true;}return false; },id);
	await until(() => doc(d => !!d.querySelector('[data-solution="apply"]')), 'review panel');
}
function content(rootDir) {
	const entries = [];
	function walk(dir, prefix='') { for(const item of fs.readdirSync(dir,{withFileTypes:true})){if(item.name==='.git')continue;const name=prefix+item.name;if(item.isDirectory()){walk(path.join(dir,item.name),name+'/');}else{entries.push([name,crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,item.name))).digest('hex')]);}} }
	walk(rootDir); return JSON.stringify(entries.sort((a,b)=>a[0].localeCompare(b[0])));
}
async function main() {
	client = await startHub();
	ui.launch({ exe, profile, workspace, port, env, settings: { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'singularity.agents.hub.autoStart': false, 'singularity.update.checkAutomatically': false, 'workbench.colorTheme': 'Event Minimal Dark', 'window.dialogStyle': 'custom' } });
	await ui.waitPage(port); browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	page = browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('workbench'));
	await until(() => doc(d=>{d.querySelector('#mode-comparison').click();return true;}),'comparison');
	for(const [index,model] of ['sonnet','gpt-5.6-luna'].entries()){
		await until(()=>doc((d,x)=>{const s=d.querySelector(`[data-index="${x.index}"][data-field="model"]`);const o=[...s.options].find(o=>o.value.endsWith('\t'+x.model));if(!o)return false;s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}));const e=d.querySelector(`[data-index="${x.index}"][data-field="effort"]`);e.value='low';e.dispatchEvent(new Event('change',{bubbles:true}));return true;},{index,model}),'selected model');
	}
	await doc(d=>{const p=d.querySelector('#prompt');p.value="Run node fixture.cjs in this synthetic worktree, then answer DONE. If command execution is denied, use file editing tools to change sample.txt to SOLUTION-OK instead and report that limitation. Preserve fixture.cjs and check.test.cjs. This script generates the requested edits, rename, deletion and binary. Use only your worktree.";p.dispatchEvent(new Event('input',{bubbles:true}));d.querySelector('#send').click();return true;});
	let run=await until(async()=>{const r=(await list())[0];return r?.participants.every(p=>!['preparing','running'].includes(p.status))?r:undefined;},'two real providers',300000);
	check('Two real providers completed the comparison',run.participants.every(p=>p.status==='done'),run.participants.map(p=>({service:p.service,status:p.status})));
	const participant=run.participants.find(p=>p.service==='codex-cli');
	const other=run.participants.find(p=>p.id!==participant.id);const otherBefore=content(other.workspace), original=content(workspace);
	await until(()=>doc((d,id)=>{const b=d.querySelector(`[data-cmp="select"][data-participant="${id}"]`);if(!b)return false;b.click();return true;},participant.id),'choose solution');
	await until(async()=>(await list())[0].selected===participant.id,'selected');
	await until(()=>doc((d,id)=>{const b=d.querySelector(`[data-cmp="prepareSolution"][data-participant="${id}"]`);if(!b)return false;b.click();return true;},participant.id),'prepare through UI');
	let solution=await until(async()=>{const r=(await solutions()).at(-1);if(!r){const error=await doc(d=>d.querySelector('#solution-review')?.querySelector('[role=\"alert\"]')?.textContent);if(error)throw new Error(error);}return r?.state==='prepared'?r:undefined;},'prepared');
	check('Preparation preserved the main workspace exactly',content(workspace)===original&&git('status','--porcelain')==='');
	const complete=await client.request('solutions.review',{workspace,id:solution.id});
	check('Complete review includes binary, removal, rename and large new file',complete.files.some(f=>f.binary)&&complete.files.some(f=>f.kind==='removed')&&complete.files.some(f=>f.path==='large-new.txt'&&f.after.bytes===100000)&&complete.renames.includes('renamed.txt'));
	await until(()=>doc(d=>{const details=d.querySelector('.solution-diff')?.parentElement;if(!details)return false;details.open=true;return true;}),'full diff');
	await shot('revisao-dark.png');
	await button('validate');
	await page.getByRole('button',{name:'Executar testes',exact:true}).click({timeout:30000});
	solution=await until(async()=>{const r=(await solutions()).find(r=>r.id===solution.id);return r.validation.state!=='running'&&r.validation.state!=='unavailable'?r:undefined;},'independent tests');
	check('Singularity ran independent tests with actual exit zero',solution.validation.state==='passed'&&solution.validation.exitCode===0,solution.validation);
	await until(()=>doc(d=>!d.querySelector('[data-solution="apply"]')?.disabled),'confirm enabled');
	await button('apply');
	solution=await until(async()=>{const r=(await solutions()).find(r=>r.id===solution.id);return r.state==='applied'?r:undefined;},'applied');
	await until(()=>doc(d=>d.querySelector('#solution-review').textContent.includes('Aplicada ao projeto')),'application confirmation');await ui.sleep(1200);
	check('Only authorized files changed and no commit was created',git('rev-parse','HEAD')===base&&git('diff','--cached','--name-only')===''&&fs.readFileSync(path.join(workspace,'sample.txt'),'utf8')==='SOLUTION-OK\n');
	check('Binary and rename applied correctly',fs.readFileSync(path.join(workspace,'new.bin')).equals(Buffer.from([0,1,2,255]))&&!fs.existsSync(path.join(workspace,'old-name.txt'))&&fs.existsSync(path.join(workspace,'renamed.txt')));
	await shot('aplicacao.png');
	await button('undo');
	await until(async()=>(await solutions()).find(r=>r.id===solution.id).state==='rolled-back','undo');
	check('Undo restored the exact pre-application file snapshot',content(workspace)===original&&git('status','--porcelain')==='');
	await until(()=>doc(d=>d.querySelector('#solution-review').textContent.includes('Aplicação desfeita')),'undo confirmation');await ui.sleep(1200);
	await shot('rollback.png');
	await button('apply');await until(async()=>(await solutions()).find(r=>r.id===solution.id).state==='applied','reapply');
	check('Reapplication produced the same verified result',fs.readFileSync(path.join(workspace,'sample.txt'),'utf8')==='SOLUTION-OK\n');
	fs.writeFileSync(path.join(workspace,'sample.txt'),'later user edit\n');
	await button('undo');await until(()=>doc(d=>d.querySelector('#solution-error')?.textContent.includes('Conflito')),'rollback conflict');
	check('Undo preserved a later user edit',fs.readFileSync(path.join(workspace,'sample.txt'),'utf8')==='later user edit\n');
	await shot('rollback-conflito.png');
	fs.writeFileSync(path.join(workspace,'sample.txt'),'SOLUTION-OK\n');await button('undo');await until(async()=>(await solutions()).find(r=>r.id===solution.id).state==='rolled-back','safe undo');
	check('Other participant worktree remains intact',content(other.workspace)===otherBefore);
	// Kill only the Hub while it is writing the already reviewed, authorized solution.
	await button('apply');
	const journal=new SessionHistory(path.join(home,'history/solutions/records'),path.join(dist,'singularity-job.exe'),'solution');
	let interrupted;
	await until(()=>{journal.load();const turn=journal.turns(solution.id).at(-1);if(!turn)return false;const r=JSON.parse(turn.result);if(r.state==='applying'&&r.progress>0&&r.progress<r.files.length){interrupted=r.progress;child.kill();return true;}return false;},'interrupt real application');
	client.close();client=await startHub();
	solution=(await solutions()).find(r=>r.id===solution.id);
	check('Restart recovered a real interrupted transaction without duplicate application',solution.state==='rolled-back'&&content(workspace)===original,{interruptedAfterFiles:interrupted,state:solution.state});
	await ui.sleep(1500);await button('refresh');await until(()=>doc(d=>d.querySelector('#solution-review').textContent.includes('Aplicação desfeita')),'recovery UI');
	await shot('recuperacao-transacional.png');
	check('Recovery preserved HEAD, index and other participant',git('rev-parse','HEAD')===base&&git('diff','--cached','--name-only')===''&&content(other.workspace)===otherBefore);
	// Rejections are exercised through the same UI action, with synthetic edits only.
	async function prepareAgain(){await button('close');await until(()=>doc((d,id)=>{const b=d.querySelector(`[data-cmp="prepareSolution"][data-participant="${id}"]`);if(!b)return false;b.click();return true;},participant.id),'prepare again');}
	fs.writeFileSync(path.join(workspace,'preexisting.txt'),'user');await prepareAgain();await until(()=>doc(d=>d.querySelector('#solution-review').textContent.includes('preexistentes')),'dirty rejection');
	check('Dirty workspace rejected without overwriting user content',fs.readFileSync(path.join(workspace,'preexisting.txt'),'utf8')==='user');fs.unlinkSync(path.join(workspace,'preexisting.txt'));
	git('-c','user.name=E2E','-c','user.email=e2e@example.invalid','commit','--allow-empty','-qm','divergent synthetic HEAD');const divergent=git('rev-parse','HEAD');
	await prepareAgain();await until(()=>doc(d=>d.querySelector('#solution-review').textContent.includes('HEAD')),'HEAD rejection');
	check('Divergent HEAD rejected',git('rev-parse','HEAD')===divergent);git('update-ref','HEAD',base,divergent);
	const outside=path.join(root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'preserve.txt'),'preserved');fs.symlinkSync(outside,path.join(participant.workspace,'unsafe-link'),'junction');
	await prepareAgain();await until(()=>doc(d=>d.querySelector('#solution-review').textContent.includes('Links')),'unsafe path rejection');
	check('Unsafe link rejected and outside content preserved',fs.readFileSync(path.join(outside,'preserve.txt'),'utf8')==='preserved');fs.rmdirSync(path.join(participant.workspace,'unsafe-link'));
	await prepareAgain();const latest=await until(async()=>{const r=(await solutions()).at(-1);return r.id!==solution.id?r:undefined;},'new review');
	await until(()=>doc(d=>!!d.querySelector('.solution-diff')),'review ready');
	for(const [theme,name] of [['Event Minimal Light','revisao-light.png'],['Dark High Contrast','revisao-alto-contraste.png']]){
		const settingsPath=path.join(profile,'data/User/settings.json');const settings=JSON.parse(fs.readFileSync(settingsPath,'utf8'));settings['workbench.colorTheme']=theme==='Dark High Contrast'?'Default High Contrast':theme;fs.writeFileSync(settingsPath,JSON.stringify(settings));await until(()=>doc(theme==='Dark High Contrast'?d=>d.body.classList.contains('vscode-high-contrast'):d=>d.body.classList.contains('vscode-light')),'theme update');await ui.sleep(1000);await shot(name);
	}
	check('Dark Light and high contrast review captured',fs.existsSync(path.join(root,'revisao-dark.png'))&&fs.existsSync(path.join(root,'revisao-light.png'))&&fs.existsSync(path.join(root,'revisao-alto-contraste.png')));
	check('Main workspace finishes unchanged',content(workspace)===original&&git('rev-parse','HEAD')===base&&git('status','--porcelain')==='');
	report.solutionId=solution.id;report.preparedFileCount=latest.files.length;report.otherWorktreePreserved=true;
	fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log('Packaged solution application E2E passed.');
}
main().catch(error=>{console.error(error);fs.writeFileSync(path.join(root,'failure.json'),JSON.stringify({error:error.message,checks:report.checks},null,2));process.exitCode=1;}).finally(async()=>{
	if(client){await client.request('hub.shutdown',{}).catch(()=>{});client.close();}
	if(browser){await ui.closeApp(profile).catch(()=>{});await browser.close().catch(()=>{});}
	if(child?.exitCode===null){await ui.sleep(1000);if(child.exitCode===null)child.kill();}
});
