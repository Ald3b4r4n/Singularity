/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { SessionHistory } from '../history';
import { Session } from '../protocol';
import { cleanup, tempHome } from './helpers';

describe('protected session history', () => {
	it('retains the last 20 large turns across reloads and deletes them promptly', () => {
		const home = tempHome('history-large');
		const directory = join(home, 'history');
		const helper = join(__dirname, '..', 'singularity-job.exe');
		const id = '7e2a64e1-0e6f-4f8c-a836-ebbd1a4ddda1';
		const session: Session = { id, harness: 'opencode', title: 'OpenCode', status: 'done', workspace: 'C:\\workspace', historical: true, updatedAt: Date.now() };
		const started = performance.now();
		try {
			const history = new SessionHistory(directory, helper);
			for (let index = 0; index < 25; index++) {
				history.save(session, { prompt: `pergunta-${index}`, result: `resultado-${index}-` + 'x'.repeat(12_000), status: 'done', at: index });
			}
			const reloaded = new SessionHistory(directory, helper);
			reloaded.load();
			const turns = reloaded.turns(id);
			assert.deepEqual(turns.map(turn => [turn.prompt, turn.result?.startsWith(`resultado-${turn.at}-`), turn.result?.length, turn.at]), Array.from({ length: 20 }, (_, offset) => {
				const index = offset + 5;
				return [`pergunta-${index}`, true, 12_000 + `resultado-${index}-`.length, index];
			}));
			assert.deepEqual(reloaded.list().map(item => item.id), [id]);
			reloaded.delete(id);
			assert.equal(existsSync(join(directory, id + '.dpapi')), false);
			assert.equal(reloaded.turns(id).length, 0);
			assert.ok(performance.now() - started < 30_000, 'large encrypted history operations exceeded 30 seconds');
		} finally {
			cleanup(home);
		}
	});
});
