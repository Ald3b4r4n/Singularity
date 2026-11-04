'use strict';
// Run: node --test test/no-ambient-credentials.test.cjs   (no network)
//
// The publishing authorization of the Singularity is the only credential used for github.com. Without it nothing touches
// the network, so the user's Git Credential Manager or a CLI login cannot stand in for it; with it, the credential reaches
// only the one git process, through its environment.
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('fs'), path = require('path');
const pub = require('../publish.js');

const publishing = fs.readFileSync(path.join(__dirname, '..', 'publishing.js'), 'utf8');
const publishSrc = fs.readFileSync(path.join(__dirname, '..', 'publish.js'), 'utf8');

describe('no ambient credential can authenticate a publication', () => {
	it('without the authorization, a github.com repository is reported before any fetch or push', () => {
		const warn = publishing.indexOf('needs publishing authorization');
		const fetching = publishing.indexOf('pub.inspect(root, { fetch: wantsNetwork, token })');
		assert.ok(warn > 0 && fetching > 0 && warn < fetching, 'the check comes first');
		assert.ok(/wantsNetwork && !token/.test(publishing));
		assert.ok(/pub\.inspect\(root\);/.test(publishing), 'the check uses a local inspection (no fetch)');
	});

	it('with the token, the user\'s own helpers are cleared for that process and the token goes through the environment', () => {
		const a = pub.authFor('https://github.com/owner/repo.git', 'TOKEN_VALUE_FOR_TEST');
		assert.deepEqual(a.args.slice(0, 2), ['-c', 'credential.helper=']); // empties the helper list first
		assert.ok(a.args[3].startsWith('credential.helper=!'));
		assert.equal(a.args.join(' ').includes('TOKEN_VALUE_FOR_TEST'), false, 'never on the command line');
		assert.equal(a.env[pub.TOKEN_ENV], 'TOKEN_VALUE_FOR_TEST');
	});

	it('git never prompts and never opens the Credential Manager UI', () => {
		assert.ok(/GIT_TERMINAL_PROMPT: '0'/.test(publishSrc));
		assert.ok(/GCM_INTERACTIVE: 'Never'/.test(publishSrc));
	});

	it('a non-GitHub remote gets no token', () => {
		assert.deepEqual(pub.authFor('https://example.com/a/b.git', 'T'), { args: [], env: {} });
	});

	it('pushes are never forced', () => {
		assert.equal(/--force|--force-with-lease|\s-f\s/.test(publishSrc.replace(/\/\/.*$/gm, '')), false);
	});
});
