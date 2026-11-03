'use strict';
// Real Git, real repositories in temporary folders, a local bare remote. Run: node --test test/
const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const pub = require('../publish.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
const commit = (cwd, file, text) => { fs.writeFileSync(path.join(cwd, file), text); sh(cwd, 'add', '-A'); sh(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'c ' + file); return sh(cwd, 'rev-parse', 'HEAD'); };

describe('modes and decisions (pure)', () => {
	it('automatic only for listed repositories, default otherwise, case-insensitive paths', () => {
		const list = ['D:\\dev\\Repo-Auto'];
		assert.equal(pub.modeFor('d:\\dev\\repo-auto', { defaultMode: 'manual', automaticRepositories: list }), 'automatic');
		assert.equal(pub.modeFor('D:\\dev\\other', { defaultMode: 'assisted', automaticRepositories: list }), 'assisted');
		assert.equal(pub.modeFor('D:\\dev\\other', { defaultMode: 'automatic', automaticRepositories: list }), 'manual', 'a default can never be automatic');
	});
	it('decides per mode and state', () => {
		const ahead = { isRepo: true, hasUpstream: true, ahead: 2, behind: 0 };
		assert.equal(pub.decide('manual', ahead).action, 'none');
		assert.equal(pub.decide('assisted', ahead).action, 'ask');
		assert.equal(pub.decide('automatic', ahead).action, 'push');
		assert.equal(pub.decide('automatic', { ...ahead, behind: 1 }).action, 'report', 'diverged is reported, never pushed');
		assert.equal(pub.decide('automatic', { isRepo: true, hasUpstream: false, reason: 'no-upstream' }).reason, 'no-upstream');
		assert.equal(pub.decide('automatic', { isRepo: false }).action, 'none');
	});
	it('classifies Git failures', () => {
		assert.equal(pub.classify('! [rejected]        main -> main (non-fast-forward)', 1), 'rejected');
		assert.equal(pub.classify('remote: Invalid username or password.\nfatal: Authentication failed', 128), 'auth');
		assert.equal(pub.classify("fatal: unable to access 'https://x/': Could not resolve host: x", 128), 'offline');
		assert.equal(pub.classify('', 0), 'pushed');
	});
});

describe('against real repositories', () => {
	let base, remote, work, other;
	before(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-'));
		remote = path.join(base, 'remote.git');
		sh(base, 'init', '-q', '--bare', '-b', 'main', remote);
		work = path.join(base, 'work');
		sh(base, 'init', '-q', '-b', 'main', work);
		sh(work, 'remote', 'add', 'origin', remote);
		commit(work, 'a.txt', 'one\n');
		sh(work, 'push', '-q', '-u', 'origin', 'main');
		other = path.join(base, 'other');
		sh(base, 'clone', '-q', remote, other);
	});
	after(() => { fs.rmSync(base, { recursive: true, force: true }); });

	it('reports a repository without upstream and never adds or changes remotes', async () => {
		sh(work, 'checkout', '-q', '-b', 'feature-no-upstream');
		const remotesBefore = sh(work, 'remote', '-v');
		const st = await pub.inspect(work);
		assert.equal(st.hasUpstream, false);
		assert.equal(pub.decide('automatic', st).reason, 'no-upstream');
		const r = await pub.publish(st);
		assert.equal(r.code, 'no-upstream');
		assert.equal(sh(work, 'remote', '-v'), remotesBefore, 'remotes unchanged');
		sh(work, 'checkout', '-q', 'main');
	});

	it('assisted: a local commit is ahead, the IDE asks; publishing pushes exactly that commit', async () => {
		const c = commit(work, 'b.txt', 'two\n');
		const st = await pub.inspect(work);
		assert.equal(st.ahead, 1);
		assert.equal(pub.decide('assisted', st).action, 'ask');
		const published = new Set();
		const r = await pub.publish(st, { published });
		assert.equal(r.ok, true, r.message);
		assert.equal(sh(remote, 'rev-parse', 'main'), c, 'remote now has the commit');
		assert.ok(published.has(c));
	});

	it('a commit is pushed once: a second attempt is skipped', async () => {
		const st = await pub.inspect(work);
		assert.equal(st.ahead, 0);
		const r = await pub.publish(st, { published: new Set() });
		assert.equal(r.code, 'up-to-date');
	});

	it('automatic: a commit made outside the editor (plain git, like an agent) is published', async () => {
		const c = commit(work, 'c.txt', 'three from the CLI\n');
		const st = await pub.inspect(work);
		assert.equal(pub.decide('automatic', st).action, 'push');
		const r = await pub.publish(st, { published: new Set() });
		assert.equal(r.ok, true, r.message);
		assert.equal(sh(remote, 'rev-parse', 'main'), c);
	});

	it('diverged: the remote has commits we do not have; nothing is forced, the remote is untouched', async () => {
		sh(other, 'pull', '-q', '--ff-only');
		const theirs = commit(other, 'remote-only.txt', 'from someone else\n');
		sh(other, 'push', '-q', 'origin', 'main');
		const mine = commit(work, 'local-only.txt', 'mine\n');
		const st = await pub.inspect(work, { fetch: true });
		assert.equal(st.fetchError, undefined);
		assert.equal(st.behind, 1);
		assert.equal(pub.decide('automatic', st).action, 'report', 'the automatic mode does not push a diverged branch');
		const r = await pub.publish(st, { published: new Set() });
		assert.equal(r.ok, false);
		assert.equal(r.code, 'rejected');
		assert.equal(sh(remote, 'rev-parse', 'main'), theirs, 'remote not overwritten');
		assert.notEqual(sh(remote, 'rev-parse', 'main'), mine);
	});

	it('offline: a remote that refuses connections is reported as offline and the commit stays local', async () => {
		sh(work, 'reset', '-q', '--hard', 'HEAD~1');
		sh(work, 'pull', '-q', '--no-rebase', 'origin', 'main');
		const local = commit(work, 'offline.txt', 'offline\n');
		sh(work, 'remote', 'set-url', 'origin', 'https://127.0.0.1:1/none.git');
		try {
			const st = await pub.inspect(work);
			const r = await pub.publish(st, { published: new Set() });
			assert.equal(r.ok, false);
			assert.equal(r.code, 'offline', r.stderr);
			assert.equal(sh(work, 'rev-parse', 'HEAD'), local, 'the commit is kept locally');
		} finally {
			sh(work, 'remote', 'set-url', 'origin', remote);
		}
	});

	it('the account token reaches only the push process, through an environment variable and a per-process helper', async () => {
		const cred = pub.TOKEN_HELPER;
		// git's own credential protocol, run the same way the push runs it, but without a network
		const out = execFileSync('git', ['-c', 'credential.helper=', '-c', `credential.helper=${cred}`, 'credential', 'fill'], {
			cwd: work, encoding: 'utf8', input: 'protocol=https\nhost=github.com\n\n', env: { ...process.env, [pub.TOKEN_ENV]: 'gho_fake_token_for_test_only' },
		});
		assert.ok(out.includes('username=x-access-token'));
		assert.ok(out.includes('password=gho_fake_token_for_test_only'));
		assert.equal(fs.existsSync(path.join(base, '.git-credentials')), false, 'nothing is stored on disk');
		assert.equal(sh(work, 'config', '--get', 'credential.helper').length >= 0, true);
	});
});
