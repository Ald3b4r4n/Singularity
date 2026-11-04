'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const root = path.join(__dirname, '../../..');
const parse = relative => {
	const file = path.join(root, relative);
	return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
};
const desktop = parse('src/vs/workbench/electron-browser/desktop.contribution.ts');
const native = parse('src/vs/platform/native/electron-main/nativeHostMainService.ts');

function find(node, predicate, results = []) {
	if (predicate(node)) {
		results.push(node);
	}
	ts.forEachChild(node, child => { find(child, predicate, results); });
	return results;
}

test('registers the native update command once on enabled Windows builds', () => {
	const registrations = find(desktop, node => ts.isCallExpression(node)
		&& node.expression.getText(desktop) === 'CommandsRegistry.registerCommand'
		&& node.arguments[0]?.getText(desktop) === "'_singularity.installUpdate'");
	assert.equal(registrations.length, 1);
	const guard = registrations[0].parent.parent.parent;
	assert(ts.isIfStatement(guard));
	const code = ts.transpileModule(guard.getText(desktop), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
	for (const [isWindows, enabled, expected] of [[true, true, 1], [false, true, 0], [true, false, 0]]) {
		let registered = 0;
		vm.runInNewContext(code, {
			isWindows, product: { singularityUpdateInstall: enabled },
			CommandsRegistry: { registerCommand() { registered++; } }
		});
		assert.equal(registered, expected);
	}
});

test('native execution rejects even an apparently valid caller-supplied digest', async () => {
	const [method] = find(native, node => ts.isMethodDeclaration(node) && node.name.getText(native) === 'installSingularityUpdate');
	const code = ts.transpileModule(`(class { ${method.getText(native)} })`, {
		compilerOptions: { target: ts.ScriptTarget.ES2022 }
	}).outputText;
	const service = vm.runInNewContext(code);
	const instance = new service();
	await assert.rejects(instance.installSingularityUpdate(1, {
		path: 'SingularityIDE-0.1.1-x64-user.exe', version: '0.1.1', sha256: 'a'.repeat(64)
	}), /disabled pending native provenance/);
});
