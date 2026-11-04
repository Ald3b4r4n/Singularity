'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { verifyProvenance } = require('./provenance.js');
const { parseVersion, compareVersions } = require('./version.js');

const OFFICIAL_REPO = 'Ald3b4r4n/Singularity';
const API_BASE = 'https://api.github.com';
const CHANNELS = ['stable', 'preview'];
const MANIFEST_ASSET = 'singularity-release.json';
const CHECKSUM_ASSET = 'SHA256SUMS';
const WORKFLOW = '.github/workflows/singularity-release.yml';
const releaseOrigin = 'https://github.com';
const downloadOrigin = 'https://release-assets.githubusercontent.com';

class UpdateError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

function installerName(version, target = 'user') {
	return `SingularityIDE-${version}-x64-${target}.exe`;
}

function assetUrl(tag, name) {
	return `${releaseOrigin}/${OFFICIAL_REPO}/releases/download/${tag}/${name}`;
}

function selectUpdate(releases, { installed, channel = 'stable', platform = 'win32', arch = 'x64', target = 'user' }) {
	if (!parseVersion(installed)) {
		throw new UpdateError('bad-version', 'installed version is unknown');
	}
	if (!CHANNELS.includes(channel)) {
		throw new UpdateError('bad-channel', 'unknown update channel');
	}
	const skipped = [];
	if (platform !== 'win32' || arch !== 'x64' || !['system', 'user'].includes(target)) {
		return { skipped };
	}

	const candidates = [];
	for (const release of releases) {
		const tag = release?.tag_name;
		if (release?.draft !== false || typeof tag !== 'string' || !tag.startsWith('v') || !parseVersion(tag)) {
			continue;
		}
		const version = tag.slice(1);
		const isPreview = version.includes('-preview.');
		if (release.prerelease !== isPreview || (channel === 'stable' && isPreview) || compareVersions(version, installed) <= 0) {
			continue;
		}
		const assets = Array.isArray(release.assets) ? release.assets : [];
		const names = [installerName(version, target), MANIFEST_ASSET, CHECKSUM_ASSET];
		const selected = names.map(name => assets.filter(asset => asset?.name === name));
		if (selected.some(matches => matches.length !== 1)) {
			skipped.push({ tag, reason: 'missing-or-duplicate-assets' });
			continue;
		}
		const [installer, manifest, sums] = selected.map(([asset]) => ({ name: asset.name, url: asset.browser_download_url, size: asset.size }));
		if ([installer, manifest, sums].some(asset => asset.url !== assetUrl(tag, asset.name) || !Number.isSafeInteger(asset.size) || asset.size < 1)) {
			skipped.push({ tag, reason: 'invalid-asset-metadata' });
			continue;
		}
		candidates.push({
			version, tag, channel: isPreview ? 'preview' : 'stable', target, arch,
			notes: String(release.body || '').slice(0, 20000), installer, manifest, sums
		});
	}
	candidates.sort((a, b) => compareVersions(b.version, a.version));
	return { update: candidates[0], skipped };
}

function parseChecksums(text) {
	const map = new Map();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) {
			continue;
		}
		const match = /^([0-9a-fA-F]{64})\s+\*?([^\s]+)$/.exec(line);
		if (!match || map.has(match[2])) {
			throw new UpdateError('bad-checksums', 'malformed or duplicate SHA256SUMS entry');
		}
		map.set(match[2], match[1].toLowerCase());
	}
	return map;
}

async function listReleases({ fetchFn = fetch, signal = AbortSignal.timeout(15000) } = {}) {
	const response = await fetchFn(`${API_BASE}/repos/${OFFICIAL_REPO}/releases?per_page=100`, {
		signal, redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'singularity-ide' }
	});
	if (!response.ok) {
		throw new UpdateError('http', `GitHub answered HTTP ${response.status}`);
	}
	const releases = await response.json();
	if (!Array.isArray(releases)) {
		throw new UpdateError('bad-response', 'invalid GitHub release list');
	}
	return releases;
}

async function fetchAsset(fetchFn, update, asset, signal) {
	let url = new URL(asset.url);
	if (url.href !== assetUrl(update.tag, asset.name)) {
		throw new UpdateError('origin', 'invalid GitHub release asset URL');
	}
	for (let redirects = 0; redirects < 4; redirects++) {
		const response = await fetchFn(url.href, {
			signal, redirect: 'manual', headers: { 'User-Agent': 'singularity-ide' }
		});
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			await response.body?.cancel();
			const location = response.headers.get('location');
			url = location ? new URL(location, url) : undefined;
			if (!url || url.origin !== downloadOrigin || url.username || url.password || url.hash) {
				throw new UpdateError('origin', 'untrusted GitHub asset redirect');
			}
			continue;
		}
		if (!response.ok || !response.body) {
			await response.body?.cancel();
			throw new UpdateError('http', `GitHub asset answered HTTP ${response.status}`);
		}
		return response;
	}
	throw new UpdateError('origin', 'too many asset redirects');
}

