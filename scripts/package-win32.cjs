'use strict';
// Builds a LOCAL Windows x64 package of the Singularity IDE (never published) and checks the result.
//
//   node scripts/package-win32.cjs [--skip-gulp] [--dest D:\dev\VSCode-win32-x64]
//
// Needs the Windows SDK (signtool.exe): the upstream "patchWin32Dependencies" step uses it to strip signatures before it
// rewrites the version information of native binaries. The script looks for it in "Windows Kits" and puts it on PATH.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs'), path = require('path');

const repo = path.resolve(__dirname, '..');
const dest = path.resolve(process.argv.includes('--dest') ? process.argv[process.argv.indexOf('--dest') + 1] : path.join(path.dirname(repo), 'VSCode-win32-x64'));
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

// ---- checks on the result ----
const app = path.join(dest, 'resources', 'app');
const product = JSON.parse(fs.readFileSync(path.join(repo, 'product.json'), 'utf8'));
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ' ' + detail : ''}`); };

check('executable exists', fs.existsSync(path.join(dest, `${product.nameShort}.exe`)));
check('app folder exists', fs.existsSync(app));
for (const e of ['singularity-theme', 'singularity-welcome', 'singularity-agents']) {
	check(`built-in extension ${e}`, fs.existsSync(path.join(app, 'extensions', e, 'package.json')));
}
check('the Copilot extension is not shipped (product.json: singularityBuild.shipBuiltInCopilot)', !fs.existsSync(path.join(app, 'extensions', 'copilot')));
check('no bin/copilot-shim', !fs.existsSync(path.join(dest, 'bin', 'copilot-shim')));
check('compiled workbench bootstrap with the opening', fs.readFileSync(path.join(app, 'out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.js'), 'utf8').includes('singularity-intro'));
const rg = fs.readdirSync(path.join(app, 'node_modules.asar.unpacked'), { recursive: true }).find(f => /rg\.exe$/.test(String(f)));
if (rg) {
	const info = execFileSync('pwsh', ['-NoProfile', '-Command', `(Get-Item '${path.join(app, 'node_modules.asar.unpacked', String(rg))}').VersionInfo.CompanyName`], { encoding: 'utf8' }).trim();
	check('patched binaries carry the Singularity company name, not Microsoft', info === 'Singularity IDE contributors', `(${info})`);
}
if (checks.some(c => !c.ok)) { fail('some checks failed'); }
console.log('package OK: ' + dest);
