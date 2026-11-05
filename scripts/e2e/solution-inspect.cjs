'use strict';
// Revalidates an existing real solution through the UI and captures application, undo and themes without starting agents.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');
const WebSocket = require('../../singularity-hub/node_modules/ws');
const ui = require('./lib.cjs');
const exe=path.resolve(process.argv[2]), root=path.resolve(process.argv[3]);
const dist=path.join(path.dirname(exe),'resources/app/singularity-hub/dist');
const {HubConnection}=require(path.join(dist,'client'));
const home=path.join(root,'hub'),workspace=path.join(root,'workspace'),profile=path.join(root,'inspection-profile');
const port=29000+Math.floor(Math.random()*3000);
let child,client,browser;
async function until(fn){for(let i=0;i<300;i++){const v=await fn();if(v)return v;await ui.sleep(200);}throw new Error('Visual verification timed out.');}
async function doc(fn){for(const t of (await(await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(t=>t.type==='iframe')){const s=new WebSocket(t.webSocketDebuggerUrl);try{await once(s,'open');const reply=once(s,'message');s.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(()=>{const d=document.querySelector('iframe#active-frame')?.contentDocument;return d?.querySelector('#mode-comparison')?(${fn.toString()})(d):undefined;})()`,returnByValue:true}}));const v=JSON.parse((await reply)[0]).result?.result?.value;if(v!==undefined)return v;}finally{s.close();}}}
(async()=>{
	child=spawn(path.join(dist,'../runtime/node.exe'),[path.join(dist,'main.js')],{env:{...process.env,SINGULARITY_HUB_HOME:home},windowsHide:true,stdio:'ignore'});
	client=await until(async()=>{try{return await HubConnection.connect({home,clientName:'solution-visual'});}catch{}});
	const settingsFile=path.join(profile,'data/User/settings.json');if(fs.existsSync(settingsFile)){const settings=JSON.parse(fs.readFileSync(settingsFile,'utf8'));settings['workbench.colorTheme']='Event Minimal Dark';settings['window.dialogStyle']='custom';fs.writeFileSync(settingsFile,JSON.stringify(settings));}
	ui.launch({exe,profile,workspace,port,env:{SINGULARITY_HUB_HOME:home},settings:{'security.workspace.trust.enabled':false,'workbench.startupEditor':'none','singularity.agents.hub.autoStart':false,'singularity.update.checkAutomatically':false,'workbench.colorTheme':'Event Minimal Dark','window.dialogStyle':'custom'}});
	await ui.waitPage(port);browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('workbench'));
	await until(()=>doc(d=>{d.querySelector('#mode-comparison').click();return true;}));
	await until(()=>doc(d=>{const b=d.querySelector('[data-cmp="reviewSolution"]');if(!b)return false;b.click();return true;}));
	await until(()=>doc(d=>!!d.querySelector('.solution-diff')));
	await doc(d=>{d.querySelector('.list').scrollTop=0;return true;});
	const entriesBefore=await client.request('solutions.list',{workspace});
	const selected=entriesBefore.at(-1);
	const mainGit=(...args)=>execFileSync('git',['-C',workspace,...args],{encoding:'utf8',windowsHide:true}).trim();
	if(selected.validation.state!=='passed'){
	await until(()=>doc(d=>{const b=d.querySelector('[data-solution="validate"]');if(!b||b.disabled)return false;b.click();return true;}));
	await page.getByRole('button',{name:'Executar testes',exact:true}).click();
	await until(async()=>{const r=(await client.request('solutions.list',{workspace})).find(r=>r.id===selected.id);return r.validation.state==='passed';});
	}
	await until(()=>doc(d=>{const b=d.querySelector('[data-solution="apply"]');if(!b||b.disabled)return false;b.click();return true;}));
	await until(async()=>(await client.request('solutions.list',{workspace})).find(r=>r.id===selected.id).state==='applied');
	await until(()=>doc(d=>d.querySelector('#solution-review').textContent.includes('Aplicada ao projeto')));await ui.sleep(1200);
	const changed=[...mainGit('diff','--name-only','-z').split('\0'),...mainGit('ls-files','--others','--exclude-standard','-z').split('\0')].filter(Boolean).sort();
	if(JSON.stringify(changed)!==JSON.stringify(selected.files.map(f=>f.path).sort()))throw new Error('Unexpected project files changed.');
	await doc(d=>{d.querySelector('.list').scrollTop=0;return true;});await page.screenshot({path:path.join(root,'aplicacao.png')});
	await doc(d=>{d.querySelector('.solution-validation').scrollIntoView({block:'start'});return true;});await page.screenshot({path:path.join(root,'validacao-independente.png')});
	await doc(d=>{d.querySelector('[data-solution="undo"]').click();return true;});
	await until(async()=>(await client.request('solutions.list',{workspace})).find(r=>r.id===selected.id).state==='rolled-back');
	await until(()=>doc(d=>d.querySelector('#solution-review').textContent.includes('Aplicação desfeita')));await ui.sleep(1200);
	await doc(d=>{d.querySelector('.list').scrollTop=0;return true;});await page.screenshot({path:path.join(root,'rollback.png')});
	for(const [theme,name] of [['Event Minimal Light','revisao-light.png'],['Dark High Contrast','revisao-alto-contraste.png']]){
		const settingsPath=path.join(profile,'data/User/settings.json');const settings=JSON.parse(fs.readFileSync(settingsPath,'utf8'));settings['workbench.colorTheme']=theme==='Dark High Contrast'?'Default High Contrast':theme;fs.writeFileSync(settingsPath,JSON.stringify(settings));
		await until(()=>doc(theme==='Dark High Contrast'?d=>d.body.classList.contains('vscode-high-contrast'):d=>d.body.classList.contains('vscode-light')));await ui.sleep(1000);
		await page.screenshot({path:path.join(root,name)});
	}
	const git=(...args)=>execFileSync('git',['-C',workspace,...args],{encoding:'utf8',windowsHide:true}).trim();
	const comparisons=await client.request('comparisons.list',{workspace});
	const base=comparisons[0].base;
	if(git('status','--porcelain')!==''||git('rev-parse','HEAD')!==base)throw new Error('Main workspace was not restored.');
	const entries=execFileSync('git',['-C',workspace,'ls-tree','-rz',base],{windowsHide:true}).toString().split('\0').filter(Boolean);
	for(const entry of entries){const match=/^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(entry);if(!match)throw new Error('Unsupported baseline');const expected=execFileSync('git',['-C',workspace,'cat-file','blob',match[1]],{windowsHide:true});if(!expected.equals(fs.readFileSync(path.join(workspace,match[2]))))throw new Error('Baseline bytes differ.');}
	const previous=JSON.parse(fs.readFileSync(path.join(root,'failure.json'),'utf8'));
	const checks=previous.checks;
	checks.push({name:'Final packaged application changed exactly the complete authorized manifest',ok:true,files:changed.length});
	checks.push({name:'Final packaged independent tests passed and UI undo completed',ok:true});
	checks.push({name:'Dark Light and high contrast review captured',ok:true});
	checks.push({name:'Main workspace matches every baseline blob and HEAD after recovery and undo',ok:true});
	const prepared=await client.request('solutions.list',{workspace});
	const recovery=checks.find(c=>c.name.startsWith('Restart recovered'));
	if(!recovery?.ok)throw new Error('Missing real interruption evidence.');
	fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({base,checks,preparedFileCount:prepared.at(-1).files.length,transactionStates:prepared.map(r=>({id:r.id,state:r.state,validation:r.validation.state,progress:r.progress})),baselineFilesVerified:entries.length},null,2));
	console.log('Dark, Light and high-contrast packaged review passed. Every main-workspace baseline blob is unchanged.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(client){await client.request('hub.shutdown',{}).catch(()=>{});client.close();}if(browser){await ui.closeApp(profile).catch(()=>{});await browser.close().catch(()=>{});}if(child?.exitCode===null){await ui.sleep(1000);if(child.exitCode===null)child.kill();}});
