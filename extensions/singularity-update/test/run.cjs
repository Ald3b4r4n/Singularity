'use strict';
// Run: node test/run.cjs   (a local HTTP server stands in for GitHub; nothing leaves the machine)
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs'), http = require('http'), os = require('os'), path = require('path');
const u = require('../update.js');

const results = [];
const test = async (name, fn) => {
	try { await fn(); results.push(true); console.log('  ok  ' + name); }
	catch (e) { results.push(false); console.log('  FAIL ' + name + ': ' + e.message); }
};

const installer = (v, bytes) => Buffer.from(bytes, 'utf8');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const release = (tag, { prerelease = false, draft = false, withInstaller = true, withSums = true, baseUrl = 'https://github.com/Ald3b4r4n/Singularity/releases/download' } = {}) => {
	const v = tag.replace(/^v/, '');
	const assets = [];
	if (withInstaller) { assets.push({ name: u.installerName(v), browser_download_url: `${baseUrl}/${tag}/${u.installerName(v)}`, size: 10 }); }
	if (withSums) { assets.push({ name: u.CHECKSUM_ASSET, browser_download_url: `${baseUrl}/${tag}/${u.CHECKSUM_ASSET}`, size: 100 }); }
	return { tag_name: tag, name: 'Singularity ' + tag, prerelease, draft, body: 'Notas de ' + tag, published_at: '2026-11-03T00:00:00Z', assets };
};

