'use strict';

const { verifyArtifact } = require('../provenance.js');
const { setTimeout: sleep } = require('node:timers/promises');
const { rm, writeFile } = require('node:fs/promises');

const file = process.argv[2];
const env = process.env;
const policy = {
	repoName: 'Ald3b4r4n/Singularity', repoId: '1444253669',
	workflowPath: '.github/workflows/singularity-release.yml', ref: env.GITHUB_REF, commit: env.GITHUB_SHA
};

async function main() {
	for (let attempt = 0; ; attempt++) {
		try {
			await verifyArtifact(file, { ...policy, signal: AbortSignal.timeout(30000) });
			break;
		} catch (error) {
			if (attempt === 5) {
				throw error;
			}
			await sleep(5000);
		}
	}
	await writeFile(file, 'modified synthetic data');
	try {
		await verifyArtifact(file, { ...policy, signal: AbortSignal.timeout(30000) });
		throw new Error('Modified bytes were unexpectedly verified.');
	} catch (error) {
		if (!/HTTP 404|No attestations|No valid build attestation/.test(error.message)) {
			throw error;
		}
	} finally {
		await rm(file, { force: true });
	}
	console.log('Verified real GitHub attestation anonymously and rejected modified bytes.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
