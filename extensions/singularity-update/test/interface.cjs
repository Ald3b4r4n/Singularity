'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../extension.js'), 'utf8');
const found = { version: '0.1.0-preview.10', channel: 'preview', notes: 'Release notes' };

function load({
	enableInstall = true, decisions = [], failure, listFailure, empty = false,
	hub = 'disconnected', dirty = false, storedVersion
} = {}) {
	const calls = { info: [], warnings: [], errors: [], install: [], reveal: [], downloads: 0 };
	const commands = new Map();
	const state = new Map([['singularity.update.expectedVersion', storedVersion]]);
	const vscode = {
		env: { appRoot: 'app' },
		l10n: { t: (text, ...args) => text.replace(/\{(\d+)\}/g, (_, index) => args[index]) },
		workspace: {
			getConfiguration: () => ({ get: () => false, inspect: () => undefined }),
			textDocuments: [{ isDirty: dirty }],
			notebookDocuments: []
		},
		window: {
			createOutputChannel: () => ({ appendLine() { } }),
			createStatusBarItem: () => ({ show() { }, hide() { } }),
			showInformationMessage: async (...args) => { calls.info.push(args); return decisions.shift(); },
			showWarningMessage: async message => { calls.warnings.push(message); },
			showErrorMessage: async message => { calls.errors.push(message); },
			withProgress: async (_, action) => action({ report() { } }, {
				isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { } })
			})
		},
		commands: {
			registerCommand: (name, action) => { commands.set(name, action); return { dispose() { } }; },
			getCommands: async () => ['_singularity.installUpdate'],
			executeCommand: async (command, args) => {
				if (command === '_singularity.installUpdate') { calls.install.push(args); return; }
				if (command === 'singularity.hub.updateState') { return hub; }
				if (command === 'revealFileInOS') { calls.reveal.push(args); return; }
				return commands.get(command)();
			}
		},
		ProgressLocation: { Notification: 1 },
		StatusBarAlignment: { Right: 2 },
		Uri: { file: value => value }
	};
	const updater = {
		listReleases: async () => {
			if (listFailure) { throw listFailure; }
			return empty ? [] : [{}];
		},
		selectUpdate: (releases, options) => {
			assert.equal(options.installed, '0.1.0-preview.2');
			assert.equal(options.channel, 'preview');
			return { update: releases.length ? found : undefined, skipped: [] };
		},
		downloadVerified: async () => {
			calls.downloads++;
			if (failure) { throw failure; }
			return { path: 'verified.exe', sha256: 'a'.repeat(64), bytes: 100 };
		}
	};
	const dependencies = {
		vscode,
		'./update.js': updater,
		fs: {
			readFileSync: () => JSON.stringify({
				singularityVersion: '0.1.0-preview.2', singularityUpdateInstall: enableInstall, target: 'user'
			}),
			mkdirSync() { }
		},
		os: { tmpdir: () => 'tmp' },
		path
	};
	const module = { exports: {} };
	vm.runInNewContext(source, {
		module, require: name => dependencies[name], AbortController,
		process: { platform: 'win32', arch: 'x64' }
	});
	module.exports.activate({
		subscriptions: [],
		globalState: {
			get: (key, fallback) => state.get(key) ?? fallback,
			update: async (key, value) => { state.set(key, value); }
		}
	});
	return { calls, check: () => commands.get('singularity.update.check')(), state };
}

test('reports absent releases and network errors separately', async () => {
	const empty = load({ empty: true });
	await empty.check();
	assert.match(empty.calls.info[0][0], /não tem releases/);
	const offline = load({ listFailure: new Error('offline') });
	await offline.check();
	assert.match(offline.calls.warnings[0], /Não foi possível verificar/);
});

test('shows both versions and notes before the user can defer the download', async () => {
	const ui = load({ decisions: ['Adiar'] });
	await ui.check();
	assert.match(ui.calls.info[0][1].detail, /0\.1\.0-preview\.2[\s\S]+0\.1\.0-preview\.10[\s\S]+Release notes/);
	assert.equal(ui.calls.downloads, 0);
	assert.deepEqual(ui.calls.install, []);
});

test('failed verification and disabled installation both keep the native action hidden', async () => {
	const failed = load({ decisions: ['Baixar atualização'], failure: Object.assign(new Error('invalid'), { code: 'provenance' }) });
	await failed.check();
	assert.equal(failed.calls.errors.length, 1);
	assert.deepEqual(failed.calls.install, []);
	const disabled = load({ decisions: ['Baixar atualização', 'Mostrar arquivo'], enableInstall: false });
	await disabled.check();
	assert(!disabled.calls.info.at(-1).includes('Instalar e reiniciar'));
	assert.deepEqual(disabled.calls.reveal, ['verified.exe']);
	assert.deepEqual(disabled.calls.install, []);
});

test('active Hub and unsaved work postpone installation', async () => {
	for (const options of [{ hub: 'connected' }, { dirty: true }]) {
		const ui = load({ ...options, decisions: ['Baixar atualização', 'Instalar e reiniciar'] });
		await ui.check();
		assert.equal(ui.calls.warnings.length, 1);
		assert.deepEqual(ui.calls.install, []);
	}
});

test('consent hands off the verified installer and records the expected version', async () => {
	const ui = load({ decisions: ['Baixar atualização', 'Instalar e reiniciar'] });
	await ui.check();
	assert.equal(ui.calls.install.length, 1);
	assert.equal(ui.calls.install[0].path, 'verified.exe');
	assert.equal(ui.calls.install[0].sha256, 'a'.repeat(64));
	assert.equal(ui.state.get('singularity.update.expectedVersion'), found.version);
});

test('relaunch confirms the running version against the pending version', () => {
	const ui = load({ storedVersion: '0.1.0-preview.2' });
	assert.match(ui.calls.info[0][0], /atualizado para 0\.1\.0-preview\.2/);
	assert.equal(ui.state.get('singularity.update.expectedVersion'), undefined);
	const unchanged = load({ storedVersion: '0.1.0-preview.10' });
	assert.match(unchanged.calls.warnings[0], /ficou pendente/);
});
