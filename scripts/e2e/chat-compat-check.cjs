'use strict';
// Compatibility of the Chat infrastructure for third-party extensions. The Singularity hides the Chat and Copilot UI by default
// (chat.disableAIFeatures = true) but must not break the public API that other extensions use. A probe extension (chat-compat-ext)
// is loaded in two fresh profiles, with the Singularity default and with the upstream default (AI features on), and records what
// it can do. The API surface and the behavior must be the same.
//
//   node scripts/e2e/chat-compat-check.cjs --out <dir> [--exe <packaged exe> | --dev <repo>]

const fs = require('fs'), path = require('path');
const lib = require('./lib.cjs');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const exe = arg('exe');
const dev = exe ? undefined : arg('dev', path.resolve(__dirname, '..', '..'));
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'compat-out')));
const probe = path.join(__dirname, 'chat-compat-ext');
const workspace = path.join(outDir, 'ws');
fs.mkdirSync(workspace, { recursive: true });
const results = [];
const log = (...a) => { const l = new Date().toISOString() + ' ' + a.join(' '); console.log(l); fs.appendFileSync(path.join(outDir, 'progress.log'), l + '\n'); };
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); return !!ok; };

async function run(label, settings) {
	const profile = path.join(outDir, label);
	const result = path.join(outDir, `${label}.json`);
	fs.rmSync(result, { force: true });
	lib.launch({ exe, dev, profile, workspace, port: 9500 + Math.floor(Math.random() * 90), files: [`--extensionDevelopmentPath=${probe}`],
		env: { CHAT_COMPAT_OUT: result, SINGULARITY_HUB_HOME: path.join(outDir, 'hub-' + label) },
		settings: { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', ...settings } });
	const end = Date.now() + 120000;
	while (!fs.existsSync(result) && Date.now() < end) { await lib.sleep(1000); }
	await lib.closeApp(profile, 25000);
	return fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8')) : undefined;
}

(async () => {
	try {
		const singularity = await run('singularity-default', {});
		const upstream = await run('upstream-default', { 'chat.disableAIFeatures': false });
		check('the probe extension ran in both profiles', !!singularity && !!upstream);
		if (singularity && upstream) {
			check('the Singularity default has the AI features switched off', singularity.setting === true, singularity.setting);
			check('the upstream default is unchanged when the user turns them on', upstream.setting === false, upstream.setting);
			check('the public Chat and language-model API is present in the Singularity default',
				['chat', 'lm'].every(k => singularity.api[k] === 'object') && ['createChatParticipant', 'selectChatModels', 'registerTool', 'authentication'].every(k => singularity.api[k] === 'function'), singularity.api);
			check('the API surface is identical to the upstream default', JSON.stringify(singularity.api) === JSON.stringify(upstream.api));
			check('a third-party extension can still register a chat participant and a language-model tool',
				singularity.behaviour.participantCreated === true && singularity.behaviour.toolRegistered === true, singularity.behaviour);
			check('no API call failed in the Singularity default', singularity.errors.length === 0, singularity.errors);
			check('behavior matches the upstream default (same errors, same capabilities)', JSON.stringify(singularity.errors) === JSON.stringify(upstream.errors) && singularity.behaviour.participantCreated === upstream.behaviour.participantCreated && singularity.behaviour.toolRegistered === upstream.behaviour.toolRegistered);
		}
	} catch (e) {
		check('the compatibility run completed', false, { error: e.message });
	} finally {
		const ok = results.length > 0 && results.every(r => r.ok);
		fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ build: exe ? 'packaged' : 'dev', results, ok, finished: new Date().toISOString() }, null, 2));
		log(ok ? 'CHAT COMPAT CHECK PASSED' : 'CHAT COMPAT CHECK FAILED');
		process.exit(ok ? 0 : 1);
	}
})();
