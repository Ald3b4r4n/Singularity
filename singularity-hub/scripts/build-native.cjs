'use strict';
// Builds dist/singularity-job.exe (the Windows Job Object and DPAPI helper) when it is missing or older than native/job.cpp.
//
// Why `npm test` needs it: the history tests protect records with DPAPI and the recovery tests start jobs, both through this
// helper. On a clean checkout the helper does not exist yet, so those suites failed for a reason that had nothing to do with
// the code under test. A missing toolchain now stops here, with one clear message, instead of surfacing as unrelated failures.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') {
	console.log('native helper: not a Windows build, nothing to do');
	process.exit(0);
}

const root = path.join(__dirname, '..');
const source = path.join(root, 'native', 'job.cpp');
const output = path.join(root, 'dist', 'singularity-job.exe');

if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs) {
	console.log('native helper: up to date');
	process.exit(0);
}

const result = spawnSync('cmd.exe', ['/d', '/c', path.join(root, 'native', 'build.cmd')], { stdio: 'inherit' });
if (result.status !== 0 || !fs.existsSync(output)) {
	console.error('native helper: the build failed. Install the Visual Studio C++ build tools (component Microsoft.VisualStudio.Component.VC.Tools.x86.x64) and run "npm run build:native".');
	process.exit(1);
}
console.log('native helper: built');
