'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const u = require('../update.js');

const installer = Buffer.from('synthetic Windows installer bytes');
const sha256 = createHash('sha256').update(installer).digest('hex');
const commit = 'a'.repeat(40);
const digest = (value) => createHash('sha256').update(value).digest('hex');

function fixture(version = '0.2.0', target = 'user', overrides = {}) {
	const name = u.installerName(version, target);
	const tag = `v${version}`;
	const prerelease = version.includes('-preview.');
	const manifest = {
		repository: u.OFFICIAL_REPO, tag, version, commit, channel: prerelease ? 'preview' : 'stable',
		workflow: u.WORKFLOW, build: 'passed',
		assets: [{ name, target, arch: 'x64', size: installer.length, sha256 }],
		...overrides
	};
	const payloads = new Map([
		[name, installer],
		[u.MANIFEST_ASSET, Buffer.from(JSON.stringify(manifest))],
		[u.CHECKSUM_ASSET, Buffer.from(`${sha256}  ${name}\n`)]
	]);
	const release = {
		tag_name: tag, prerelease, draft: false,
		assets: [...payloads].map(([name, body]) => ({
			name, size: body.length, browser_download_url: `https://github.com/${u.OFFICIAL_REPO}/releases/download/${tag}/${name}`
		}))
	};
	return { release, payloads, manifest };
}

const select = (releases, opts = {}) => u.selectUpdate(releases, { installed: '0.1.0', ...opts });
const transport = payloads => async (url, options) => {
	assert.equal(options.redirect, 'manual');
	assert.equal(Object.keys(options.headers).some(name => name.toLowerCase() === 'authorization'), false);
	options.signal.throwIfAborted();
	const name = url.split('/').pop();
	return new Response(payloads.get(name), { status: payloads.has(name) ? 200 : 404 });
};

async function downloadTest(t, { overrides, target, verify, fetchFn, signal, onProgress } = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upd-test-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const { release, payloads } = fixture('0.2.0', target, overrides);
	const update = select([release], { target }).update;
	const verified = [];
	return {
		dir, verified, payloads, update,
		run: () => u.downloadVerified({
			update, dir, signal, onProgress,
			fetchFn: fetchFn ? (url, options) => fetchFn(url, options, payloads) : transport(payloads),
			verify: async (file, provenance) => {
				assert.equal(provenance.repo, u.OFFICIAL_REPO);
				assert.equal(provenance.tag, release.tag_name);
				assert.equal(provenance.commit, commit);
				assert.equal(provenance.workflow, u.WORKFLOW);
				verified.push(path.basename(file));
				await verify?.(file, provenance);
			}
		})
	};
}

test('version ordering respects numeric Preview IDs, Stable precedence and strict syntax', () => {
	assert.equal(u.compareVersions('0.1.0-preview.2', '0.1.0-preview.10'), -1);
	assert.equal(u.compareVersions('0.1.0-preview.10', 'v0.1.0'), -1);
	assert.equal(u.compareVersions('0.10.0', '0.9.0'), 1);
	assert.equal(u.compareVersions('1.2.3', 'v1.2.3'), 0);
	for (const invalid of ['01.2.3', '1.2.3-preview.01', '1.2.3-preview', '1.2.3\n', '65536.0.0']) {
		assert.equal(u.parseVersion(invalid), undefined);
	}
});

test('chooses channels, ignores drafts and already-installed releases', () => {
	const stable = fixture('0.1.1').release;
	const preview2 = fixture('0.2.0-preview.2').release;
	const preview10 = fixture('0.2.0-preview.10').release;
	const releases = [preview2, preview10, stable, { ...fixture('9.0.0').release, draft: true }];
	assert.equal(select(releases).update.version, '0.1.1');
	assert.equal(select(releases, { channel: 'preview' }).update.version, '0.2.0-preview.10');
	assert.equal(select(releases, { installed: '1.0.0' }).update, undefined);
	assert.equal(select([{ ...preview10, prerelease: false }]).update, undefined);
	assert.equal(select([]).update, undefined);
});

test('requires exact repository and tag URLs, compatible installers and unique metadata', () => {
	const { release } = fixture('0.2.0', 'system');
	assert.equal(select([release]).update, undefined);
	assert.equal(select([release], { target: 'system', arch: 'arm64' }).update, undefined);
	assert.equal(select([release], { target: 'system', platform: 'linux' }).update, undefined);
	assert.equal(select([release], { target: 'system' }).update.target, 'system');
	const missing = { ...release, assets: release.assets.slice(0, 2) };
	assert.equal(select([missing], { target: 'system' }).skipped[0].reason, 'missing-or-duplicate-assets');
	release.assets[0].browser_download_url = release.assets[0].browser_download_url.replace(u.OFFICIAL_REPO, 'other/project');
	assert.equal(select([release], { target: 'system' }).skipped[0].reason, 'invalid-asset-metadata');
});

