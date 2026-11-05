'use strict';
const assert=require('node:assert/strict');const path=require('node:path');const {chromium}=require('playwright');
(async()=>{const browser=await chromium.launch({headless:true});try{
	const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setContent('<div id="app"></div>');
	await page.evaluate(()=>{window.messages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState(){},postMessage:m=>window.messages.push(m)});});
	for(const file of ['render.js','solution.js','team.js','comparison.js','main.js']){await page.addScriptTag({path:path.resolve(__dirname,'../../extensions/singularity-agents/media',file)});}
	const post=data=>page.evaluate(data=>window.postMessage(data,'*'),data);
	await post({type:'state',state:{hub:{status:'connected'},sessions:[]}});await page.click('#mode-team');
	await post({type:'teams',runs:[],state:{hub:{status:'connected'},sessions:[]}});
	for(let index=0;index<3;index++){await post({type:'teamCatalog',index,catalog:{service:'opencode',services:[{id:'opencode',status:'available'},{id:'claude-code',status:'available'},{id:'codex-cli',status:'available'}],providers:[{id:'opencode',models:[{id:'real-catalog-model',name:'Catalog model',efforts:['low']}]}]}});}
	await page.fill('#prompt','A single shared task');await page.selectOption('[data-team-index="1"][data-team-field="effort"]','low');await page.click('#send');
	const request=await page.evaluate(()=>window.messages.find(m=>m.type==='teamStart'));assert.equal(request.participants.length,3);assert(request.participants.every(p=>p.service==='opencode'));assert.equal(request.participants[1].model.variant,'low');assert.equal(request.maxCorrections,2);
	const run={id:'team',task:request.text,roles:request.participants,createdAt:Date.now(),updatedAt:Date.now(),phase:'implementer',cycle:0,maxCorrections:2,state:'running',steps:[{role:'implementer',sessionId:'impl',status:'sent',startedAt:Date.now()}],versions:[]};
	await post({type:'teamReply',result:run});await post({type:'teams',runs:[run],state:{hub:{status:'connected'},sessions:[{id:'impl',status:'running',result:'Real streamed text'}]}});
	await page.locator('[data-team="cancel-role"]').waitFor();assert.equal(await page.locator('textarea:visible').count(),1);assert.equal(await page.locator('.team-role').count(),3);assert.equal(await page.locator('.team-live').textContent(),'Real streamed text');
	await post({type:'teams',runs:[run,{...run,id:'other',task:'Another historical team'}],state:{hub:{status:'connected'},sessions:[]}});
	await page.selectOption('#team-history','team');await post({type:'teamReply',result:{id:'prepared-solution',state:'prepared'}});
	assert.equal(await page.inputValue('#team-history'),'team','Preparing a solution must preserve the selected team history.');
	await post({type:'teams',runs:[run],state:{hub:{status:'connected'},sessions:[]}});
	await page.click('[data-team="cancel-role"]');assert((await page.evaluate(()=>window.messages)).some(m=>m.type==='teamCancel'&&m.role==='implementer'));
	await page.setViewportSize({width:350,height:800});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
	await post({type:'teams',runs:[{...run,state:'completed',finishedAt:run.createdAt+2100,updatedAt:run.updatedAt+1,chosen:false,steps:[],versions:[{number:1,tree:'a'.repeat(40),review:{verdict:'approve',summary:'Checked actual files',issues:[]},testPlan:{verdict:'approve',summary:'Agent opinion',issues:[]},validation:{state:'passed',exitCode:0,output:'actual tests'}}]}],state:{hub:{status:'connected'},sessions:[]}});
	await page.waitForFunction(()=>document.querySelector('#team-time')?.textContent==='2 s');await page.locator('[data-team="choose"]').waitFor();assert.equal(await page.isDisabled('[data-team="prepare"]'),true);await page.click('[data-team="choose"]');assert((await page.evaluate(()=>window.messages)).some(m=>m.type==='teamChoose'));
	await page.click('#mode-single');assert.equal(await page.isVisible('#team-results'),false);assert.equal(await page.inputValue('#prompt'),'A single shared task');assert.deepEqual(errors,[]);
	console.log('Team UI passed: three catalog-backed roles, same-model reuse, one composer, live output, individual cancellation, explicit selection, 350px layout and mode preservation.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
