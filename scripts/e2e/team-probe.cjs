'use strict';
// Starts one real team (OpenCode Go only) straight on a packaged Hub in a synthetic repository and prints how it ends, with the error text.
//   node scripts/e2e/team-probe.cjs --out <dir> --hub <packaged singularity-hub dir> --node <packaged node.exe>
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i < 0 ? fallback : process.argv[i + 1]; };
const hubDir = path.resolve(arg('hub')), nodeExe = arg('node'), outDir = path.resolve(arg('out', 'team-probe-out'));
const home = path.join(outDir, 'hub'), work = path.join(outDir, 'repo');
fs.mkdirSync(work, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8', windowsHide: true }).trim();
git('init', '-q', '-b', 'main'); git('config', 'user.email', 'e2e@example.invalid'); git('config', 'user.name', 'E2E');
fs.writeFileSync(path.join(work, 'README.md'), '# probe\n'); git('add', '.'); git('commit', '-q', '-m', 'initial');
const { HubConnection } = require(path.join(hubDir, 'dist/client.js'));
(async () => {
	const child = spawn(nodeExe, [path.join(hubDir, 'dist/main.js')], { env: { ...process.env, SINGULARITY_HUB_HOME: home }, windowsHide: true, stdio: 'ignore' });
	let hub;
	for (let i = 0; i < 100 && !hub; i++) { try { hub = await HubConnection.connect({ home, clientName: 'probe' }); } catch { await delay(150); } }
	const catalog = await hub.request('catalog.get', { workspace: work }, 120000);
	const go = catalog.providers.find(p => p.id === 'opencode-go').models;
	const muse = go.find(m => /^muse-spark-1\.3.*contributor/.test(m.id)), flash = go.find(m => m.id === 'deepseek-v4.1-flash');
	const pick = m => ({ service: 'opencode', model: { providerID: 'opencode-go', modelID: m.id } });
	const team = await hub.request('teams.start', { workspace: work, text: 'Crie o arquivo ehPar.js que exporta ehPar(n) (true para números pares). Responda só "feito".', participants: [pick(muse), pick(flash), pick(muse)], maxCorrections: 2 }, 120000);
	const end = Date.now() + 20 * 60000;
	let last = '';
	while (Date.now() < end) {
		const t = (await hub.request('teams.list', { workspace: work })).find(x => x.id === team.id);
		const line = `${t.state} phase=${t.phase} cycle=${t.cycle} steps=${t.steps.map(s => `${s.role}:${s.status}${s.error ? '(' + s.error.slice(0, 120) + ')' : ''}`).join(',')} error=${t.error || ''}`;
		if (line !== last) { console.log(new Date().toISOString(), line); last = line; }
		if (['completed', 'failed', 'cancelled', 'exhausted', 'unrecoverable', 'awaiting-validation', 'paused'].includes(t.state)) { console.log('RESULT', JSON.stringify({ state: t.state, error: t.error, versions: t.versions.length, steps: t.steps.map(s => ({ role: s.role, status: s.status, error: s.error, result: (s.result || '').slice(0, 300) })) })); break; }
		await delay(2000);
	}
	for (const group of (await hub.request('comparisons.list', { workspace: work })).filter(c => c.team)) {
		const cleanEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' };
		console.log('BASE', group.base);
		for (const p of group.participants) { try { console.log('DEEP', p.role, 'head=' + execFileSync('git', ['-C', p.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: cleanEnv, windowsHide: true }).trim().slice(0, 12), 'status(clean env)=' + JSON.stringify(execFileSync('git', ['-C', p.workspace, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8', env: cleanEnv, windowsHide: true }).trim().slice(0, 300))); } catch (e) { console.log('DEEP', p.role, 'failed', String(e.message).slice(0, 200)); } }
		for (const p of group.participants) { try { console.log('WORKTREE', p.role, p.status, JSON.stringify(execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: p.workspace, encoding: 'utf8', windowsHide: true }).trim().slice(0, 400))); } catch (e) { console.log('WORKTREE', p.role, 'git failed', String(e.message).slice(0, 120)); } }
	}
	await hub.request('hub.shutdown', {}).catch(() => undefined);
	await delay(1000); try { child.kill(); } catch { /* gone */ }
	process.exit(0);
})().catch(error => { console.log('ERR', error.message); process.exit(1); });
