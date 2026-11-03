'use strict';
// Adds the Singularity Hub to a packaged Windows build.
//
//   node scripts/package-hub.cjs --dest D:\dev\VSCode-win32-x64 [--node <node.exe>]
//
// Result, next to the extensions (the extension finds it at ../../singularity-hub, same as in a checkout):
//   <dest>\resources\app\singularity-hub\
//       dist\            compiled Hub (no tests, no source maps)
//       node_modules\    production dependencies only (ws)
//       runtime\node.exe the Node.js that runs the Hub (K1: the Hub never depends on the user's PATH)
//       LICENSES\        license texts of Node.js and ws, THIRD-PARTY.md
//       package.json     without scripts and devDependencies
// Then the copy is verified by actually running it with the bundled runtime and an empty PATH.

const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const dest = arg('dest');
const nodeExe = path.resolve(arg('node', process.execPath));
if (!dest) { console.error('usage: package-hub.cjs --dest <packaged app folder> [--node <node.exe>]'); process.exit(2); }

const repo = path.resolve(__dirname, '..');
const hub = path.join(repo, 'singularity-hub');
const app = path.join(path.resolve(dest), 'resources', 'app');
if (!fs.existsSync(path.join(app, 'extensions', 'singularity-agents'))) { throw new Error(`${app} is not a Singularity package (extensions/singularity-agents missing)`); }
const target = path.join(app, 'singularity-hub');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' && /\.(cmd|bat)$|^npm$/.test(cmd), ...opts });
const copy = (from, to, filter) => fs.cpSync(from, to, { recursive: true, filter });

console.log('1/5 compile the Hub');
run('npm', ['run', 'build'], { cwd: hub });

console.log('2/5 production dependencies in a clean staging folder');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'singularity-hub-stage-'));
for (const f of ['package.json', 'package-lock.json']) { fs.copyFileSync(path.join(hub, f), path.join(stage, f)); }
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-fund', '--no-audit'], { cwd: stage });

console.log('3/5 assemble ' + target);
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
copy(path.join(hub, 'dist'), path.join(target, 'dist'), src => !/[\\/]dist[\\/]test([\\/]|$)/.test(src) && !/\.(map|d\.ts)$/.test(src));
copy(path.join(stage, 'node_modules'), path.join(target, 'node_modules'));
const pkg = JSON.parse(fs.readFileSync(path.join(hub, 'package.json'), 'utf8'));
delete pkg.scripts; delete pkg.devDependencies;
fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
fs.copyFileSync(path.join(hub, 'README.md'), path.join(target, 'README.md'));
fs.mkdirSync(path.join(target, 'runtime'));
fs.copyFileSync(nodeExe, path.join(target, 'runtime', 'node.exe'));

console.log('4/5 licenses');
const lic = path.join(target, 'LICENSES');
fs.mkdirSync(lic);
const nodeLicense = path.join(path.dirname(nodeExe), 'LICENSE');
if (!fs.existsSync(nodeLicense)) { throw new Error('the Node.js LICENSE file was not found next to ' + nodeExe + '; refusing to ship a runtime without its license'); }
fs.copyFileSync(nodeLicense, path.join(lic, 'node-LICENSE.txt'));
const wsDir = path.join(target, 'node_modules', 'ws');
const wsLicense = path.join(wsDir, 'LICENSE');
if (!fs.existsSync(wsLicense)) { throw new Error('the ws LICENSE file is missing'); }
fs.copyFileSync(wsLicense, path.join(lic, 'ws-LICENSE.txt'));
const nodeVersion = execFileSync(nodeExe, ['--version'], { encoding: 'utf8' }).trim();
const wsVersion = JSON.parse(fs.readFileSync(path.join(wsDir, 'package.json'), 'utf8')).version;
fs.writeFileSync(path.join(lic, 'THIRD-PARTY.md'), `# Third-party components of the Singularity Hub

| Component | Version | License | File |
|---|---|---|---|
| Node.js runtime (\`runtime/node.exe\`), unmodified official binary | ${nodeVersion} | MIT (and the licenses of its bundled dependencies, listed in the same file) | node-LICENSE.txt |
| ws (\`node_modules/ws\`) | ${wsVersion} | MIT | ws-LICENSE.txt |

The Singularity Hub itself is MIT licensed (see the repository LICENSE).
`);
fs.rmSync(stage, { recursive: true, force: true });

console.log('5/5 verify with the bundled runtime and an empty PATH');
const env = { SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), PATH: '' };
const out = execFileSync(path.join(target, 'runtime', 'node.exe'), ['-e', "const h=require('./dist/index.js'); require('ws'); const l=require('./dist/launch.js'); console.log(JSON.stringify({node: process.version, protocol: h.PROTOCOL, findNode: l.findNode({}, l.HUB_ROOT)}))"], { cwd: target, env, encoding: 'utf8' });
const info = JSON.parse(out);
if (!info.findNode || path.resolve(info.findNode) !== path.join(target, 'runtime', 'node.exe')) { throw new Error('the Hub does not pick its bundled runtime: ' + out); }
const size = (p) => { let t = 0; for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); t += e.isDirectory() ? size(f) : fs.statSync(f).size; } return t; };
console.log(`ok: ${target} (${(size(target) / 1048576).toFixed(1)} MB), Node ${info.node}, protocol ${JSON.stringify(info.protocol)}`);