(async () => {
	await test('version order is semantic: prerelease < release, numeric parts compared as numbers', () => {
		assert.ok(u.compareVersions('0.10.0', '0.9.0') > 0);
		assert.ok(u.compareVersions('0.1.0-preview.1', '0.1.0') < 0);
		assert.ok(u.compareVersions('v0.2.0', '0.1.9') > 0);
		assert.equal(u.compareVersions('1.2.3', 'v1.2.3'), 0);
		assert.throws(() => u.compareVersions('latest', '1.0.0'), e => e.code === 'bad-version');
	});

	await test('stable never offers a prerelease; preview offers both', () => {
		const rs = [release('v0.2.0-preview.1', { prerelease: true }), release('v0.1.5')];
		assert.equal(u.selectUpdate(rs, { installed: '0.1.0', channel: 'stable' }).update.tag, 'v0.1.5');
		assert.equal(u.selectUpdate(rs, { installed: '0.1.0', channel: 'preview' }).update.tag, 'v0.2.0-preview.1');
	});

	await test('nothing is offered when the installed version is the newest; drafts are ignored', () => {
		const rs = [release('v0.1.0'), { ...release('v9.0.0'), draft: true }];
		assert.equal(u.selectUpdate(rs, { installed: '0.1.0' }).update, undefined);
	});

	await test('an incomplete release is skipped with a reason, never offered', () => {
		const rs = [release('v0.3.0', { withSums: false }), release('v0.2.0')];
		const r = u.selectUpdate(rs, { installed: '0.1.0' });
		assert.equal(r.update.tag, 'v0.2.0');
		assert.deepEqual(r.skipped, [{ tag: 'v0.3.0', reason: 'no-checksums' }]);
		const noInstaller = u.selectUpdate([release('v0.3.0', { withInstaller: false })], { installed: '0.1.0' });
		assert.equal(noInstaller.update, undefined);
		assert.equal(noInstaller.skipped[0].reason, 'no-installer-for-platform');
	});

	await test('assets must come from github.com', () => {
		const r = u.selectUpdate([release('v0.2.0', { baseUrl: 'https://evil.example/download' })], { installed: '0.1.0' });
		assert.equal(r.update, undefined);
		assert.equal(r.skipped[0].reason, 'asset-not-from-github');
	});

	await test('checksum list: strict parsing, duplicates refused', () => {
		const h = 'a'.repeat(64);
		assert.equal(u.parseChecksums(`${h}  Singularity-0.2.0-win32-x64-setup.exe\n`).get('Singularity-0.2.0-win32-x64-setup.exe'), h);
		assert.throws(() => u.parseChecksums('not a hash line'), e => e.code === 'bad-checksums');
		assert.throws(() => u.parseChecksums(`${h} x\n${h} x`), e => e.code === 'bad-checksums');
	});

	// a local GitHub-like server: release list, checksum list and installer
	const bytes = installer('0.2.0', 'INSTALLER-BYTES-FOR-TEST-ONLY');
	const goodSums = `${sha(bytes)}  ${u.installerName('0.2.0')}\n`;
	let mode = 'good';
	const server = http.createServer((req, res) => {
		const name = req.url.split('/').pop();
		if (req.url.startsWith('/repos/')) {
			const base = `http://127.0.0.1:${server.address().port}/dl`;
			const list = [{ ...release('v0.2.0'), assets: [
				{ name: u.installerName('0.2.0'), browser_download_url: `${base}/${u.installerName('0.2.0')}`, size: bytes.length },
				{ name: u.CHECKSUM_ASSET, browser_download_url: `${base}/${u.CHECKSUM_ASSET}`, size: goodSums.length },
			] }];
			res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(list)); return;
		}
		if (name === u.CHECKSUM_ASSET) { res.writeHead(200); res.end(mode === 'badsums' ? `${'0'.repeat(64)}  ${u.installerName('0.2.0')}\n` : goodSums); return; }
		if (name === u.installerName('0.2.0')) {
			if (mode === 'truncated') { res.writeHead(200, { 'content-length': bytes.length }); res.write(bytes.subarray(0, 5)); setTimeout(() => res.destroy(), 20); return; }
			if (mode === 'tampered') { const t = Buffer.from(bytes); t[0] ^= 1; res.writeHead(200, { 'content-length': t.length }); res.end(t); return; }
			res.writeHead(200, { 'content-length': bytes.length }); res.end(bytes); return;
		}
		res.writeHead(404); res.end();
	});
	await new Promise(r => server.listen(0, '127.0.0.1', r));
	const apiBase = `http://127.0.0.1:${server.address().port}`;
	const fetchFn = (url, init) => fetch(url, init);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));

	await test('lists releases from the official repository path and selects the newer one', async () => {
		const releases = await u.listReleases({ fetchFn, apiBase });
		const sel = u.selectUpdate(releases, { installed: '0.1.0', assetOrigin: apiBase + '/dl/' });
		assert.equal(sel.update.version, '0.2.0');
	});

	await test('a complete download is accepted only when the SHA-256 and size match', async () => {
		mode = 'good';
		const sel = u.selectUpdate(await u.listReleases({ fetchFn, apiBase }), { installed: '0.1.0', assetOrigin: apiBase + '/dl/' });
		// the browser_download_url of the fake server points at /dl/...
		sel.update.installer.url = `${apiBase}/dl/${u.installerName('0.2.0')}`;
		sel.update.sums.url = `${apiBase}/dl/${u.CHECKSUM_ASSET}`;
		let last = null;
		const out = await u.downloadVerified({ fetchFn, update: sel.update, dir, onProgress: p => { last = p; } });
		assert.equal(out.sha256, sha(bytes));
		assert.deepEqual(fs.readFileSync(out.path), bytes);
		assert.equal(last.received, bytes.length, 'progress reached the full size');
	});

	await test('a tampered installer is refused and the file is removed', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-t-'));
		mode = 'tampered';
		const sel = u.selectUpdate(await u.listReleases({ fetchFn, apiBase }), { installed: '0.1.0', assetOrigin: apiBase + '/dl/' });
		sel.update.installer.url = `${apiBase}/dl/${u.installerName('0.2.0')}`;
		sel.update.sums.url = `${apiBase}/dl/${u.CHECKSUM_ASSET}`;
		await assert.rejects(u.downloadVerified({ fetchFn, update: sel.update, dir }), e => e.code === 'checksum-mismatch');
		assert.equal(fs.existsSync(path.join(dir, u.installerName('0.2.0'))), false);
		assert.equal(fs.existsSync(path.join(dir, u.installerName('0.2.0') + '.part')), false);
	});

	await test('a wrong checksum list is refused even if the file is intact', async () => {
		mode = 'badsums';
		const sel = u.selectUpdate(await u.listReleases({ fetchFn, apiBase }), { installed: '0.1.0', assetOrigin: apiBase + '/dl/' });
		sel.update.installer.url = `${apiBase}/dl/${u.installerName('0.2.0')}`;
		sel.update.sums.url = `${apiBase}/dl/${u.CHECKSUM_ASSET}`;
		await assert.rejects(u.downloadVerified({ fetchFn, update: sel.update, dir }), e => e.code === 'checksum-mismatch');
	});

	await test('a truncated download is refused and the partial file is removed', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-x-'));
		mode = 'truncated';
		const sel = u.selectUpdate(await u.listReleases({ fetchFn, apiBase }), { installed: '0.1.0', assetOrigin: apiBase + '/dl/' });
		sel.update.installer.url = `${apiBase}/dl/${u.installerName('0.2.0')}`;
		sel.update.sums.url = `${apiBase}/dl/${u.CHECKSUM_ASSET}`;
		await assert.rejects(u.downloadVerified({ fetchFn, update: sel.update, dir }));
		assert.equal(fs.existsSync(path.join(dir, u.installerName('0.2.0') + '.part')), false);
		assert.equal(fs.existsSync(path.join(dir, u.installerName('0.2.0'))), false);
	});

	await test('no network: the caller gets a plain error, nothing is written', async () => {
		await assert.rejects(u.listReleases({ fetchFn, apiBase: 'http://127.0.0.1:1' }));
	});

	await test('the update client sends no credentials and the origin is fixed in the module', () => {
		const src = fs.readFileSync(path.join(__dirname, '..', 'update.js'), 'utf8');
		assert.equal(/authorization|Bearer|token/i.test(src.replace(/\/\/.*$/gm, '')), false);
		assert.ok(src.includes("OFFICIAL_REPO = 'Ald3b4r4n/Singularity'"));
		assert.equal(/runInstaller|spawn|execFile|child_process/.test(src), false, 'the module never runs anything');
	});

	server.close();
	fs.rmSync(dir, { recursive: true, force: true });
	const failed = results.filter(r => !r).length;
	console.log(`${results.length - failed}/${results.length} passed`);
	process.exit(failed ? 1 : 0);
})();