test('requests only the official release API and refuses unexpected responses', async () => {
	const fetchFn = async (url, init) => {
		assert.equal(url, `${u.API_BASE}/repos/${u.OFFICIAL_REPO}/releases?per_page=100`);
		assert.equal(init.redirect, 'error');
		return new Response('[]');
	};
	assert.deepEqual(await u.listReleases({ fetchFn }), []);
	await assert.rejects(u.listReleases({ fetchFn: () => Promise.reject(new Error('offline')) }), /offline/);
	await assert.rejects(u.listReleases({ fetchFn: async () => new Response('{}') }), { code: 'bad-response' });
});

test('streams installer with progress and accepts it after both provenance checks', async t => {
	const progresses = [];
	const f = await downloadTest(t, { onProgress: p => progresses.push(p) });
	const result = await f.run();
	assert.equal(result.sha256, sha256);
	assert.equal(digest(await fs.readFile(result.path)), sha256);
	assert.equal(progresses.at(-1).received, installer.length);
	assert.deepEqual(f.verified, [u.MANIFEST_ASSET, f.update.installer.name + '.part']);
	const second = await f.run();
	assert.notEqual(second.path, result.path, 'each retry uses a fresh staging directory');
});

test('manifest cannot switch commit format, tag, channel, scope or architecture', async t => {
	for (const overrides of [{ commit: 'main' }, { tag: 'v9.0.0' }, { channel: 'preview' }, {
		assets: [{ name: u.installerName('0.2.0'), target: 'system', arch: 'arm64', sha256, size: installer.length }]
	}]) {
		const f = await downloadTest(t, { overrides });
		await assert.rejects(f.run(), { code: 'manifest' });
		assert.deepEqual(await fs.readdir(f.dir), []);
	}
});

test('rejects mismatched checksum list, wrong bytes, and incomplete or oversized downloads', async t => {
	const f = await downloadTest(t);
	f.payloads.set(u.CHECKSUM_ASSET, Buffer.from(`${'f'.repeat(64)}  ${f.update.installer.name}\n`));
	await assert.rejects(f.run(), { code: 'checksum-mismatch' });
	f.payloads.set(u.CHECKSUM_ASSET, Buffer.from(`${sha256}  ${f.update.installer.name}\n`));
	f.payloads.set(f.update.installer.name, Buffer.alloc(installer.length));
	await assert.rejects(f.run(), { code: 'checksum-mismatch' });
	for (const bytes of [installer.subarray(0, 5), Buffer.alloc(installer.length + 1)]) {
		f.payloads.set(f.update.installer.name, bytes);
		await assert.rejects(f.run(), { code: 'incomplete' });
	}
	assert.deepEqual(await fs.readdir(f.dir), []);
});

test('fails closed if either attestation is unavailable or invalid', async t => {
	for (const type of ['manifest', 'installer']) {
		const f = await downloadTest(t, {
			verify: file => {
				if (file.endsWith(type === 'manifest' ? '.json' : '.part')) {
					throw new Error('attestation rejected');
				}
			}
		});
		await assert.rejects(f.run(), /attestation rejected/);
		assert.deepEqual(await fs.readdir(f.dir), []);
	}
});

test('follows the official asset CDN and blocks untrusted redirects before fetching', async t => {
	const bad = await downloadTest(t, {
		fetchFn: async () => Response.redirect('https://release-assets.githubusercontent.com.attacker.test/file')
	});
	await assert.rejects(bad.run(), { code: 'origin' });
	assert.deepEqual(await fs.readdir(bad.dir), []);
	const good = await downloadTest(t, {
		fetchFn: async (url, opts, payloads) => url.startsWith('https://github.com/')
			? Response.redirect(`https://release-assets.githubusercontent.com/test/${url.split('/').pop()}`)
			: transport(payloads)(url, opts)
	});
	assert.equal((await good.run()).sha256, sha256);
});

test('cancellation and stream errors remove partial data', async t => {
	const controller = new AbortController();
	const cancelled = await downloadTest(t, { signal: controller.signal, onProgress: () => controller.abort() });
	await assert.rejects(cancelled.run(), { name: 'AbortError' });
	assert.deepEqual(await fs.readdir(cancelled.dir), []);
	const failed = await downloadTest(t, {
		fetchFn: async (url, opts, payloads) => url.endsWith('.exe')
			? new Response(new ReadableStream({ pull: stream => stream.error(new Error('connection closed')) }))
			: transport(payloads)(url, opts)
	});
	await assert.rejects(failed.run(), /connection closed/);
	assert.deepEqual(await fs.readdir(failed.dir), []);
});
