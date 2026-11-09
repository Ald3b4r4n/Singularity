import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as vm from 'node:vm';

const web = path.join(__dirname, '..', '..', 'web');
const read = (name: string): string => fs.readFileSync(path.join(web, name), 'utf8');

describe('Singularity Remote web client', () => {
	it('is installable: manifest, standalone display and real PNG icons', () => {
		const manifest = JSON.parse(read('manifest.webmanifest'));
		assert.equal(manifest.display, 'standalone');
		assert.equal(manifest.start_url, '/');
		assert.equal(manifest.lang, 'pt-BR');
		for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512]] as const) {
			const data = fs.readFileSync(path.join(web, file));
			assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], file + ' is a PNG');
			assert.equal(data.readUInt32BE(16), size);
			assert.equal(data.readUInt32BE(20), size);
		}
		assert.ok(manifest.icons.some((icon: { sizes: string }) => icon.sizes === '512x512'));
		assert.match(read('index.html'), /rel="manifest"/);
		assert.match(read('index.html'), /viewport-fit=cover/);
	});

	it('loads nothing from outside, and has no inline script, inline style or inline handler (the CSP forbids them)', () => {
		const everything = ['index.html', 'app.js', 'style.css', 'sw.js', 'manifest.webmanifest'].map(read).join('\n');
		assert.doesNotMatch(everything.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, ''), /https?:\/\//, 'no remote origin');
		const html = read('index.html');
		assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline script');
		assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline handler');
		assert.doesNotMatch(html, /\sstyle\s*=/i, 'no inline style');
		assert.doesNotMatch(html, /<link[^>]*rel="stylesheet"[^>]*href="https?:/i);
	});

	it('never puts data from the computer on the page as HTML, and never evaluates it', () => {
		const code = read('app.js').replace(/\/\/.*$/gm, '');
		for (const forbidden of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /setAttribute\(\s*['"]style/, /\.srcdoc\b/]) {
			assert.doesNotMatch(code, forbidden, String(forbidden));
		}
	});

	it('has no analytics, no telemetry and no third-party storage of credentials', () => {
		const code = (read('app.js') + read('sw.js')).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
		assert.doesNotMatch(code, /analytics|gtag|telemetry|sendBeacon|firebase|sentry/i);
		assert.doesNotMatch(code, /password|apiKey|api_key|sessionStorage\.setItem\(.*token/i);
		// the only thing kept in the browser is this app's own device token, UI preferences, and nothing is sent anywhere else
		assert.match(code, /credentials: 'omit'/);
		assert.match(code, /referrerPolicy: 'no-referrer'/);
	});

	it('the service worker caches the shell and never the API', () => {
		const worker = read('sw.js');
		assert.match(worker, /startsWith\('\/api\/'\)\) \{ return; \}/);
		assert.match(worker, /method !== 'GET'/);
	});

	it('every file parses, and the screens the spec asks for exist', () => {
		new vm.Script(read('app.js'));
		new vm.Script(read('sw.js'));
		const app = read('app.js');
		for (const label of ['Início', 'Agentes', 'Sessões', 'Comparação', 'Equipe', 'Dispositivos']) { assert.ok(app.includes(`'${label}'`), label); }
		for (const text of ['Enviar tarefa', 'Interromper tarefa', 'Encerrar conexão', 'Parear', 'Workspace autorizado']) { assert.ok(app.includes(text), text); }
		assert.match(app, /X-Request-Id/);
		assert.match(app, /confirm: true/);
	});

	it('supports a light and a dark theme, large touch targets and a narrow screen', () => {
		const css = read('style.css');
		assert.match(css, /prefers-color-scheme: light/);
		assert.match(css, /data-theme="light"/);
		assert.match(css, /min-height: 4[68]px/);
		assert.match(css, /grid-template-columns: repeat\(6, 1fr\)/);
		assert.match(css, /safe-area-inset-bottom/);
	});
});
