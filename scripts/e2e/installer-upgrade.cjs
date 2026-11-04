'use strict';

// Real per-user Windows install and in-place update against two local installers.
// node scripts/e2e/installer-upgrade.cjs <A.exe> <B.exe> <output-directory>
const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const lib = require('./lib.cjs');
const product = require('../../product.json');

const [initialInstaller, updateInstaller, outputDirectory] = process.argv.slice(2);
assert(initialInstaller && updateInstaller && outputDirectory, 'Supply both installers and a fresh output directory.');

const out = path.resolve(outputDirectory);
const dest = path.join(out, 'installed');
const profile = path.join(out, 'profile');
const workspace = path.join(out, 'workspace');
const secondWorkspace = path.join(out, 'second-window');
const exe = path.join(dest, `${product.nameShort}.exe`);
const app = path.join(dest, 'resources', 'app');
const hub = path.join(app, 'singularity-hub');
const node = path.join(hub, 'runtime', 'node.exe');
const uninstallKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${product.win32x64UserAppId.slice(1)}_is1`;
const appEnv = {
	SINGULARITY_HUB_HOME: path.join(profile, 'hub'),
	PATH: process.env.PATH.split(path.delimiter).filter(dir => !fs.existsSync(path.join(dir, 'node.exe'))).join(path.delimiter)
};
const port = 9400 + Math.floor(Math.random() * 400);
const report = { steps: [] };
let page;
let ownsInstall = false;
let ownsOutput = false;

function run(file, args, options = {}) {
	const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 180000, ...options });
	if (result.error) {
		throw result.error;
	}
	return result;
}

function registryEntry() {
	return run('reg.exe', ['query', uninstallKey, '/reg:64']);
}

function install(file, step, initial = false) {
	const log = path.join(out, `${step}.log`);
	const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LANG=english', '/TASKS=', `/LOG=${log}`];
	if (initial) {
		args.push(`/DIR=${dest}`, '/GROUP=Singularity IDE Upgrade E2E');
	}
	const result = run(path.resolve(file), args);
	return { code: result.status, log: fs.readFileSync(log, 'utf8') };
}

function git(...args) {
	return execFileSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true }).trim();
}

function hubCommand(command) {
	return run(node, [path.join(hub, 'dist', 'cli.js'), command], { env: { ...process.env, ...appEnv } });
}

function hubStatus() {
	return JSON.parse(hubCommand('status').stdout);
}

function executableVersion(file) {
	const escaped = path.resolve(file).replaceAll("'", "''");
	return lib.ps(`(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion.Trim()`);
}

function installedVersion() {
	return JSON.parse(fs.readFileSync(path.join(app, 'product.json'), 'utf8')).singularityVersion;
}

async function waitFor(condition, description) {
	const deadline = Date.now() + 60000;
	do {
		if (await condition()) {
			return;
		}
		await lib.sleep(350);
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${description}`);
}

async function openIde() {
	lib.launch({ exe, profile, workspace, port, env: appEnv });
	page = await lib.cdp(port);
	await waitFor(() => page.evaluate("window.__singularityWorkbenchRestored && !document.getElementById('singularity-intro')"), 'workbench');
	await front();
}

async function front() {
	try {
		lib.guard(profile);
	} catch {
		await lib.bringToFront(profile);
		lib.keys(profile, '{ESC}');
	}
}

async function closeIde() {
	if (lib.appProcesses(profile).length) {
		const windows = await lib.pages(port).catch(() => []);
		if (windows.length > 1) {
			await front();
			lib.keys(profile, '^+w');
			await waitFor(async () => (await lib.pages(port)).length < windows.length, 'one IDE window to close');
		}
	}
	page?.close();
	page = undefined;
	const result = await lib.closeApp(profile, 25000);
	assert.equal(result.forced, 0, 'The test required a forced IDE close.');
}

async function step(label, action) {
	try {
		await action();
		report.steps.push({ label, passed: true });
		console.log(`PASS ${label}`);
	} catch (error) {
		report.steps.push({ label, passed: false, error: error.message });
		throw error;
	}
}

const browserPaths = new Set();
const server = http.createServer((req, res) => {
	browserPaths.add(req.url);
	res.writeHead(200, { 'Content-Type': 'text/html' });
	res.end('<title>Upgrade E2E</title><h1>Singularity upgrade browser check</h1>');
});

async function exerciseBrowser(label) {
	await front();
	await lib.runCommand(profile, 'Singularity Browser: Open Browser', 2200);
	lib.keys(profile, '^l');
	lib.paste(profile, `http://127.0.0.1:${server.address().port}/${label}`);
	lib.keys(profile, '{ENTER}');
	await waitFor(() => browserPaths.has(`/${label}`), 'the browser request');
	await page.screenshot(path.join(out, `browser-${label}.png`));
}