async function transfer(fetchFn, update, asset, file, signal, onProgress) {
	const response = await fetchAsset(fetchFn, update, asset, signal);
	const hash = crypto.createHash('sha256');
	let received = 0;
	await pipeline(Readable.fromWeb(response.body), new Transform({
		transform(chunk, _encoding, callback) {
			received += chunk.length;
			if (received > asset.size) {
				callback(new UpdateError('incomplete', 'asset exceeds its declared size'));
				return;
			}
			try {
				hash.update(chunk);
				onProgress?.({ received, total: asset.size });
				callback(null, chunk);
			} catch (error) {
				callback(error);
			}
		}
	}), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
	if (received !== asset.size) {
		throw new UpdateError('incomplete', 'asset size differs from release metadata');
	}
	return hash.digest('hex');
}

function validateManifest(manifest, update) {
	if (manifest?.repository !== OFFICIAL_REPO || manifest.tag !== update.tag || manifest.version !== update.version
		|| manifest.channel !== update.channel || manifest.workflow !== WORKFLOW || manifest.build !== 'passed'
		|| !/^[a-f0-9]{40}$/.test(manifest.commit) || !Array.isArray(manifest.assets)) {
		throw new UpdateError('manifest', 'release manifest does not match this GitHub release');
	}
	const selected = manifest.assets.filter(asset => asset?.name === update.installer.name);
	if (selected.length !== 1 || selected[0].arch !== update.arch || selected[0].target !== update.target
		|| selected[0].size !== update.installer.size || !/^[a-f0-9]{64}$/.test(selected[0].sha256)) {
		throw new UpdateError('manifest', 'release manifest does not match this installer');
	}
	return selected[0].sha256;
}

async function downloadVerified({
	fetchFn = fetch, update, dir = os.tmpdir(), onProgress, onVerifying, signal, verify = verifyProvenance
}) {
	const timeout = AbortSignal.timeout(20 * 60 * 1000);
	signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	signal.throwIfAborted();
	if (!parseVersion(update.tag) || update.tag !== `v${update.version}`
		|| !['user', 'system'].includes(update.target) || update.arch !== 'x64'
		|| update.installer.name !== installerName(update.version, update.target)
		|| !Number.isSafeInteger(update.installer.size) || update.installer.size < 1
		|| update.manifest.name !== MANIFEST_ASSET || update.sums.name !== CHECKSUM_ASSET
		|| [update.manifest, update.sums].some(asset => !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 65536)) {
		throw new UpdateError('manifest', 'invalid release asset descriptors');
	}
	const staging = await fsp.mkdtemp(path.join(dir, 'singularity-update-'));
	try {
		const manifestFile = path.join(staging, MANIFEST_ASSET);
		const sumsFile = path.join(staging, CHECKSUM_ASSET);
		await transfer(fetchFn, update, update.manifest, manifestFile, signal);
		const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
		const expected = validateManifest(manifest, update);
		const provenance = { repo: OFFICIAL_REPO, tag: update.tag, commit: manifest.commit, workflow: WORKFLOW, signal };
		await verify(manifestFile, provenance);
		await transfer(fetchFn, update, update.sums, sumsFile, signal);
		if (parseChecksums(await fsp.readFile(sumsFile, 'utf8')).get(update.installer.name) !== expected) {
			throw new UpdateError('checksum-mismatch', 'SHA256SUMS does not match the attested manifest');
		}
		const final = path.join(staging, update.installer.name);
		const partial = final + '.part';
		const digest = await transfer(fetchFn, update, update.installer, partial, signal, onProgress);
		if (digest !== expected) {
			throw new UpdateError('checksum-mismatch', 'installer digest does not match the attested manifest');
		}
		onVerifying?.();
		await verify(partial, provenance);
		signal.throwIfAborted();
		await fsp.rename(partial, final);
		return { path: final, sha256: digest, bytes: update.installer.size };
	} catch (error) {
		await fsp.rm(staging, { recursive: true, force: true });
		throw error;
	}
}

module.exports = {
	OFFICIAL_REPO, API_BASE, WORKFLOW, MANIFEST_ASSET, CHECKSUM_ASSET,
	parseVersion, compareVersions, installerName, selectUpdate, parseChecksums, listReleases, downloadVerified
};
