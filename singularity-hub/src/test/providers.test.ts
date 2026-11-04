import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { codexExecutable } from '../codex';
import { claudeExecutable } from '../claude';
import { openCodeExecutable } from '../opencode';

test('provider detection does not resolve relative configured executables or search relative PATH entries', () => {
	for (const [resolve, setting] of [
		[codexExecutable, 'SINGULARITY_CODEX_CLI'],
		[claudeExecutable, 'SINGULARITY_CLAUDE_CODE'],
		[openCodeExecutable, 'SINGULARITY_OPENCODE']
	] as const) {
		assert.equal(resolve({ [setting]: 'relative.exe', PATH: '.' }), undefined);
		assert.equal(resolve({ PATH: '.' }), undefined);
	}
});
