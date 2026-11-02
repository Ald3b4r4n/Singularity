/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { AppResourcePath, FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

/**
 * A scoped editor service opens an editor without a specific group in its own
 * part. These are the consumers of the editor services scoped to the main
 * part and to the part of an auxiliary window: none of them opens editors, so
 * that change cannot change them.
 */
suite('Scoped editor service consumers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function read(path: AppResourcePath): string {
		return readFileSync(FileAccess.asFileUri(path).fsPath, 'utf8');
	}

	function between(text: string, start: string, end: string): string {
		const startIndex = text.indexOf(start);
		const endIndex = text.indexOf(end, startIndex);
		assert.ok(startIndex >= 0 && endIndex > startIndex, `'${start}' … '${end}' not found`);

		return text.substring(startIndex, endIndex);
	}

	test('the consumers of the editor services scoped to the main part and to auxiliary windows never open editors', () => {
		const window = read('vs/workbench/electron-browser/window.js');
		const consumers: Record<string, string> = {
			editorStatus: read('vs/workbench/browser/parts/editor/editorStatus.js'),
			languageStatus: read('vs/workbench/contrib/languageStatus/browser/languageStatus.js'),
			notebookStatus: read('vs/workbench/contrib/notebook/browser/contrib/editorStatusBar/editorStatusBar.js'),
			windowTitle: read('vs/workbench/browser/parts/titlebar/windowTitle.js'),
			windowRepresentedFilename: between(window, 'handleRepresentedFilename(part)', '//#region Window Lifecycle'),
			windowZoomStatus: between(window, 'let ZoomStatusEntry = class', 'export {'),
		};

		const opening = Object.entries(consumers).filter(([, text]) => /\.(openEditor|openEditors|replaceEditors)\(/.test(text)).map(([name]) => name);

		assert.deepStrictEqual(opening, []);
	});
});