async function cancelInteractiveSetup() {
	const log = path.join(out, 'cancelled-b.log');
	const installer = spawn(path.resolve(updateInstaller), ['/LANG=english', '/NORESTART', `/LOG=${log}`], { stdio: 'ignore' });
	const exited = once(installer, 'exit');
	try {
		lib.ps(`
			Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
			function Invoke-SetupButton($property, $value) {
				for ($i = 0; $i -lt 25; $i++) {
					$children = @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${installer.pid}' | ForEach-Object ProcessId)
					foreach ($target in @(${installer.pid}) + $children) {
						$owner = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$target)
						$windows = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $owner)
						foreach ($window in $windows) {
							$match = [Windows.Automation.PropertyCondition]::new($property, $value)
							$button = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $match)
							if ($button -and $button.Current.ControlType -eq [Windows.Automation.ControlType]::Button) {
								$button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
								return
							}
						}
					}
					Start-Sleep -Milliseconds 350
				}
				throw "Could not find setup button $value."
			}
			Invoke-SetupButton ([Windows.Automation.AutomationElement]::NameProperty) 'Cancel'
			Invoke-SetupButton ([Windows.Automation.AutomationElement]::AutomationIdProperty) '6'
		`);
		const [code] = await exited;
		assert.equal(code, 2);
		assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /Starting the installation process/);
	} finally {
		if (installer.exitCode === null) {
			installer.kill();
			await exited;
		}
	}
}

