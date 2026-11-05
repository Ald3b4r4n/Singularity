import { strict as assert } from 'node:assert';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { cancelProviderInstall, installOffer, installProvider, managedProviderPath, ProviderInstallError, verifyProviderArchive } from '../providerInstall';

test('managed provider installer rejects modified packages before extraction', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'singularity-invalid-provider-'));
	try {
		const archive = join(directory, 'invalid.tgz');
		await writeFile(archive, 'not an official provider package');
		for (const provider of ['opencode', 'claude-code', 'codex-cli'] as const) {
			await assert.rejects(verifyProviderArchive(provider, archive), /integridade/);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('unapproved versions and planned providers are never offered for installation', async () => {
	assert.equal(installOffer('gemini-cli'), undefined);
	await assert.rejects(installProvider('opencode', '0.0.0', () => undefined), ProviderInstallError);
});

test('cancelled and offline installs leave no executable or staging files', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
	const directory = await mkdtemp(join(tmpdir(), 'singularity-provider-install-negative-'));
	const overrides = { LOCALAPPDATA: directory, HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '', SINGULARITY_OPENCODE: '' };
	const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
	Object.assign(process.env, overrides);
	try {
		const offer = installOffer('opencode')!;
		const attempt = installProvider('opencode', offer.version, () => undefined);
		assert.equal(cancelProviderInstall('opencode'), true);
		await assert.rejects(attempt, /cancelada/);
		const installRoot = dirname(dirname(managedProviderPath('opencode')!));
		assert.deepEqual(await readdir(installRoot), []);
		await assert.rejects(installProvider('opencode', offer.version, () => undefined), /download oficial falhou/);
		assert.deepEqual(await readdir(installRoot), []);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
		}
		await rm(directory, { recursive: true, force: true });
	}
});
