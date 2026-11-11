'use strict';
// IDE panel, Team mode: after a team delivered, the chat has a send button that answers it; while it works the box says so;
// a new team and the deletion of a team are separate buttons, never the label of the send button. Synthetic data, no provider.
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
		for (const file of ['render.js', 'solution.js', 'team.js', 'comparison.js', 'main.js']) { await page.addScriptTag({ path: path.resolve(__dirname, '../../extensions/singularity-agents/media', file) }); }
		const post = data => page.evaluate(data => window.postMessage(data, '*'), data);
		const sent = type => page.evaluate(type => window.messages.filter(m => m.type === type), type);
		const state = { hub: { status: 'connected' }, sessions: [] };
		const role = (service, modelID) => ({ service, model: { providerID: service, modelID } });
		const team = (overrides = {}) => ({ id: 'team-1', task: 'Criar a página', roles: [role('opencode', 'a'), role('opencode', 'b'), role('opencode', 'c')], createdAt: Date.now() - 60000, updatedAt: Date.now(), state: 'completed', phase: 'validation', cycle: 0, maxCorrections: 2,
			steps: [{ role: 'implementer', version: 1, status: 'done', startedAt: 1, endedAt: 2 }], versions: [{ number: 1, comparisonId: 'c', solutionId: 's', tree: 't'.repeat(40), patchHash: 'h' }], ...overrides });
		await post({ type: 'state', state });
		await page.click('#mode-team');
		const label = async () => (await page.textContent('#send')).trim();

		// a team that is working: the box says so, and the one button cancels
		await post({ type: 'teams', runs: [team({ state: 'running', phase: 'implementer', versions: [], steps: [{ role: 'implementer', version: 1, status: 'sent', startedAt: 1 }] })], state });
		await page.waitForFunction(() => document.getElementById('send').textContent.includes('Cancelar equipe'));
		assert.equal(await page.isDisabled('#prompt'), true, 'nothing can be typed to a team that is working');
		assert.match(await page.getAttribute('#prompt', 'placeholder'), /trabalhando/);

		// delivered: the chat box is open and the button is "Enviar", disabled until there is something to send
		await post({ type: 'teams', runs: [team()], state });
		await page.waitForFunction(() => document.getElementById('send').textContent.trim() === 'Enviar');
		assert.equal(await page.isDisabled('#prompt'), false);
		assert.equal(await page.isDisabled('#send'), true, 'no empty instruction');
		assert.match(await page.getAttribute('#prompt', 'placeholder'), /Responda à equipe/);
		assert.match(await page.textContent('#note'), /Implementador sobre a versão atual/);
		await page.fill('#prompt', 'Publique também o resultado.');
		assert.equal(await page.isDisabled('#send'), false, 'the send button appears as soon as there is text');
		assert.equal(await label(), 'Enviar');
		await page.click('#send');
		let instructions = await sent('teamInstruct');
		assert.equal(instructions.length, 1); assert.equal(instructions[0].id, 'team-1'); assert.equal(instructions[0].text, 'Publique também o resultado.');
		assert.equal((await sent('teamCancel')).length, 0, 'the send button never cancels a team that delivered');
		assert.equal(await label(), 'Aguarde…'); await page.click('#send', { force: true }).catch(() => undefined);
		assert.equal((await sent('teamInstruct')).length, 1, 'a second tap while waiting sends nothing');
		// the Hub answered: the box is cleared and the team works again
		await post({ type: 'teamReply', operation: 'teamInstruct', result: team({ state: 'running', phase: 'implementer', cycle: 1 }) });
		await post({ type: 'teams', runs: [team({ state: 'running', phase: 'implementer', cycle: 1 })], state });
		await page.waitForFunction(() => document.getElementById('send').textContent.includes('Cancelar equipe'));
		assert.equal(await page.inputValue('#prompt'), '', 'the instruction left the box');

		// exhausted (cycles used up) can be answered too; awaiting validation as well
		for (const stateName of ['exhausted', 'awaiting-validation']) {
			await post({ type: 'teams', runs: [team({ state: stateName })], state });
			await page.waitForFunction(() => document.getElementById('send').textContent.trim() === 'Enviar');
		}
		// failed or cancelled has no version to build on: the button starts a new team, as before
		await post({ type: 'teams', runs: [team({ state: 'cancelled', versions: [] })], state });
		await page.waitForFunction(() => document.getElementById('send').textContent.trim() === 'Nova equipe');

		// a new team and the deletion are their own buttons next to the other actions
		await post({ type: 'teams', runs: [team()], state });
		await page.waitForSelector('button[data-team="new"]');
		assert.equal(await page.locator('button[data-team="delete"]').count(), 1);
		await page.click('button[data-team="delete"]');
		assert.equal((await sent('teamDelete')).length, 1); assert.equal((await sent('teamDelete'))[0].id, 'team-1');
		await page.click('button[data-team="new"]');
		await page.waitForFunction(() => document.getElementById('send').textContent.trim() === 'Iniciar equipe');
		assert.equal(await page.locator('#team-config:visible').count(), 1, 'the form of a new team opens');
		// leaving team mode gives the box back
		await page.click('#mode-single');
		assert.equal(await page.isDisabled('#prompt'), false);
		assert.equal(await page.getAttribute('#prompt', 'placeholder'), 'Descreva o que deseja desenvolver…');
		assert.deepEqual(errors, []);
		console.log('Team IDE UI passed: working team locks the box, a delivered team is answered with a send button, exhausted and awaiting-validation too, a new team and deletion are separate buttons.');
	} finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
