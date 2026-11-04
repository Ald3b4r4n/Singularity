'use strict';
// First real push: commit -> Singularity IDE -> its own OAuth publishing authorization -> git push -> github.com -> remote SHA.
// Runs on a private, synthetic test repository, through the real UI (real keyboard and mouse), on an isolated profile.
// The owner approves the two device codes (identity, then publishing) in the browser. No token is read, printed or stored here.
// `gh` is used only to prepare and to VERIFY the remote (read-only calls) and to prepare the divergence; every push that is
// evaluated is made by the Singularity.
//
//   node scripts/e2e/push-check.cjs --out <dir> --clone <path of the prepared clone> [--exe <packaged exe> | --dev <repo>]

const { execFileSync } = require('child_process');
const { createUi } = require('./ui.cjs');
const fs = require('fs'), path = require('path');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const exe = arg('exe');
const dev = exe ? undefined : arg('dev', 'D:\\dev\\singularity');
const outDir = path.resolve(arg('out', path.join(process.cwd(), 'push-out')));
const clone = path.resolve(arg('clone'));
const REPO = arg('repo', 'Ald3b4r4n/singularity-push-e2e');
const expectedLogin = arg('login', 'Ald3b4r4n');
const profile = path.resolve(arg('profile', path.join(outDir, 'profile')));
fs.mkdirSync(outDir, { recursive: true });
const port = 9700 + Math.floor(Math.random() * 90);

