import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { usageReport } from '../usageReport';

describe('usage report', () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-usage-'));
	const now = Date.parse('2026-11-09T15:00:00Z');
	const iso = (hoursAgo: number): string => new Date(now - hoursAgo * 3_600_000).toISOString();
	fs.mkdirSync(path.join(home, '.claude', 'projects', 'p'), { recursive: true });
	fs.mkdirSync(path.join(home, '.codex', 'sessions', '2026', '11'), { recursive: true });
	const claudeLine = (id: string, hoursAgo: number, input: number, output: number): string => JSON.stringify({ type: 'assistant', timestamp: iso(hoursAgo), requestId: 'r' + id, message: { id: 'm' + id, model: 'claude-synthetic-1', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 } } });
	fs.writeFileSync(path.join(home, '.claude', 'projects', 'p', 's.jsonl'), [claudeLine('1', 1, 100, 50), claudeLine('1', 1, 100, 50), claudeLine('2', 24 * 5, 10, 5), claudeLine('3', 24 * 40, 999, 999)].join('\n') + '\n');
	fs.writeFileSync(path.join(home, '.codex', 'sessions', '2026', '11', 'r.jsonl'), [
		JSON.stringify({ timestamp: iso(2), type: 'turn_context', payload: { model: 'gpt-synthetic' } }),
		JSON.stringify({ timestamp: iso(2), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 40, reasoning_output_tokens: 5 } }, rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1794082963 }, secondary: { used_percent: 84, window_minutes: 10080, resets_at: 1794388262 }, plan_type: 'plus' } } })
	].join('\n') + '\n');
	fs.utimesSync(path.join(home, '.claude', 'projects', 'p', 's.jsonl'), new Date(now), new Date(now));
	fs.utimesSync(path.join(home, '.codex', 'sessions', '2026', '11', 'r.jsonl'), new Date(now), new Date(now));
	const report = usageReport({ home, now });
	const service = (id: string) => report.services.find(item => item.id === id)!;

	it('counts Claude Code tokens once per message and only inside each period', () => {
		const claude = service('claude-code');
		assert.equal(claude.today.input, 100);
		assert.equal(claude.today.messages, 1);
		assert.equal(claude.week.input, 110);
		assert.equal(claude.month.input, 110, 'a message older than 30 days is left out');
		assert.equal(claude.month.cacheRead, 2000);
		assert.equal(claude.month.cost, undefined, 'no cost is invented');
	});

	it('reads the Codex session total without counting the cached input twice, and the plan windows it reported', () => {
		const codex = service('codex-cli');
		assert.equal(codex.month.input, 300);
		assert.equal(codex.month.cacheRead, 200);
		assert.equal(codex.month.output, 40);
		assert.deepEqual(codex.plan?.windows.map(item => [item.label, item.usedPercent]), [['Janela de 5 horas', 12.5], ['Janela semanal', 84]]);
		assert.equal(codex.plan?.name, 'plus');
	});

	it('always lists OpenCode Go and OpenCode Zen, says when the plan limit is not recorded, and holds no path or prompt', () => {
		assert.ok(service('opencode-go') && service('opencode-zen'));
		assert.match(service('opencode-go').note ?? '', /OpenCode/);
		assert.doesNotMatch(JSON.stringify(report), /singularity-usage-|\.jsonl|[A-Za-z]:\\/);
	});
});
