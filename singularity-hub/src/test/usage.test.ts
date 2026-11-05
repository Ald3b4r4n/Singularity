import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reportedUsage } from '../usage';
test('provider usage only exposes explicitly reported finite numeric fields and preserves zero', () => {
	assert.deepEqual(reportedUsage({ input_tokens: 12, output_tokens: 0, cached_input_tokens: 3, apiKey: 'secret', rate: 9 }, 0), { inputTokens: 12, outputTokens: 0, cachedInputTokens: 3, costUsd: 0 });
	assert.equal(reportedUsage({ input_tokens: '12', output_tokens: -1, cached_input_tokens: NaN }, Infinity), undefined);
	assert.equal(reportedUsage(undefined), undefined);
});
