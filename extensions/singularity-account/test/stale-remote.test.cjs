'use strict';
// Run: node --test test/stale-remote.test.cjs   (pure decisions; no network and no Git needed)
//
// When the fetch of the upstream fails (offline, no permission), the Singularity does not know the real state of the remote.
// It must not push, and must not offer to push, on that stale knowledge: the commits stay local and the user is told why.
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const pub = require('../publish.js');

const state = (extra = {}) => ({ isRepo: true, hasUpstream: true, ahead: 2, behind: 0, ...extra });

describe('a failed fetch means the remote state is unknown', () => {
	for (const fetchError of ['offline', 'auth', 'remote-error', 'error']) {
		for (const mode of ['automatic', 'assisted']) {
			it(`${mode}: fetch ${fetchError} -> report, never push or ask`, () => {
				const d = pub.decide(mode, state({ fetchError }));
				assert.equal(d.action, 'report');
				assert.equal(d.reason, 'fetch-failed');
			});
		}
	}

	it('manual mode still does nothing (it never fetches, and never pushes by itself)', () => {
		assert.deepEqual(pub.decide('manual', state({ fetchError: 'offline' })), { action: 'none', reason: 'manual' });
	});

	it('without a fetch error the decisions are unchanged', () => {
		assert.equal(pub.decide('automatic', state()).action, 'push');
		assert.equal(pub.decide('assisted', state()).action, 'ask');
		assert.equal(pub.decide('automatic', state({ behind: 1 })).reason, 'diverged');
		assert.equal(pub.decide('automatic', state({ ahead: 0, fetchError: 'offline' })).reason, 'up-to-date');
	});
});
