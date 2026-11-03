import assert from 'node:assert/strict';
import * as fs from 'fs';
import { describe, it } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { bundledNode, findNode } from '../launch';

const exe = process.platform === 'win32' ? 'node.exe' : 'node';

function fakeRoot(withRuntime: boolean): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sing-root-'));
	if (withRuntime) {
		fs.mkdirSync(path.join(root, 'runtime'));
		fs.writeFileSync(path.join(root, 'runtime', exe), '');
	}
	return root;
}

describe('which Node.js runs the Hub', () => {
	it('a distribution (bundled runtime present) uses it and ignores the user PATH', () => {
		const root = fakeRoot(true);
		try {
			const fakePathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sing-path-'));
			fs.writeFileSync(path.join(fakePathDir, exe), '');
			const env = { PATH: fakePathDir, Path: fakePathDir };
			assert.equal(findNode(env, root), path.join(root, 'runtime', exe));
			assert.equal(bundledNode(root), path.join(root, 'runtime', exe));
			fs.rmSync(fakePathDir, { recursive: true, force: true });
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it('SINGULARITY_NODE_PATH is an explicit choice that wins over the bundled runtime', () => {
		const root = fakeRoot(true);
		const other = path.join(root, 'other-node');
		fs.writeFileSync(other, '');
		try {
			assert.equal(findNode({ SINGULARITY_NODE_PATH: other }, root), other);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it('a development checkout (no bundled runtime) falls back to PATH, and reports nothing when PATH has no Node', () => {
		const root = fakeRoot(false);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sing-path-'));
		try {
			assert.equal(bundledNode(root), undefined);
			assert.equal(findNode({ PATH: dir, Path: dir }, root), undefined);
			fs.writeFileSync(path.join(dir, exe), '');
			assert.equal(findNode({ PATH: dir, Path: dir }, root), path.join(dir, exe));
		} finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
	});
});
