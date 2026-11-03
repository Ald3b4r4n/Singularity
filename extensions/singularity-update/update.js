'use strict';
// Singularity updates from GitHub Releases of the official repository.
//
// What this module does (and only this):
//   1. asks the official repository for its releases (fixed origin; no other URL is accepted in the product);
//   2. chooses the newest release of the chosen channel that is newer than the installed version;
//   3. checks that the release has exactly the expected installer and its checksum list, for this platform and channel;
//   4. downloads the installer to a temporary folder, with progress, and accepts it only if its SHA-256 matches the
//      official SHA256SUMS of that release, and the size matches the release metadata.
//
// What it does NOT do: it never runs the installer, never replaces a running file, and never sends the account token
// (update requests are anonymous). Running a verified installer needs the Inno Setup installer and its migration tests,
// which are not part of this change, so the IDE must not offer a button that installs.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OFFICIAL_REPO = 'Ald3b4r4n/Singularity';
const API_BASE = 'https://api.github.com';
const CHANNELS = ['stable', 'preview'];

class UpdateError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

/** Parses "1.2.3" or "1.2.3-preview.4". Returns [major, minor, patch, prerelease] or undefined. */
function parseVersion(v) {
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
	if (!m) { return undefined; }
	return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] || ''];
}

/** Semantic-version order: a prerelease is lower than the same version without one. Returns <0, 0 or >0. */
function compareVersions(a, b) {
	const x = parseVersion(a), y = parseVersion(b);
	if (!x || !y) { throw new UpdateError('bad-version', `invalid version: ${!x ? a : b}`); }
	for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) { return x[i] - y[i]; } }
	if (x[3] === y[3]) { return 0; }
	if (x[3] === '') { return 1; }
	if (y[3] === '') { return -1; }
	return x[3] < y[3] ? -1 : 1; // lexical on prerelease tags is enough for "preview.N" sequences of one line
}

/** The channel a release belongs to. Stable never includes prereleases; preview includes both. */
function releaseChannel(release) {
	return release.prerelease ? 'preview' : 'stable';
}

function isAllowedForChannel(release, channel) {
	if (!CHANNELS.includes(channel)) { throw new UpdateError('bad-channel', `unknown channel ${channel}`); }
	if (channel === 'stable') { return !release.prerelease; }
	return true; // preview: prereleases and stable releases
}

/** Installer name for this platform and channel. Only Windows x64 is produced for now. */
function installerName(version, platform = 'win32', arch = 'x64') {
	return `Singularity-${version}-${platform}-${arch}-setup.exe`;
}
const CHECKSUM_ASSET = 'SHA256SUMS';

/**
 * Picks the release to offer: newest, allowed on the channel, newer than the installed version, and complete (has the
 * installer and the checksum list). Incomplete releases are skipped with a reason, never offered.
 */
function selectUpdate(releases, { installed, channel = 'stable', platform = 'win32', arch = 'x64', assetOrigin = 'https://github.com/' }) {
	const skipped = [];
	const candidates = [];
	for (const r of releases) {
		if (r.draft) { continue; }
		const v = String(r.tag_name || '').replace(/^v/, '');
		if (!parseVersion(v)) { skipped.push({ tag: r.tag_name, reason: 'not-a-version' }); continue; }
		if (!isAllowedForChannel(r, channel)) { continue; }
		if (compareVersions(v, installed) <= 0) { continue; }
		const assets = Array.isArray(r.assets) ? r.assets : [];
		const installer = assets.find(a => a.name === installerName(v, platform, arch));
		const sums = assets.find(a => a.name === CHECKSUM_ASSET);
		if (!installer || !sums) { skipped.push({ tag: r.tag_name, reason: installer ? 'no-checksums' : 'no-installer-for-platform' }); continue; }
		if (!installer.browser_download_url.startsWith(assetOrigin) || !sums.browser_download_url.startsWith(assetOrigin)) {
			skipped.push({ tag: r.tag_name, reason: 'asset-not-from-github' }); continue;
		}
		candidates.push({ version: v, tag: r.tag_name, channel: releaseChannel(r), name: r.name || r.tag_name, notes: String(r.body || '').slice(0, 20000), publishedAt: r.published_at, installer: { name: installer.name, url: installer.browser_download_url, size: installer.size }, sums: { url: sums.browser_download_url } });
	}
	candidates.sort((a, b) => compareVersions(b.version, a.version));
	return { update: candidates[0], skipped };
}

