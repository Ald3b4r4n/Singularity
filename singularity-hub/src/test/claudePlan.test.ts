import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { claudePlan } from '../claudePlan';

const SECRET = 'sk-ant-oat-synthetic-secret-value';

function homeWith(credentials?: object): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-claude-plan-'));
	if (credentials) { fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify(credentials)); }
	return home;
}

describe('Claude plan windows (opt-in, own login only)', () => {
	const now = Date.parse('2026-11-09T15:00:00Z');

	it('reads the 5 hour and weekly windows with the login on this computer, and sends the token only to the fetcher', async () => {
		let seen = '';
		const result = await claudePlan({
			home: homeWith({ claudeAiOauth: { accessToken: SECRET, expiresAt: now + 3_600_000, subscriptionType: 'pro' } }), now,
			fetcher: async token => { seen = token; return { status: 200, body: JSON.stringify({ five_hour: { utilization: 9, resets_at: '2026-11-09T22:00:00+00:00' }, seven_day: { utilization: 6.04, resets_at: '2026-11-16T10:00:00+00:00' } }) }; }
		});
		assert.equal(seen, SECRET);
		assert.ok('plan' in result);
		if ('plan' in result) {
			assert.deepEqual(result.plan.windows.map(item => [item.label, item.usedPercent]), [['Limite de 5 horas', 9], ['Semanal · todos os modelos', 6]]);
			assert.equal(result.plan.name, 'Pro');
			assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET), 'the token never reaches the result');
		}
	});

	it('does nothing without a login, and does not call anything for an expired one', async () => {
		let calls = 0;
		const fetcher = async () => { calls++; return { status: 200, body: '{}' }; };
		assert.ok('unavailable' in await claudePlan({ home: homeWith(), now, fetcher }));
		assert.ok('unavailable' in await claudePlan({ home: homeWith({ claudeAiOauth: { accessToken: SECRET, expiresAt: now - 1 } }), now, fetcher }));
		assert.equal(calls, 0);
	});

	it('turns a rejected login, a rate limit and a network failure into plain messages without leaking the body', async () => {
		const home = homeWith({ claudeAiOauth: { accessToken: SECRET, expiresAt: now + 1000 } });
		for (const status of [401, 429, 500]) {
			const result = await claudePlan({ home, now, fetcher: async () => ({ status, body: SECRET }) });
			assert.ok('unavailable' in result);
			assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
		}
		const failed = await claudePlan({ home, now, fetcher: async () => { throw new Error(SECRET); } });
		assert.ok('unavailable' in failed);
		assert.doesNotMatch(JSON.stringify(failed), new RegExp(SECRET));
	});
});
