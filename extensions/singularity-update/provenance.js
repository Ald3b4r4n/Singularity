'use strict';

const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { createVerifier } = require('sigstore');

const repo = 'Ald3b4r4n/Singularity';
const repositoryId = '1444253669';
const workflow = '.github/workflows/singularity-release.yml';
const predicateType = 'https://slsa.dev/provenance/v1';
const oid = '1.3.6.1.4.1.57264.1.';

function assertIdentity(identity, ref, commit, workflowPath, repoName, repoId) {
	const repository = `https://github.com/${repoName}`;
	const expected = {
		9: `${repository}/${workflowPath}@${ref}`,
		10: commit,
		11: 'github-hosted',
		12: repository,
		13: commit,
		14: ref,
		15: repoId
	};
	for (const [id, value] of Object.entries(expected)) {
		const actual = identity?.oids?.find(entry => entry.oid?.id.join('.') === oid + id)?.value;
		const encoded = Buffer.from(value, 'utf8');
		const length = encoded.length < 128 ? [encoded.length] : [0x81, encoded.length];
		if (!actual || !Buffer.from(actual).equals(Buffer.concat([Buffer.from([0x0c, ...length]), encoded]))) {
			throw new Error('Unexpected attestation certificate claim: ' + id);
		}
	}
}

async function verifyArtifact(file, { repoName, repoId, ref, commit, workflowPath, signal }) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file, { signal })) {
		hash.update(chunk);
	}
	const digest = hash.digest('hex');
	const url = `https://api.github.com/repos/${repoName}/attestations/sha256:${digest}?per_page=30`;
	const response = await fetch(url, {
		signal, redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'singularity-ide' }
	});
	if (!response.ok) {
		throw new Error(`Attestation lookup failed (HTTP ${response.status}).`);
	}
	const body = await response.json();
	if (!Array.isArray(body.attestations) || !body.attestations.length) {
		throw new Error('No attestations for these bytes.');
	}

	const repository = `https://github.com/${repoName}`;
	const san = `${repository}/${workflowPath}@${ref}`;
	const verifier = await createVerifier({
		certificateIssuer: 'https://token.actions.githubusercontent.com',
		certificateIdentityURI: '^' + san.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
		tlogThreshold: 1, ctLogThreshold: 1, retry: 0, timeout: 10000
	});
	for (const { bundle } of body.attestations) {
		signal.throwIfAborted();
		try {
			const signer = verifier.verify(bundle);
			assertIdentity(signer.identity, ref, commit, workflowPath, repoName, repoId);
			const envelope = bundle.dsseEnvelope;
			const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
			if (envelope.payloadType === 'application/vnd.in-toto+json'
				&& statement._type === 'https://in-toto.io/Statement/v1'
				&& statement.predicateType === predicateType
				&& statement.subject?.some(subject => subject.digest?.sha256 === digest)) {
				return;
			}
		} catch {
			// Other attestations for the same bytes may have been issued by different workflows.
		}
	}
	throw new Error('No valid build attestation matches the release policy.');
}

async function verifyProvenance(file, claim) {
	const { tag, commit, signal } = claim;
	try {
		if (claim.repo !== repo || claim.workflow !== workflow
			|| !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-preview\.[0-9]+)?$/.test(tag)
			|| !/^[a-f0-9]{40}$/.test(commit)) {
			throw new Error('Invalid release provenance policy.');
		}
		await verifyArtifact(file, {
			repoName: repo, repoId: repositoryId, workflowPath: workflow, ref: `refs/tags/${tag}`, commit, signal
		});
	} catch (cause) {
		signal.throwIfAborted();
		const error = new Error('Could not verify GitHub build provenance.', { cause });
		error.code = 'provenance';
		throw error;
	}
}

module.exports = { verifyProvenance, verifyArtifact };
