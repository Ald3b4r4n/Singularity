'use strict';
// Builds a LOCAL Windows x64 package of the Singularity IDE (never published) and checks the result.
//
//   node scripts/package-win32.cjs [--skip-gulp] [--installer] [--dest D:\dev\VSCode-win32-x64]
//
// Needs the Windows SDK (signtool.exe): the upstream "patchWin32Dependencies" step uses it to strip signatures before it
// rewrites the version information of native binaries. The script looks for it in "Windows Kits" and puts it on PATH.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs'), path = require('path');

const repo = path.resolve(__dirname, '..');
const dest = path.resolve(process.argv.includes('--dest') ? process.argv[process.argv.indexOf('--dest') + 1] : path.join(path.dirname(repo), 'VSCode-win32-x64'));
const installer = process.argv.includes('--installer');
const defaultDest = path.join(path.dirname(repo), 'VSCode-win32-x64');
if (installer && (dest !== defaultDest || process.argv.includes('--no-hub'))) {
	throw new Error('Installer packaging requires the default destination and the bundled Hub.');
}
const skipGulp = process.argv.includes('--skip-gulp');

function findSigntool() {
	const root = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
	if (!fs.existsSync(root)) { return undefined; }
	const versions = fs.readdirSync(root).filter(v => /^\d+\./.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
	for (const v of versions) {
		const p = path.join(root, v, 'x64', 'signtool.exe');
		if (fs.existsSync(p)) { return p; }
	}
	return undefined;
}

const fail = msg => { console.error('FAILED: ' + msg); process.exit(1); };

const env = { ...process.env };
const signtool = findSigntool();
if (!signtool) { fail('signtool.exe not found. Install the Windows SDK ("Windows Kits\\10") so the packaging step patchWin32Dependencies can run.'); }
env.PATH = `${env.PATH || env.Path};${path.dirname(signtool)}`;
console.log('signtool: ' + signtool);

if (!skipGulp) {
	console.log('running: npm run gulp vscode-win32-x64-min (takes about 7 minutes)');
	const r = spawnSync('npm', ['run', 'gulp', 'vscode-win32-x64-min'], { cwd: repo, env, stdio: 'inherit', shell: true });
	if (r.status !== 0) { fail(`the gulp pipeline exited with ${r.status}`); }
}

// ---- the Singularity Hub (compiled, production dependencies, bundled Node.js, licenses) ----
if (!process.argv.includes('--no-hub')) {
	console.log('adding the Singularity Hub');
	execFileSync(process.execPath, [path.join(__dirname, 'package-hub.cjs'), '--dest', dest], { stdio: 'inherit' });
}

// ---- checks on the result ----
const app = path.join(dest, 'resources', 'app');
const product = JSON.parse(fs.readFileSync(path.join(repo, 'product.json'), 'utf8'));
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ' ' + detail : ''}`); };

check('executable exists', fs.existsSync(path.join(dest, `${product.nameShort}.exe`)));
check('app folder exists', fs.existsSync(app));
for (const e of fs.readdirSync(path.join(repo, 'extensions')).filter(name => name.startsWith('singularity-'))) {
	check(`built-in extension ${e}`, fs.existsSync(path.join(app, 'extensions', e, 'package.json')));
}
check('the Copilot extension is not shipped (product.json: singularityBuild.shipBuiltInCopilot)', !fs.existsSync(path.join(app, 'extensions', 'copilot')));
check('no bin/copilot-shim', !fs.existsSync(path.join(dest, 'bin', 'copilot-shim')));
check('compiled workbench bootstrap with the opening', fs.readFileSync(path.join(app, 'out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.js'), 'utf8').includes('singularity-intro'));
if (!process.argv.includes('--no-hub')) {
	const hubDir = path.join(app, 'singularity-hub');
	for (const f of ['dist/main.js', 'dist/index.js', 'dist/cli.js', 'dist/singularity-job.exe', 'node_modules/ws/package.json', 'runtime/node.exe', 'LICENSES/node-LICENSE.txt', 'LICENSES/ws-LICENSE.txt', 'LICENSES/THIRD-PARTY.md']) {
		check(`hub file ${f}`, fs.existsSync(path.join(hubDir, f)));
	}
	check('hub tests are not shipped', !fs.existsSync(path.join(hubDir, 'dist', 'test')));
}
// third-party binaries must ship byte-for-byte as their authors built them (no rewritten version resources, no removed signatures)
const crypto = require('crypto');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const thirdParty = [['@vscode/ripgrep-universal/bin/win32-x64/rg.exe', 'node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/win32-x64/rg.exe']];
for (const [src, shipped] of thirdParty) {
	const original = path.join(repo, 'node_modules', src);
	const copy = path.join(app, shipped);
	const same = fs.existsSync(original) && fs.existsSync(copy) && sha(original) === sha(copy);
	check(`third-party binary identical to its source: ${shipped}`, same, same ? '' : '(missing or different)');
}
if (checks.some(c => !c.ok)) { fail('some checks failed'); }
const packagedProduct = require(path.join(app, 'product.json'));
const version = product.singularityVersion;
const { parseWindowsProductVersion } = require('../build/lib/singularityVersion.cjs');
const rawVersion = parseWindowsProductVersion(version);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
if (packagedProduct.commit !== commit || packagedProduct.singularityVersion !== version) {
	fail('the Windows payload is stale. Rebuild without --skip-gulp.');
}
const rcedit = path.join(path.dirname(require.resolve('rcedit')), '..', 'bin', 'rcedit.exe');
execFileSync(rcedit, [
	path.join(dest, `${product.nameShort}.exe`),
	'--set-file-version', rawVersion,
	'--set-product-version', rawVersion,
	'--set-version-string', 'ProductVersion', version,
	'--set-version-string', 'CompanyName', product.singularityPublisher
], { stdio: 'inherit' });
console.log('package OK: ' + dest);

if (installer) {
	const r = spawnSync('npm', ['run', 'gulp', 'vscode-win32-x64-user-setup', 'vscode-win32-x64-system-setup'], { cwd: repo, env, stdio: 'inherit', shell: true });
	if (r.status !== 0) { fail(`the installer build exited with ${r.status}`); }
}
