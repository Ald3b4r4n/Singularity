'use strict';
// Adds the Singularity Hub to a packaged Windows build.
//
//   node scripts/package-hub.cjs --dest D:\dev\VSCode-win32-x64 [--node <node.exe>] [--node-zip <zip>] [--node-shasums <file>]
//
// Result, next to the extensions (the extension finds it at ../../singularity-hub, same as in a checkout):
//   <dest>\resources\app\singularity-hub\
//       dist\            compiled Hub (no tests, no source maps)
//       node_modules\    production dependencies only (ws)
//       runtime\node.exe the Node.js that runs the Hub, proven to be the official binary of its version (K1)
//       LICENSES\        license texts of Node.js and ws, THIRD-PARTY.md
//       package.json     without scripts and devDependencies
// The copy is then verified by running it with the bundled runtime and an empty PATH.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs'), https = require('https'), os = require('os'), path = require('path');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const dest = arg('dest');
const nodeExe = path.resolve(arg('node', process.execPath));
if (!dest) { console.error('usage: package-hub.cjs --dest <packaged app folder> [--node <node.exe>]'); process.exit(2); }

const repo = path.resolve(__dirname, '..');
const hub = path.join(repo, 'singularity-hub');
const app = path.join(path.resolve(dest), 'resources', 'app');
if (!fs.existsSync(path.join(app, 'extensions', 'singularity-agents'))) { throw new Error(`${app} is not a Singularity package (extensions/singularity-agents missing)`); }
const target = path.join(app, 'singularity-hub');

const sha256File = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' && /\.(cmd|bat)$|^npm$/.test(cmd), ...opts });
const copy = (from, to, filter) => fs.cpSync(from, to, { recursive: true, filter });

function fetchBuffer(url) {
	return new Promise((resolve, reject) => {
		https.get(url, res => {
			if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url}: HTTP ${res.statusCode}`)); }
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => resolve(Buffer.concat(chunks)));
		}).on('error', reject);
	});
}

/**
 * Proves that nodeExe is the official Node.js binary for its version:
 *  1. the official win-x64 zip is downloaded (or taken from --node-zip);
 *  2. its SHA-256 must be listed for that zip in the official SHASUMS256.txt (or --node-shasums);
 *  3. the node.exe inside the zip must be byte-identical to the one that will be shipped.
 * This checks the binary against the published digests. Verifying the GPG signature of SHASUMS256.txt is a separate
 * manual step, documented in docs/local-packaged-build.md.
 */
async function verifyNodeProvenance(exe) {
	const version = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim();
	const base = `node-${version}-win-x64`;
	const shasums = arg('node-shasums')
		? fs.readFileSync(arg('node-shasums'), 'utf8')
		: (await fetchBuffer(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).toString('utf8');
	const zipPath = arg('node-zip') || path.join(os.tmpdir(), `${base}.zip`);
	if (!arg('node-zip')) { fs.writeFileSync(zipPath, await fetchBuffer(`https://nodejs.org/dist/${version}/${base}.zip`)); }

	const listed = shasums.split(/\r?\n/).map(l => l.trim().split(/\s+/)).find(parts => parts[1] === `${base}.zip`);
	if (!listed) { throw new Error(`${base}.zip is not listed in the SHASUMS256.txt for ${version}`); }
	const zipHash = sha256File(zipPath);
	if (zipHash !== listed[0].toLowerCase()) { throw new Error(`zip SHA-256 ${zipHash} does not match the published ${listed[0]}`); }

	const extract = fs.mkdtempSync(path.join(os.tmpdir(), 'node-zip-'));
	try {
		execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extract}' -Force`], { stdio: 'ignore' });
		const official = path.join(extract, base, 'node.exe');
		if (!fs.existsSync(official) || sha256File(official) !== sha256File(exe)) {
			throw new Error(`the node.exe to ship is not byte-identical to the official ${version} binary`);
		}
	} finally {
		fs.rmSync(extract, { recursive: true, force: true });
	}
	return { version, zipSha256: zipHash };
}

async function main() {
	console.log('0/5 provenance of the Node.js runtime');
	const provenance = await verifyNodeProvenance(nodeExe);
	console.log(`    official ${provenance.version}, zip sha256 ${provenance.zipSha256}`);

	console.log('1/5 compile the Hub');
	run('npm', ['run', 'build'], { cwd: hub });
	run('cmd.exe', ['/d', '/c', 'native\\build.cmd'], { cwd: hub });

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
	const wsVersion = JSON.parse(fs.readFileSync(path.join(wsDir, 'package.json'), 'utf8')).version;
	fs.writeFileSync(path.join(lic, 'THIRD-PARTY.md'), `# Third-party components of the Singularity Hub

| Component | Version | License | File |
|---|---|---|---|
| Node.js runtime (\`runtime/node.exe\`), unmodified official binary, SHA-256 of the official zip ${provenance.zipSha256} | ${provenance.version} | MIT (and the licenses of its bundled dependencies, listed in the same file) | node-LICENSE.txt |
| ws (\`node_modules/ws\`) | ${wsVersion} | MIT | ws-LICENSE.txt |

The Singularity Hub itself is MIT licensed (see the repository LICENSE).
`);
	fs.rmSync(stage, { recursive: true, force: true });

	console.log('5/5 verify with the bundled runtime and an empty PATH');
	const env = { SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), PATH: '' };
	const out = execFileSync(path.join(target, 'runtime', 'node.exe'), ['-e', "const h=require('./dist/index.js'); require('ws'); const l=require('./dist/launch.js'); console.log(JSON.stringify({node: process.version, protocol: h.PROTOCOL, findNode: l.findNode({}, l.HUB_ROOT)}))"], { cwd: target, env, encoding: 'utf8' });
	const info = JSON.parse(out);
	if (!info.findNode || path.resolve(info.findNode) !== path.join(target, 'runtime', 'node.exe')) { throw new Error('the Hub does not pick its bundled runtime: ' + out); }
	const size = p => fs.readdirSync(p, { withFileTypes: true }).reduce((t, e) => { const f = path.join(p, e.name); return t + (e.isDirectory() ? size(f) : fs.statSync(f).size); }, 0);
	console.log(`ok: ${target} (${(size(target) / 1048576).toFixed(1)} MB), Node ${info.node}, protocol ${JSON.stringify(info.protocol)}`);
}

main().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
