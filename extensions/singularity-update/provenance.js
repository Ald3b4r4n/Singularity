'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');

const gh = path.join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe');

async function verifyProvenance(file, { repo, tag, commit, workflow, signal }) {
	try {
		await promisify(execFile)(gh, [
			'attestation', 'verify', file,
			'--repo', repo, '--signer-workflow', `${repo}/${workflow}`,
			'--source-ref', `refs/tags/${tag}`, '--source-digest', commit,
			'--deny-self-hosted-runners'
		], { signal, windowsHide: true, timeout: 60000, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' } });
	} catch (cause) {
		if (signal.aborted) {
			throw signal.reason;
		}
		const error = new Error(cause.code === 'ENOENT'
			? 'GitHub CLI is required to verify installer provenance.'
			: 'GitHub CLI could not verify the release attestation.', { cause });
		error.code = cause.code === 'ENOENT' ? 'verifier-unavailable' : 'provenance';
		throw error;
	}
}

module.exports = { verifyProvenance };
