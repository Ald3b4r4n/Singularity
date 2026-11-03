'use strict';
// Run: node --test test/   (plain filesystem, no Git needed)
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('fs'), os = require('os'), path = require('path');
const pub = require('../publish.js');

describe('repository mode matching uses real locations', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modes-'));
	const sub = path.join(dir, 'ws');
	const other = path.join(dir, 'other');
	fs.mkdirSync(sub); fs.mkdirSync(other);

	it('the same folder is automatic whatever the spelling (trailing separator, .., upper case)', () => {
		const options = { defaultMode: 'assisted', automaticRepositories: [sub] };
		for (const spelling of [sub, sub + path.sep, path.join(sub, '..', 'ws'), sub.toUpperCase()]) {
			assert.equal(pub.modeFor(spelling, options), 'automatic', spelling);
		}
	});

	it('a Windows 8.3 short name and the long name are the same folder', { skip: process.platform !== 'win32' || !sub.includes('~') }, () => {
		// os.tmpdir() on this machine is already in 8.3 form (C:\Users\ANTONI~1\...): the setting may hold that form,
		// while git reports the long form. Both must select the same mode.
		const longForm = fs.realpathSync.native(sub);
		assert.notEqual(longForm, sub, 'the short and long forms are different spellings');
		assert.equal(pub.modeFor(longForm, { defaultMode: 'assisted', automaticRepositories: [sub] }), 'automatic');
		assert.equal(pub.modeFor(sub, { defaultMode: 'assisted', automaticRepositories: [longForm] }), 'automatic');
	});

	it('other folders keep the default, and a default can never be automatic', () => {
		assert.equal(pub.modeFor(other, { defaultMode: 'assisted', automaticRepositories: [sub] }), 'assisted');
		assert.equal(pub.modeFor(other, { defaultMode: 'automatic', automaticRepositories: [] }), 'manual');
	});

	it('cleanup', () => { fs.rmSync(dir, { recursive: true, force: true }); });
});
