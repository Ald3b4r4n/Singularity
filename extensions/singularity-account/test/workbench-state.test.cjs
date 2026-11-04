'use strict';
// Run: node --test test/workbench-state.test.cjs   (no network)
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('fs'), path = require('path');

const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const section = ext.slice(ext.indexOf('function setContext'), ext.indexOf('function activate'));

describe('state published to the workbench (title bar account entry)', () => {
	it('publishes only public values', () => {
		const keys = [...section.matchAll(/setContext\('(singularity\.account\.[A-Za-z]+)'/g)].map(m => m[1]).sort();
		assert.deepEqual(keys, ['singularity.account.avatar', 'singularity.account.login', 'singularity.account.name', 'singularity.account.publishAuthorized', 'singularity.account.ready', 'singularity.account.signedIn']);
	});

	it('no token, secret or authorization header is read or published in that code', () => {
		assert.equal(/secrets|TOKEN_KEY|PUBLISH_KEY|accessToken|Authorization/.test(section), false);
	});

	it('the publishing state is a boolean, never the publish token', () => {
		assert.ok(section.includes("'singularity.account.publishAuthorized', !!account && !!publishAuthorized"));
	});

	it('the avatar is limited to a small image read from the extension\'s own cache', () => {
		assert.ok(section.includes('256 * 1024'));
		assert.ok(/image\/png/.test(section) && /image\/jpeg/.test(section));
	});

	it('every state change goes through render(), which republishes the state', () => {
		assert.ok(ext.includes('publishContext(account, publish, avatar);'));
		const changed = (ext.match(/changed\(\)/g) || []).length;
		assert.ok(changed >= 4, 'sign in, authorize, revoke and sign out call changed(): ' + changed);
	});
});
