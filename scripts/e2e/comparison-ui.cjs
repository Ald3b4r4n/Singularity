'use strict';
// UI regression with synthetic catalogs. Real provider execution is covered by comparison.cjs.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
(async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		const errors = []; page.on('pageerror', e => errors.push(e.message));
		await page.setContent('<html><body><div id="app"></div></body></html>');
		await page.evaluate(() => { window.messages = []; window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage: m => window.messages.push(m) }); });
		for (const file of ['render.js', 'comparison.js', 'main.js']) { await page.addScriptTag({ path: path.resolve(__dirname, '../../extensions/singularity-agents/media', file) }); }
		const post = data => page.evaluate(data => window.postMessage(data, '*'), data);
		await post({ type: 'state', state: { hub: { status: 'connected' }, sessions: [] } });
		await page.click('#mode-comparison');
		for (const [index, service] of ['claude-code', 'codex-cli'].entries()) {
			await post({ type: 'comparisonCatalog', index, catalog: { service, providers: [{ id: service, models: [{ id: 'first', name: 'First', efforts: [] }, { id: 'second', name: 'Second', efforts: ['low', 'high'] }] }] } });
		}
		await page.selectOption('[data-index="0"][data-field="model"]', 'claude-code\tsecond');
		await page.selectOption('[data-index="0"][data-field="effort"]', 'low');
		assert.equal(await page.inputValue('[data-index="0"][data-field="model"]'), 'claude-code\tsecond');
		await page.fill('#prompt', 'One task');
		assert.equal(await page.locator('textarea:visible').count(), 1);
		assert.equal(await page.isEnabled('#send'), true);
		await page.click('#send');
		const request = await page.evaluate(() => window.messages.find(m => m.type === 'comparisonCreate'));
		assert.equal(request.participants.length, 2);
		assert.equal(request.participants[0].model.variant, 'low');
		assert.equal(request.text, 'One task');
		const run = { id: 'run', prompt: 'One task', base: 'a'.repeat(40), createdAt: Date.now(), participants: request.participants.map((p, i) => ({ ...p, id: String(i), sessionId: String(i), status: 'running' })) };
		await post({ type: 'comparisonReply', operation: 'comparisonCreate', result: run });
		await page.locator('.comparison-card').first().waitFor();
		assert.equal(await page.locator('.comparison-card').count(), 2);
		await page.click('.comparison-card button[data-cmp="cancel"] >> nth=0');
		assert((await page.evaluate(() => window.messages)).some(m => m.type === 'comparisonCancel' && m.participantId === '0'));
		await page.click('#send');
		assert((await page.evaluate(() => window.messages)).some(m => m.type === 'comparisonCancel' && !m.participantId));
		await post({ type: 'comparisonReply', operation: 'comparisonInspect', result: { participant: { id: '0' }, files: 'sample.txt', diff: '<script>bad()</script>', untracked: '', tests: 'Not independently run' } });
		await page.locator('.comparison-diff').waitFor();
		assert.match(await page.locator('.comparison-diff').textContent(), /<script>/);
		assert.equal(await page.locator('.comparison-diff script').count(), 0);
		await page.click('#mode-single');
		assert.equal(await page.isVisible('#comparison-config'), false);
		assert.equal(await page.inputValue('#prompt'), 'One task');
		assert.deepEqual(errors, []);
		console.log('Comparison UI passed: single composer, explicit launch, model/effort, two cards, individual/all cancellation, escaped diff, mode switch and draft preservation.');
	} finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