/** Parses SHA256SUMS ("<hex>  <name>" lines). Returns Map name -> hex. Rejects duplicates and malformed lines. */
function parseChecksums(text) {
	const map = new Map();
	for (const raw of String(text).split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) { continue; }
		const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
		if (!m) { throw new UpdateError('bad-checksums', 'malformed line in SHA256SUMS'); }
		const name = m[2].trim();
		if (map.has(name)) { throw new UpdateError('bad-checksums', `duplicate entry for ${name}`); }
		map.set(name, m[1].toLowerCase());
	}
	return map;
}

async function fetchJson(fetchFn, url) {
	const res = await fetchFn(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'singularity-ide' } });
	if (!res.ok) { throw new UpdateError('http', `GitHub answered HTTP ${res.status}`); }
	try { return await res.json(); } catch { throw new UpdateError('bad-response', 'the release list is not valid JSON'); }
}

/** Lists the official releases (first page is enough: the newest releases come first). */
async function listReleases({ fetchFn, apiBase = API_BASE, repo = OFFICIAL_REPO }) {
	return fetchJson(fetchFn, `${apiBase}/repos/${repo}/releases?per_page=30`);
}

/**
 * Downloads the installer of `update` into `dir`, showing progress, and returns its path only when the SHA-256 equals the
 * official checksum and the byte count equals the release metadata. A file that fails either check is deleted.
 */
async function downloadVerified({ fetchFn, update, dir = os.tmpdir(), onProgress = () => { } }) {
	const sumsRes = await fetchFn(update.sums.url, { headers: { 'User-Agent': 'singularity-ide' } });
	if (!sumsRes.ok) { throw new UpdateError('http', `checksums: HTTP ${sumsRes.status}`); }
	const sums = parseChecksums(await sumsRes.text());
	const expected = sums.get(update.installer.name);
	if (!expected) { throw new UpdateError('no-checksum', `${update.installer.name} is not listed in SHA256SUMS`); }

	const target = path.join(dir, update.installer.name);
	const partial = target + '.part';
	const res = await fetchFn(update.installer.url, { headers: { 'User-Agent': 'singularity-ide' } });
	if (!res.ok || !res.body) { throw new UpdateError('http', `installer: HTTP ${res.status}`); }
	const total = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0) || update.installer.size;
	const hash = crypto.createHash('sha256');
	let received = 0;
	const out = fs.createWriteStream(partial);
	try {
		const reader = res.body.getReader();
		for (; ;) {
			const { done, value } = await reader.read();
			if (done) { break; }
			hash.update(value);
			received += value.length;
			out.write(value);
			onProgress({ received, total });
		}
		await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
	} catch (e) {
		out.destroy();
		fs.rmSync(partial, { force: true });
		throw e;
	}
	const digest = hash.digest('hex');
	if (received !== update.installer.size) {
		fs.rmSync(partial, { force: true });
		throw new UpdateError('incomplete', `downloaded ${received} bytes, the release says ${update.installer.size}`);
	}
	if (digest !== expected) {
		fs.rmSync(partial, { force: true });
		throw new UpdateError('checksum-mismatch', 'the installer does not match the official SHA-256');
	}
	fs.renameSync(partial, target);
	return { path: target, sha256: digest, bytes: received };
}

module.exports = {
	OFFICIAL_REPO, API_BASE, CHANNELS, CHECKSUM_ASSET, UpdateError,
	parseVersion, compareVersions, releaseChannel, isAllowedForChannel, installerName,
	selectUpdate, parseChecksums, listReleases, downloadVerified,
};
