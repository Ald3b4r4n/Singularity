'use strict';

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const product = require('../product.json');
const update = require('../extensions/singularity-update/update.js');

async function main() {
	const version = product.singularityVersion;
	const tag = `v${version}`;
	const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	if (!update.parseVersion(version) || process.env.GITHUB_REF !== `refs/tags/${tag}`
		|| process.env.GITHUB_REPOSITORY !== update.OFFICIAL_REPO || process.env.GITHUB_SHA !== commit) {
		throw new Error('Build the exact product tag in the official repository.');
	}

	const out = path.resolve('.build', 'singularity-release');
	await fsp.mkdir(out);
	const assets = [];
	for (const target of ['user', 'system']) {
		const name = update.installerName(version, target);
		const sourceDir = path.join('.build', 'win32-x64', `${target}-setup`);
		const packaged = JSON.parse(await fsp.readFile(path.join(sourceDir, 'product.json'), 'utf8'));
		if (packaged.commit !== commit || packaged.singularityVersion !== version || packaged.target !== target) {
			throw new Error(`Installer metadata does not match the release: ${name}`);
		}
		const dest = path.join(out, name);
		await fsp.copyFile(path.join(sourceDir, name), dest, fs.constants.COPYFILE_EXCL);
		const hash = createHash('sha256');
		for await (const chunk of fs.createReadStream(dest)) {
			hash.update(chunk);
		}
		const { size } = await fsp.stat(dest);
		assets.push({ name, arch: 'x64', target, sha256: hash.digest('hex'), size });
	}

	const notes = execFileSync('git', ['tag', '-l', tag, '--format=%(contents)'], { encoding: 'utf8' }).trim();
	const manifest = {
		repository: update.OFFICIAL_REPO, tag, version, commit,
		channel: version.includes('-preview.') ? 'preview' : 'stable',
		workflow: update.WORKFLOW, build: 'passed', assets
	};
	await fsp.writeFile(path.join(out, 'release-notes.md'), notes + '\n');
	await fsp.writeFile(path.join(out, update.MANIFEST_ASSET), JSON.stringify(manifest, null, 2) + '\n');
	await fsp.writeFile(path.join(out, update.CHECKSUM_ASSET), assets.map(a => `${a.sha256}  ${a.name}\n`).join(''));
}

main().catch(error => {
	console.error(error.message);
	process.exitCode = 1;
});