const ui = createUi({
	exe, dev, profile, workspace: clone, port, outDir,
	// no prompt of any kind may stand in for the Singularity authorization
	env: { SINGULARITY_HUB_HOME: path.join(outDir, 'hub'), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
	baseSettings: { 'singularity.publish.defaultMode': 'manual', 'singularity.publish.automaticRepositories': [] },
});
const { log, check, sleep, waitFor, key, paste } = ui;

// ---------- git and GitHub helpers (preparation and verification) ----------
const GITENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, env: GITENV, timeout: 120000, ...opts }).trim();
const git = (args, cwd = clone) => run('git', args, { cwd });
// only for preparing the test (second clone, divergence): the gh credential helper, for that single command
const ghGit = (cwd, args) => run('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...args], { cwd });
const remoteHead = () => run('gh', ['api', `repos/${REPO}/commits/main`, '--jq', '.sha']);
const remoteHas = sha => { try { return run('gh', ['api', `repos/${REPO}/commits/${sha}`, '--jq', '.sha']) === sha; } catch { return false; } };
const remoteParent = sha => run('gh', ['api', `repos/${REPO}/commits/${sha}`, '--jq', '.parents[0].sha']);
const short = sha => (sha || '').slice(0, 10);
const waitRemote = (sha, ms) => waitFor(async () => remoteHead() === sha, ms, 3000);
const ahead = () => Number(git(['rev-list', '--count', 'origin/main..HEAD']));
let counter = 0;
function commit(label) {
	counter++;
	fs.appendFileSync(path.join(clone, 'data.txt'), `${label} #${counter} ${new Date().toISOString()}\n`);
	git(['add', 'data.txt']);
	git(['commit', '-q', '-m', `test(${label}): synthetic commit #${counter}`]);
	return git(['rev-parse', 'HEAD']);
}
async function holdRemote(expected, ms, what) {
	await sleep(ms);
	return check(what, remoteHead() === expected, { remote: short(remoteHead()), expected: short(expected) });
}
async function waitToast(page, re, ms) { return waitFor(async () => (await ui.toasts(page)).find(t => re.test(t)), ms, 500); }
const clickToastButton = (page, label) => ui.mouseClickEl(page, `[...document.querySelectorAll('.notifications-toasts .monaco-button')].find(b => b.innerText.trim() === ${JSON.stringify(label)})`);
const publishNow = page => ui.palette(page, 'Singularity: Publish Commits Now');
const setAutomatic = on => ui.setSetting('singularity.publish.automaticRepositories', on ? [fs.realpathSync.native(clone)] : []);

(async () => {
	let page;
	const shas = {};
	try {
		// ---------- preparation checks (no IDE yet) ----------
		const meta = JSON.parse(run('gh', ['api', `repos/${REPO}`]));
		check('P1. the test repository exists and is PRIVATE (checked by the GitHub API)', meta.private === true && meta.visibility === 'private', { repo: REPO, private: meta.private, visibility: meta.visibility });
		check('P2. the repository belongs to the expected account', meta.owner.login === expectedLogin, meta.owner.login);
		const origin = git(['remote', 'get-url', 'origin']);
		check('P3. the clone uses an HTTPS origin without embedded credentials', /^https:\/\/github\.com\//.test(origin) && !/@/.test(origin), origin);
		git(['config', 'credential.helper', '']); // local clone only: no helper can supply credentials to this repository
		shas.base = git(['rev-parse', 'HEAD']);
		check('P4. the clone is in sync with the remote and has an upstream', remoteHead() === shas.base && git(['rev-parse', '--abbrev-ref', '@{u}']) === 'origin/main', { head: short(shas.base) });
		check('P5. local Git config: no credential helper for this clone (the Singularity token is the only way in)', git(['config', '--local', '--get-all', 'credential.helper']) === '');

		page = await ui.openApp();

		// ---------- account: identity, then publishing authorization (the owner approves two codes) ----------
		let st = await waitFor(() => ui.entryState(page), 20000);
		if (!st || st.mode !== 'signed-in') {
			await ui.mouseClick(page, ui.ENTRY);
			const c1 = await ui.acceptDeviceCode('1');
			check('S1. identity sign-in: device code issued and accepted from the title bar', !!c1);
			st = await waitFor(async () => { const s = await ui.entryState(page); return s && s.mode === 'signed-in' ? s : undefined; }, 900000, 2000);
		}
		check(`S2. the title bar shows ${expectedLogin}`, !!st && st.text.includes(expectedLogin), st && st.text);
		if (!/Publicação autorizada\./.test((await ui.entryState(page)).tooltip)) {
			await ui.palette(page, 'Singularity: Authorize GitHub Publishing');
			const c2 = await ui.acceptDeviceCode('2');
			check('S3. publishing authorization (repo): device code issued and accepted', !!c2);
			await waitFor(async () => /Publicação autorizada\./.test((await ui.entryState(page)).tooltip), 900000, 2000);
		}
		check('S4. publishing is authorized (the OAuth credential with the repo scope)', /Publicação autorizada\./.test((await ui.entryState(page)).tooltip), (await ui.entryState(page)).tooltip);
		await ui.snap('00-conta-autorizada.png');

		// ---------- A. manual ----------
		log('--- A. manual');
		shas.A = commit('A');
		await ui.snap('A1-commit-local.png');
		await holdRemote(shas.base, 12000, 'A1. manual mode: the Singularity does not push by itself');
		check('A2. the commit exists only locally (1 commit ahead)', ahead() === 1, ahead());
		await publishNow(page);
		const okA = await waitRemote(shas.A, 60000);
		check('A3. "Publish Commits Now" publishes: the remote SHA equals the local commit', !!okA && remoteHead() === shas.A, { local: short(shas.A), remote: short(remoteHead()) });
		check('A4. the commit is visible on GitHub and the history is preserved (parent = previous head)', remoteHas(shas.A) && remoteParent(shas.A) === shas.base);

		// ---------- B. assisted ----------
		log('--- B. assisted');
		ui.setSetting('singularity.publish.defaultMode', 'assisted');
		await sleep(3000);
		shas.B1 = commit('B1');
		const askB1 = await waitToast(page, /prontos para publicar/, 40000);
		check('B1. assisted mode: the IDE asks before publishing', !!askB1, askB1);
		await ui.snap('B1-pergunta.png');
		await clickToastButton(page, 'Agora não');
		await holdRemote(shas.A, 12000, 'B2. "Agora não": nothing is pushed');
		shas.B2 = commit('B2');
		const askB2 = await waitToast(page, /prontos para publicar/, 40000);
		check('B3. a new commit is offered again', !!askB2, askB2);
		await clickToastButton(page, 'Publicar');
		const okB = await waitRemote(shas.B2, 60000);
		check('B4. "Publicar": the correct SHA reaches GitHub', !!okB && remoteHead() === shas.B2, { local: short(shas.B2), remote: short(remoteHead()) });
		check('B5. both commits of the batch are on the remote, in order', remoteHas(shas.B1) && remoteParent(shas.B2) === shas.B1);

		// ---------- C. automatic (only this repository) ----------
		log('--- C. automatic');
		setAutomatic(true);
		await sleep(3000);
		fs.appendFileSync(path.join(clone, 'ui.txt'), `from the Source Control view ${new Date().toISOString()}\n`);
		git(['add', 'ui.txt']);
		await ui.mouseClick(page, '.activitybar [aria-label^="Source Control"]');
		await sleep(2000);
		await ui.mouseClick(page, '.scm-editor .monaco-editor');
		await paste('test(C1): commit made from the Source Control view');
		await key('^{ENTER}', 2500);
		await ui.snap('C1-scm.png');
		const committed = await waitFor(async () => git(['log', '-1', '--format=%s']).startsWith('test(C1)'), 15000, 1000);
		check('C1. a commit is created from the IDE Git interface', !!committed, git(['log', '-1', '--format=%s']));
		shas.C1 = git(['rev-parse', 'HEAD']);
		const okC1 = await waitRemote(shas.C1, 90000);
		check('C2. automatic mode publishes the commit made in the Git interface', !!okC1, { local: short(shas.C1), remote: short(remoteHead()) });
		shas.C2 = commit('C2');
		const okC2 = await waitRemote(shas.C2, 90000);
		check('C3. a commit made by an external CLI is detected by the watcher and published', !!okC2, { local: short(shas.C2), remote: short(remoteHead()) });
		check('C4. the remote chain is C2 -> C1 -> B2 (no rewrite)', remoteParent(shas.C2) === shas.C1 && remoteParent(shas.C1) === shas.B2);

		// ---------- E. divergence ----------
		log('--- E. divergence');
		const other = path.join(outDir, 'other');
		fs.rmSync(other, { recursive: true, force: true });
		ghGit(outDir, ['clone', '-q', `https://github.com/${REPO}.git`, 'other']);
		git(['config', 'user.name', 'Singularity E2E (second clone)'], other); git(['config', 'user.email', 'e2e@singularity.invalid'], other);
		const advance = label => { fs.appendFileSync(path.join(other, 'other.txt'), `${label} ${new Date().toISOString()}\n`); git(['add', 'other.txt'], other); git(['commit', '-q', '-m', `test(${label}): remote-side commit`], other); ghGit(other, ['push', '-q', 'origin', 'main']); return git(['rev-parse', 'HEAD'], other); };
		shas.R1 = advance('E-remote');
		check('E0. (preparation, not the mechanism) a second clone advanced the remote', remoteHead() === shas.R1);
		shas.E1 = commit('E1');
		const warnE = await waitToast(page, /O remoto tem commits/, 60000);
		check('E1. the divergence is identified and explained', !!warnE, warnE);
		await ui.snap('E1-divergencia.png');
		await sleep(8000);
		check('E2. no force push: the remote head is still the other clone\'s commit', remoteHead() === shas.R1 && !remoteHas(shas.E1), { remote: short(remoteHead()) });
		check('E3. the remote history was not overwritten (R1 -> C2)', remoteParent(shas.R1) === shas.C2);
		ghGit(clone, ['fetch', '-q', 'origin']); git(['reset', '-q', '--hard', 'origin/main']); // test cleanup: back in sync

		// ---------- F. network failure ----------
		log('--- F. network failure');
		git(['config', 'http.proxy', 'http://127.0.0.1:9']); // local to the test clone: nothing is changed on the machine
		shas.F1 = commit('F1');
		const warnF1 = await waitToast(page, /Não foi possível confirmar o estado do remoto/, 90000);
		check('F1. offline: the user is told the remote state cannot be confirmed', !!warnF1, warnF1);
		await ui.snap('F1-offline.png');
		await sleep(6000);
		check('F2. offline: the commit stays local (nothing reached the remote)', remoteHead() === shas.R1 && !remoteHas(shas.F1), { remote: short(remoteHead()) });
		shas.R2 = advance('F-remote'); // the remote moves while the IDE cannot fetch: its knowledge is now stale
		const toastsBefore = (await ui.toasts(page)).length;
		shas.F2 = commit('F2');
		const warnF2 = await waitToast(page, /Não foi possível confirmar o estado do remoto/, 90000);
		await sleep(8000);
		check('F3. stale knowledge: with the remote ahead and the fetch failing, nothing is pushed or offered', remoteHead() === shas.R2 && !remoteHas(shas.F1) && !remoteHas(shas.F2) && !(await ui.toasts(page)).some(t => /prontos para publicar/.test(t)), { remote: short(remoteHead()), toastsBefore, warned: !!warnF2 });
		git(['config', '--unset', 'http.proxy']);
		await publishNow(page);
		const warnF4 = await waitToast(page, /O remoto tem commits/, 90000);
		check('F4. back online, the explicit command sees the divergence and still pushes nothing', !!warnF4 && remoteHead() === shas.R2, warnF4);
		ghGit(clone, ['fetch', '-q', 'origin']); git(['reset', '-q', '--hard', 'origin/main']);

		// ---------- D. no publishing authorization ----------
		log('--- D. no authorization');
		await ui.palette(page, 'Singularity: Remove GitHub Publishing Authorization'); // removes the local authorization only
		const revoked = await waitFor(async () => /Publicação não autorizada\./.test((await ui.entryState(page)).tooltip), 20000, 1000);
		check('D1. the publishing authorization was removed from this profile', !!revoked, (await ui.entryState(page)).tooltip);
		const stillIn = await ui.entryState(page);
		check('D2. the identity session (read:user) is kept', stillIn.mode === 'signed-in' && stillIn.text.includes(expectedLogin), stillIn.text);
		const headBefore = remoteHead();
		shas.D1 = commit('D1');
		const warnD = await waitToast(page, /exige a autorização de publicação/, 60000);
		check('D3. a local commit does not push, and the user gets a clear instruction', !!warnD, warnD);
		await ui.snap('D1-sem-autorizacao.png');
		await sleep(8000);
		check('D4. nothing reached GitHub with the identity token or any other credential', remoteHead() === headBefore && !remoteHas(shas.D1), { remote: short(remoteHead()) });
		let ambient = 'pushed';
		try { git(['push', 'origin', 'main']); } catch (e) { ambient = /could not read Username|Authentication failed|terminal prompts disabled/i.test(String(e.stderr || e.message)) ? 'refused: no ambient credential' : 'failed: ' + String(e.stderr || e.message).slice(0, 120); }
		check('D5. control: a plain git push from this clone is refused too (no Credential Manager or CLI login can stand in)', /^refused/.test(ambient) && !remoteHas(shas.D1), ambient);
		await publishNow(page);
		const warnD2 = await waitToast(page, /exige a autorização de publicação/, 30000);
		check('D6. the explicit command gives the same instruction', !!warnD2);
	} catch (e) {
		check('the push run completed', false, { error: e.message });
		try { if (page) { await ui.snap('failure.png'); } } catch { /* ignore */ }
	} finally {
		try { if (page) { page.close(); } } catch { /* ignore */ }
		await ui.lib.closeApp(profile, 30000);
		// the extension's own log (flushed on a normal close): mode, counts and the action taken per check; never a token
		let extLog = [];
		try {
			const find = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(x => x.isDirectory() ? find(path.join(d, x.name)) : (/Singularity Account\.log$/.test(x.name) ? [path.join(d, x.name)] : []));
			const f = find(path.join(profile, 'data', 'logs')).pop();
			if (f) { extLog = fs.readFileSync(f, 'utf8').split('\n').filter(l => /mode=|needs publishing authorization|pushed|rejected|offline|fetch skipped|diverged/.test(l)).map(l => l.replace(/[A-Za-z]:[\\/].*?(?=: )/g, '<clone>').replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ /, '')); }
		} catch { /* ignore */ }
		const hits = ui.lib.ps(`(Get-ChildItem -Path '${profile}' -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Length -lt 40MB } | Select-String -Pattern 'gh[opusr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}' -List -ErrorAction SilentlyContinue | Measure-Object).Count`);
		check('no GitHub token pattern in the profile (logs and state)', Number(hits) === 0, { files: hits });
		for (const f of ui.codeFiles) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
		const ok = ui.results.length > 0 && ui.results.every(r => r.ok);
		fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ build: exe ? 'packaged' : 'dev', repo: REPO, visibility: 'private', shas: Object.fromEntries(Object.entries(shas).map(([k, v]) => [k, short(v)])), results: ui.results, extensionLog: extLog.slice(-60), ok, finished: new Date().toISOString() }, null, 2));
		log(ok ? 'PUSH CHECK PASSED' : 'PUSH CHECK FAILED');
		process.exit(ok ? 0 : 1);
	}
})();
