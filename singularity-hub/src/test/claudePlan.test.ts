import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudePlan, parseUsageText } from '../claudePlan';

const SAMPLE = [
	'You are currently using your subscription to power your Claude Code usage',
	'',
	'Current session: 12% used · resets Nov 9, 6:59pm (America/Sao_Paulo)',
	'Current week (all models): 7% used · resets Nov 16, 6:59am (America/Sao_Paulo)',
	'Current week (Sonnet only): 1.5% used · resets Nov 16, 6:59am (America/Sao_Paulo)',
	'',
	'What\'s contributing to your limits usage?'
].join('\n');

describe('Claude plan windows (opt-in, from Claude Code\'s own /usage)', () => {
	it('turns the /usage report into the 5 hour and weekly windows', () => {
		const windows = parseUsageText(SAMPLE);
		assert.deepEqual(windows.map(item => [item.label, item.usedPercent]), [['Limite de 5 horas', 12], ['Semanal · todos os modelos', 7], ['Semanal · Sonnet', 1.5]]);
		assert.match(windows[0].resetsText ?? '', /Nov 9, 6:59pm/);
	});

	it('ignores everything that is not a window and keeps percentages inside 0-100', () => {
		assert.deepEqual(parseUsageText('nothing here\nCurrent session: 250% used'), [{ label: 'Limite de 5 horas', usedPercent: 100 }]);
		assert.deepEqual(parseUsageText(''), []);
	});

	it('uses only the runner it is given: no credential is read and nothing is fetched', async () => {
		const ok = await claudePlan({ runner: async () => SAMPLE });
		assert.ok('plan' in ok && ok.plan.windows.length === 3);
		assert.ok('unavailable' in await claudePlan({ runner: async () => undefined }));
		assert.ok('unavailable' in await claudePlan({ runner: async () => { throw new Error('boom'); } }));
		assert.ok('unavailable' in await claudePlan({ runner: async () => 'Not logged in' }));
	});
});
