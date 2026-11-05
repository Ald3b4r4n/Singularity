'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const path = require('node:path');
(async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
		await page.setContent('<div id="app"><main><div id="results"></div></main><form id="composer"></form></div>');
		await page.evaluate(() => { window.messages = []; window.vscode = { postMessage: m => window.messages.push(m) }; });
		for (const file of ['render.js', 'solution.js']) { await page.addScriptTag({ path: path.resolve(__dirname, '../../extensions/singularity-agents/media', file) }); }
		await page.evaluate(() => { window.solution = window.SingularitySolution(window.vscode, window.SingularityAgentsRender, document.getElementById('results')); });
		const record = { id: 'solution', state: 'prepared', provider: 'codex-cli', model: { modelID: 'test' }, base: 'a'.repeat(40), integrity: true, patchHash: 'hash', validation: { state: 'unavailable' }, files: [{ path: '<unsafe>.txt', kind: 'added', binary: true, after: { bytes: 100000 } }], counts: { added: 1 }, diff: '<script>bad()</script>' };
		const post = record => page.evaluate(record => window.postMessage({ type: 'solutionReview', record }, '*'), record);
		await post(record); await page.locator('[data-solution="apply"]').waitFor();
		assert.equal(await page.isDisabled('[data-solution="apply"]'), true);
		assert.equal((await page.evaluate(() => window.messages)).length, 0);
		await page.check('#solution-untested'); await page.click('[data-solution="apply"]');
		assert((await page.evaluate(() => window.messages)).some(m => m.type === 'solutionApply' && m.patchHash === 'hash' && m.allowUntested));
		await post({ ...record, validation: { state: 'failed', exitCode: 7, output: 'failure' } });
		await page.waitForFunction(() => document.querySelector('#solution-test-status').textContent.includes('7'));
		assert.equal(await page.isDisabled('[data-solution="apply"]'), true);
		assert.equal(await page.locator('.solution-diff script').count(), 0);
		await post({ ...record, state: 'applied', validation: { state: 'passed', exitCode: 0 } });
		await page.waitForFunction(() => !document.querySelector('[data-solution="undo"]').disabled);
		await page.click('[data-solution="undo"]');
		assert((await page.evaluate(() => window.messages)).some(m => m.type === 'solutionUndo' && m.id === 'solution'));
		assert.deepEqual(errors, []);
		console.log('Solution UI passed: complete review, explicit confirmation, test failure gate, escaped diff, unavailable-test consent and undo.');
	} finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