async function main() {
	assert(!fs.existsSync(out), 'Use a fresh output directory.');
	assert.notEqual(path.resolve(initialInstaller), path.resolve(updateInstaller));
	assert(fs.existsSync(initialInstaller) && fs.existsSync(updateInstaller), 'Both installers must be built before this test.');
	const versionA = executableVersion(initialInstaller);
	const versionB = executableVersion(updateInstaller);
	assert.notEqual(versionA, versionB, 'Installers must carry distinct version metadata.');
	assert.equal(versionB, product.singularityVersion, 'B does not match the source product version.');
	assert.notEqual(registryEntry().status, 0, 'An existing per-user install occupies the product AppId.');
	fs.mkdirSync(workspace, { recursive: true });
	ownsOutput = true;
	fs.mkdirSync(secondWorkspace);
	const projectFile = path.join(workspace, 'sample.txt');
	const settingsFile = path.join(profile, 'data', 'User', 'settings.json');
	const extension = path.join(profile, 'ext', 'synthetic.upgrade-probe-1.0.0');
	const settings = {
		'security.workspace.trust.enabled': false,
		'workbench.startupEditor': 'none',
		'workbench.colorTheme': 'Event Minimal Light',
		'editor.tabSize': 7
	};
	const extensionManifest = {
		name: 'upgrade-probe', publisher: 'synthetic', version: '1.0.0', engines: { vscode: '^1.90.0' },
		contributes: { commands: [{ command: 'synthetic.upgradeProbe', title: 'Synthetic Upgrade Probe' }] }
	};
	fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
	fs.writeFileSync(settingsFile, JSON.stringify(settings));
	fs.mkdirSync(extension, { recursive: true });
	fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify(extensionManifest));
	fs.writeFileSync(projectFile, 'committed\n');
	git('init', '-q');
	git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', 'add', 'sample.txt');
	git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', 'commit', '-qm', 'initial fixture');
	const head = git('rev-parse', 'HEAD');
	fs.appendFileSync(projectFile, 'local work\n');
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

	await step('install A and open synthetic profile', async () => {
		const result = install(initialInstaller, 'install-a', true);
		ownsInstall = fs.existsSync(path.join(dest, 'unins000.exe'));
		assert.equal(result.code, 0);
		report.before = installedVersion();
		assert.equal(report.before, versionA);
		assert.equal(executableVersion(exe), versionA);
		await openIde();
		await exerciseBrowser('before');
		await front();
		await lib.runCommand(profile, 'Singularity: Abrir painel de agentes', 4500);
		await waitFor(() => hubStatus().running, 'Hub connected to A');
		await page.screenshot(path.join(out, 'hub-before.png'));
	});

	await step('update blocked while two IDE windows and Hub are active', async () => {
		lib.launch({ exe, profile, workspace: secondWorkspace, files: ['--new-window'], port, env: appEnv });
		await waitFor(async () => (await lib.pages(port)).length >= 2, 'two workbench windows');
		const result = install(updateInstaller, 'blocked-ide');
		assert.notEqual(result.code, 0);
		assert.equal(installedVersion(), report.before);
		assert(hubStatus().running);
		assert(lib.appProcesses(profile).length > 0);
		await closeIde();
	});

	await step('update blocked while only the independent Hub is active', async () => {
		const instance = hubStatus();
		assert(instance.running);
		const result = install(updateInstaller, 'blocked-hub');
		assert.notEqual(result.code, 0);
		assert.match(result.log, /Stop the Hub/);
		assert.equal(hubStatus().instanceId, instance.instanceId);
		assert.equal(installedVersion(), report.before);
		assert.equal(hubCommand('stop').status, 0);
		await waitFor(() => !hubStatus().running, 'graceful Hub shutdown');
	});

	await step('legacy background mode is rejected before changing A', async () => {
		const log = path.join(out, 'blocked-background.log');
		const result = run(path.resolve(updateInstaller), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/update=invalid', `/LOG=${log}`]);
		assert.notEqual(result.status, 0);
		assert.equal(installedVersion(), report.before);
	});

	await step('the user cancels B in the wizard before file copy', async () => {
		await cancelInteractiveSetup();
		assert.equal(installedVersion(), report.before);
	});

	await step('a truncated installer leaves A in place', async () => {
		const partial = path.join(out, 'truncated-b.exe');
		const source = fs.openSync(updateInstaller, 'r');
		const header = Buffer.alloc(1024 * 1024);
		try {
			assert.equal(fs.readSync(source, header), header.length);
		} finally {
			fs.closeSync(source);
		}
		fs.writeFileSync(partial, header);
		try {
			const process = spawn(partial, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { stdio: 'ignore' });
			const exited = once(process, 'exit');
			try {
				const dialog = lib.ps(`
					Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
					$p = Get-Process -Id ${process.pid}
					for ($i = 0; $i -lt 25 -and !$p.HasExited -and !$p.MainWindowHandle; $i++) {
						Start-Sleep -Milliseconds 350
						$p.Refresh()
					}
					if ($p.MainWindowHandle) {
						$root = [Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
						$root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) |
							ForEach-Object { $_.Current.Name }
						[void]$p.CloseMainWindow()
					}`);
				assert.match(dialog, /setup files are corrupted/i);
				const [exitCode] = await exited;
				assert.equal(exitCode, 1);
				assert.equal(installedVersion(), report.before);
			} finally {
				if (process.exitCode === null) {
					process.kill();
					await exited;
				}
			}
		} finally {
			fs.unlinkSync(partial);
		}
	});

	await step('install B in the same destination', async () => {
		const result = install(updateInstaller, 'install-b');
		assert.equal(result.code, 0);
		report.after = installedVersion();
		assert.equal(report.after, versionB);
		assert.equal(executableVersion(exe), versionB);
		assert.match(registryEntry().stdout, new RegExp(report.after.replaceAll('.', '\\.')));
		assert.equal(git('rev-parse', 'HEAD'), head);
		assert.equal(git('status', '--porcelain'), 'M sample.txt');
		assert.equal(fs.readFileSync(projectFile, 'utf8'), 'committed\nlocal work\n');
		assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), settings);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(extension, 'package.json'), 'utf8')), extensionManifest);
	});

	await step('launch B and verify retained theme, user extension, Browser, and Hub', async () => {
		await openIde();
		assert(await page.evaluate("document.querySelector('.monaco-workbench')?.classList.contains('vs')"));
		await front();
		lib.keys(profile, '{F1}');
		lib.paste(profile, 'Synthetic Upgrade Probe');
		await waitFor(() => page.evaluate("(document.querySelector('.quick-input-widget')?.innerText ?? '').includes('Synthetic Upgrade Probe')"), 'user extension command');
		lib.keys(profile, '{ESC}');
		await waitFor(() => page.evaluate("!!document.querySelector('.singularity-account-entry')?.getBoundingClientRect().width"), 'GitHub account entry');
		await exerciseBrowser('after');
		await front();
		await lib.runCommand(profile, 'Terminal: Create New Terminal', 3500);
		const terminalProbe = path.join(out, 'terminal-git.txt');
		lib.paste(profile, `git rev-parse HEAD | Set-Content -Encoding ascii -LiteralPath '${terminalProbe.replaceAll("'", "''")}'`);
		lib.keys(profile, '{ENTER}');
		await waitFor(() => fs.existsSync(terminalProbe), 'Git command in the terminal');
		assert.equal(fs.readFileSync(terminalProbe, 'utf8').trim(), head);
		await front();
		await lib.runCommand(profile, 'Singularity: Abrir painel de agentes', 4500);
		await waitFor(() => hubStatus().running, 'Hub connected to B');
		await page.screenshot(path.join(out, 'hub-after.png'));
		assert.equal(hubCommand('stop').status, 0);
		await waitFor(() => !hubStatus().running, 'Hub shutdown');
		await closeIde();
	});
}

main().then(() => {
	report.ok = true;
}).catch(error => {
	console.error(error);
	process.exitCode = 1;
	report.ok = false;
	report.error = error.message;
}).finally(async () => {
	server.close();
	if (!ownsOutput) {
		return;
	}
	try {
		if (!ownsInstall) {
			return;
		}
		if (lib.appProcesses(profile).length) {
			await closeIde();
		}
		if (fs.existsSync(node) && hubStatus().running) {
			hubCommand('stop');
			await waitFor(() => !hubStatus().running, 'Hub cleanup');
		}
		const result = run(path.join(dest, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
		assert.equal(result.status, 0, 'Test installation cleanup failed.');
		assert.notEqual(registryEntry().status, 0, 'The uninstall entry remains.');
	} catch (error) {
		report.ok = false;
		report.cleanupError = error.message;
		process.exitCode = 1;
	} finally {
		fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
	}
});
