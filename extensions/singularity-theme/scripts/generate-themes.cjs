// Generates themes/*.json from the Event Minimal palette. Run: node scripts/generate-themes.cjs
const fs = require('fs'), path = require('path');

const P = {
	dark: {
		type: 'dark', name: 'Event Minimal Dark',
		bg: '#07080C', surface: '#0C0E15', panel: '#10131C', elev: '#171B27', hover: '#1C2130', border: '#212637', borderStrong: '#6B7390',
		text: '#E8EAF2', muted: '#A4AABD', faint: '#8089A3', accent: '#FFB45E', accentHover: '#FFC47E', onAccent: '#1A1004',
		ok: '#5BD6A0', info: '#8AB4FF', err: '#FF7A7A', warn: '#F5D547',
		sel: '#FFB45E2E', selInactive: '#FFB45E1A', find: '#FFB45E40', lineHl: '#FFFFFF08', word: '#FFFFFF14',
		kw: '#AEBBFF', str: '#8FD3B6', type: '#9CC4FF', num: '#FFB45E', cm: '#7F8499', fn: '#E8EAF2', va: '#D5D9E6', prop: '#C4CBE0', cst: '#F2A27B', rx: '#FF9E7A', op: '#A4AABD',
		ansi: ['#10131C', '#FF7A7A', '#5BD6A0', '#F5D547', '#8AB4FF', '#C7A6FF', '#6FD6E6', '#E8EAF2', '#4A5068', '#FF9A9A', '#7FE6B8', '#FFE27A', '#A9C8FF', '#D9C0FF', '#8FE6F0', '#FFFFFF'],
		add: '#5BD6A0', del: '#FF7A7A', errFg: '#1A0707', warnFg: '#1A1400'
	},
	light: {
		type: 'light', name: 'Event Minimal Light',
		bg: '#FBF9F5', surface: '#F3F0E8', panel: '#EFEBE1', elev: '#FFFFFF', hover: '#E6E1D3', border: '#DDD7C9', borderStrong: '#7A7668',
		text: '#1C1B22', muted: '#55535E', faint: '#625F6B', accent: '#A64E05', accentHover: '#8F4204', onAccent: '#FFFFFF',
		ok: '#157A52', info: '#2B5CC4', err: '#C42B3D', warn: '#7A5C00',
		sel: '#A64E0526', selInactive: '#A64E0514', find: '#A64E0538', lineHl: '#0000000A', word: '#0000001A',
		kw: '#4B55C9', str: '#157A52', type: '#2B5CC4', num: '#A64E05', cm: '#625F6B', fn: '#1C1B22', va: '#2B2A33', prop: '#3A3846', cst: '#B4430B', rx: '#B4430B', op: '#55535E',
		ansi: ['#1C1B22', '#C42B3D', '#157A52', '#7A5C00', '#2B5CC4', '#7A3FC4', '#0B7285', '#55535E', '#7A7668', '#D9485A', '#1E9468', '#946F00', '#4474D6', '#9158DB', '#1296AD', '#1C1B22'],
		add: '#157A52', del: '#C42B3D', errFg: '#FFFFFF', warnFg: '#FFFFFF'
	}
};

function build(c) {
	const a = (hex, al) => hex + al; // hex #RRGGBB + 2-digit alpha
	const colors = {
		foreground: c.text, disabledForeground: c.faint, errorForeground: c.err, descriptionForeground: c.muted, 'icon.foreground': c.muted,
		focusBorder: a(c.accent, '99'), 'widget.border': c.border, 'widget.shadow': '#00000066', 'selection.background': c.sel,
		'textLink.foreground': c.info, 'textLink.activeForeground': c.info, 'textBlockQuote.background': c.panel, 'textBlockQuote.border': c.border,
		'textCodeBlock.background': c.elev, 'textPreformat.foreground': c.muted, 'textSeparator.foreground': c.border,
		'toolbar.hoverBackground': c.hover, 'toolbar.activeBackground': c.hover,
		'button.background': c.accent, 'button.foreground': c.onAccent, 'button.hoverBackground': c.accentHover, 'button.border': c.accent,
		'button.secondaryBackground': c.elev, 'button.secondaryForeground': c.text, 'button.secondaryHoverBackground': c.hover,
		'checkbox.background': c.elev, 'checkbox.border': c.borderStrong, 'checkbox.foreground': c.text,
		'dropdown.background': c.elev, 'dropdown.border': c.borderStrong, 'dropdown.foreground': c.text, 'dropdown.listBackground': c.elev,
		'input.background': c.elev, 'input.border': c.borderStrong, 'input.foreground': c.text, 'input.placeholderForeground': c.faint,
		'inputOption.activeBackground': a(c.accent, '33'), 'inputOption.activeBorder': c.accent, 'inputOption.activeForeground': c.text,
		'inputValidation.errorBackground': c.elev, 'inputValidation.errorBorder': c.err, 'inputValidation.warningBackground': c.elev, 'inputValidation.warningBorder': c.warn,
		'inputValidation.infoBackground': c.elev, 'inputValidation.infoBorder': c.info,
		'scrollbar.shadow': '#00000000', 'scrollbarSlider.background': a(c.faint, '40'), 'scrollbarSlider.hoverBackground': a(c.faint, '66'), 'scrollbarSlider.activeBackground': a(c.faint, '80'),
		'badge.background': c.accent, 'badge.foreground': c.onAccent,
		'progressBar.background': c.accent,
		'list.activeSelectionBackground': a(c.accent, '26'), 'list.activeSelectionForeground': c.text, 'list.inactiveSelectionBackground': c.hover, 'list.inactiveSelectionForeground': c.text,
		'list.hoverBackground': c.hover, 'list.hoverForeground': c.text, 'list.focusBackground': a(c.accent, '26'), 'list.focusOutline': a(c.accent, '99'),
		'list.highlightForeground': c.accent, 'list.focusHighlightForeground': c.accent, 'list.dropBackground': a(c.accent, '26'), 'list.errorForeground': c.err, 'list.warningForeground': c.warn,
		'list.invalidItemForeground': c.err, 'list.deemphasizedForeground': c.faint,
		'tree.indentGuidesStroke': c.border, 'tree.inactiveIndentGuidesStroke': c.border,
		'activityBar.background': c.surface, 'activityBar.foreground': c.text, 'activityBar.inactiveForeground': c.faint, 'activityBar.border': c.border,
		'activityBar.activeBorder': c.accent, 'activityBar.activeBackground': '#00000000', 'activityBarBadge.background': c.accent, 'activityBarBadge.foreground': c.onAccent,
		'sideBar.background': c.panel, 'sideBar.foreground': c.text, 'sideBar.border': c.border, 'sideBarTitle.foreground': c.muted,
		'sideBarSectionHeader.background': c.panel, 'sideBarSectionHeader.foreground': c.muted, 'sideBarSectionHeader.border': c.border,
		'titleBar.activeBackground': c.bg, 'titleBar.activeForeground': c.muted, 'titleBar.inactiveBackground': c.bg, 'titleBar.inactiveForeground': c.faint, 'titleBar.border': c.border,
		'menubar.selectionBackground': c.hover, 'menubar.selectionForeground': c.text,
		'menu.background': c.elev, 'menu.foreground': c.text, 'menu.selectionBackground': a(c.accent, '26'), 'menu.selectionForeground': c.text, 'menu.separatorBackground': c.border, 'menu.border': c.borderStrong,
		'commandCenter.background': c.surface, 'commandCenter.foreground': c.muted, 'commandCenter.border': c.border, 'commandCenter.activeBackground': c.hover, 'commandCenter.activeForeground': c.text, 'commandCenter.activeBorder': c.borderStrong,
		'tab.activeBackground': c.bg, 'tab.activeForeground': c.text, 'tab.inactiveBackground': c.surface, 'tab.inactiveForeground': c.muted, 'tab.border': c.border,
		'tab.activeBorder': '#00000000', 'tab.activeBorderTop': c.accent, 'tab.unfocusedActiveBackground': c.bg, 'tab.unfocusedActiveForeground': c.muted, 'tab.unfocusedInactiveBackground': c.surface,
		'tab.unfocusedActiveBorderTop': a(c.accent, '66'), 'tab.hoverBackground': c.hover, 'tab.hoverForeground': c.text, 'tab.lastPinnedBorder': c.border,
		'editorGroup.border': c.border, 'editorGroupHeader.tabsBackground': c.surface, 'editorGroupHeader.tabsBorder': c.border, 'editorGroupHeader.noTabsBackground': c.bg,
		'editorGroup.dropBackground': a(c.accent, '1A'),
		'breadcrumb.foreground': c.faint, 'breadcrumb.focusForeground': c.text, 'breadcrumb.activeSelectionForeground': c.text, 'breadcrumbPicker.background': c.elev,
		'editor.background': c.bg, 'editor.foreground': c.text, 'editorLineNumber.foreground': c.faint, 'editorLineNumber.activeForeground': c.accent,
		'editorCursor.foreground': c.accent, 'editor.selectionBackground': c.sel, 'editor.inactiveSelectionBackground': c.selInactive, 'editor.selectionHighlightBackground': c.word,
		'editor.wordHighlightBackground': c.word, 'editor.wordHighlightStrongBackground': c.word, 'editor.findMatchBackground': c.find, 'editor.findMatchHighlightBackground': a(c.accent, '22'),
		'editor.findMatchBorder': c.accent, 'editor.findRangeHighlightBackground': a(c.faint, '22'), 'editor.hoverHighlightBackground': a(c.accent, '1A'),
		'editor.lineHighlightBackground': c.lineHl, 'editor.lineHighlightBorder': '#00000000', 'editor.rangeHighlightBackground': a(c.accent, '14'),
		'editorWhitespace.foreground': a(c.faint, '55'), 'editorIndentGuide.background1': c.border, 'editorIndentGuide.activeBackground1': c.borderStrong, 'editorRuler.foreground': c.border,
		'editorBracketMatch.background': a(c.accent, '22'), 'editorBracketMatch.border': a(c.accent, '99'), 'editorCodeLens.foreground': c.faint, 'editorLink.activeForeground': c.info,
		'editorError.foreground': c.err, 'editorWarning.foreground': c.warn, 'editorInfo.foreground': c.info, 'editorHint.foreground': c.muted,
		'editorGutter.background': c.bg, 'editorGutter.addedBackground': c.add, 'editorGutter.modifiedBackground': c.warn, 'editorGutter.deletedBackground': c.del,
		'editorOverviewRuler.border': '#00000000', 'editorOverviewRuler.errorForeground': c.err, 'editorOverviewRuler.warningForeground': c.warn, 'editorOverviewRuler.infoForeground': c.info,
		'editorOverviewRuler.addedForeground': a(c.add, '99'), 'editorOverviewRuler.modifiedForeground': a(c.warn, '99'), 'editorOverviewRuler.deletedForeground': a(c.del, '99'),
		'editorWidget.background': c.elev, 'editorWidget.foreground': c.text, 'editorWidget.border': c.borderStrong, 'editorSuggestWidget.background': c.elev, 'editorSuggestWidget.border': c.border,
		'editorSuggestWidget.foreground': c.text, 'editorSuggestWidget.selectedBackground': a(c.accent, '26'), 'editorSuggestWidget.highlightForeground': c.accent,
		'editorHoverWidget.background': c.elev, 'editorHoverWidget.border': c.borderStrong, 'editorHoverWidget.statusBarBackground': c.surface,
		'peekView.border': c.accent, 'peekViewEditor.background': c.surface, 'peekViewResult.background': c.panel, 'peekViewTitle.background': c.panel,
		'peekViewTitleLabel.foreground': c.text, 'peekViewTitleDescription.foreground': c.muted, 'peekViewResult.selectionBackground': a(c.accent, '26'), 'peekViewEditor.matchHighlightBackground': c.find,
		'diffEditor.insertedTextBackground': a(c.add, '24'), 'diffEditor.removedTextBackground': a(c.del, '24'), 'diffEditor.insertedLineBackground': a(c.add, '14'), 'diffEditor.removedLineBackground': a(c.del, '14'),
		'diffEditor.border': c.border, 'diffEditor.diagonalFill': c.border,
		'merge.currentHeaderBackground': a(c.info, '55'), 'merge.incomingHeaderBackground': a(c.ok, '55'),
		'panel.background': c.panel, 'panel.border': c.border, 'panelTitle.activeForeground': c.text, 'panelTitle.inactiveForeground': c.muted, 'panelTitle.activeBorder': c.accent,
		'panelSection.border': c.border, 'panelSectionHeader.background': c.panel, 'panelInput.border': c.borderStrong,
		'terminal.background': c.panel, 'terminal.foreground': c.text, 'terminal.selectionBackground': c.sel, 'terminal.inactiveSelectionBackground': c.selInactive,
		'terminalCursor.foreground': c.accent, 'terminal.border': c.border, 'terminal.findMatchBackground': c.find, 'terminal.tab.activeBorder': c.accent,
		'statusBar.background': c.surface, 'statusBar.foreground': c.muted, 'statusBar.border': c.border, 'statusBar.noFolderBackground': c.surface, 'statusBar.noFolderForeground': c.muted,
		'statusBar.debuggingBackground': c.accent, 'statusBar.debuggingForeground': c.onAccent, 'statusBar.debuggingBorder': c.accent,
		'statusBarItem.hoverBackground': c.hover, 'statusBarItem.activeBackground': c.hover, 'statusBarItem.remoteBackground': c.surface, 'statusBarItem.remoteForeground': c.text,
		'statusBarItem.prominentBackground': c.hover, 'statusBarItem.prominentForeground': c.text, 'statusBarItem.errorBackground': c.err, 'statusBarItem.errorForeground': c.errFg,
		'statusBarItem.warningBackground': c.warn, 'statusBarItem.warningForeground': c.warnFg,
		'notifications.background': c.elev, 'notifications.foreground': c.text, 'notifications.border': c.border, 'notificationCenterHeader.background': c.panel, 'notificationToast.border': c.borderStrong,
		'notificationsErrorIcon.foreground': c.err, 'notificationsWarningIcon.foreground': c.warn, 'notificationsInfoIcon.foreground': c.info,
		'quickInput.background': c.elev, 'quickInput.foreground': c.text, 'quickInputTitle.background': c.panel, 'quickInputList.focusBackground': a(c.accent, '26'), 'quickInputList.focusForeground': c.text,
		'pickerGroup.foreground': c.muted, 'pickerGroup.border': c.border, 'keybindingLabel.background': c.panel, 'keybindingLabel.foreground': c.muted, 'keybindingLabel.border': c.border, 'keybindingLabel.bottomBorder': c.border,
		'settings.headerForeground': c.text, 'settings.modifiedItemIndicator': c.accent, 'settings.focusedRowBackground': a(c.accent, '0F'), 'settings.rowHoverBackground': c.hover,
		'settings.textInputBackground': c.elev, 'settings.textInputBorder': c.borderStrong, 'settings.dropdownBackground': c.elev, 'settings.dropdownBorder': c.borderStrong, 'settings.checkboxBackground': c.elev, 'settings.checkboxBorder': c.borderStrong,
		'gitDecoration.addedResourceForeground': c.add, 'gitDecoration.modifiedResourceForeground': c.warn, 'gitDecoration.deletedResourceForeground': c.del, 'gitDecoration.untrackedResourceForeground': c.ok,
		'gitDecoration.ignoredResourceForeground': c.faint, 'gitDecoration.conflictingResourceForeground': c.accent, 'gitDecoration.stageModifiedResourceForeground': c.warn, 'gitDecoration.stageDeletedResourceForeground': c.del,
		'gitDecoration.submoduleResourceForeground': c.info,
		'debugToolBar.background': c.elev, 'debugToolBar.border': c.borderStrong, 'debugIcon.startForeground': c.ok, 'debugIcon.pauseForeground': c.accent, 'debugIcon.stopForeground': c.err, 'debugIcon.restartForeground': c.ok,
		'debugIcon.breakpointForeground': c.err, 'editor.stackFrameHighlightBackground': a(c.warn, '22'), 'editor.focusedStackFrameHighlightBackground': a(c.ok, '22'),
		'debugConsole.errorForeground': c.err, 'debugConsole.warningForeground': c.warn, 'debugConsole.infoForeground': c.info,
		'testing.iconPassed': c.ok, 'testing.iconFailed': c.err, 'testing.iconErrored': c.err, 'testing.iconQueued': c.warn,
		'extensionButton.prominentBackground': c.accent, 'extensionButton.prominentForeground': c.onAccent, 'extensionButton.prominentHoverBackground': c.accentHover,
		'extensionBadge.remoteBackground': c.accent, 'extensionBadge.remoteForeground': c.onAccent,
		'charts.foreground': c.text, 'charts.red': c.err, 'charts.blue': c.info, 'charts.yellow': c.warn, 'charts.orange': c.accent, 'charts.green': c.ok, 'charts.purple': c.kw,
		'problemsErrorIcon.foreground': c.err, 'problemsWarningIcon.foreground': c.warn, 'problemsInfoIcon.foreground': c.info,
		'minimap.background': c.bg, 'minimap.selectionHighlight': c.sel, 'minimap.findMatchHighlight': c.accent, 'minimapSlider.background': a(c.faint, '22'), 'minimapSlider.hoverBackground': a(c.faint, '33'),
		'sash.hoverBorder': c.accent, 'banner.background': c.elev, 'banner.foreground': c.text, 'banner.iconForeground': c.accent,
		'welcomePage.tileBackground': c.elev, 'welcomePage.tileHoverBackground': c.hover, 'welcomePage.progress.foreground': c.accent, 'walkThrough.embeddedEditorBackground': c.surface,
		'editorBracketHighlight.foreground1': c.muted, 'editorBracketHighlight.foreground2': c.kw, 'editorBracketHighlight.foreground3': c.type, 'editorBracketHighlight.foreground4': c.str, 'editorBracketHighlight.foreground5': c.cst, 'editorBracketHighlight.foreground6': c.prop, 'editorBracketHighlight.unexpectedBracket.foreground': c.err,
		'symbolIcon.keywordForeground': c.kw, 'symbolIcon.functionForeground': c.accent, 'symbolIcon.classForeground': c.type, 'symbolIcon.methodForeground': c.accent
	};
	['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White', 'BrightBlack', 'BrightRed', 'BrightGreen', 'BrightYellow', 'BrightBlue', 'BrightMagenta', 'BrightCyan', 'BrightWhite']
		.forEach((n, i) => { colors['terminal.ansi' + n] = c.ansi[i]; });
	const tc = (scope, fg, fontStyle) => ({ scope, settings: Object.assign({ foreground: fg }, fontStyle ? { fontStyle } : {}) });
	const tokenColors = [
		tc(['comment', 'punctuation.definition.comment'], c.cm),
		tc(['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control', 'keyword.operator.new', 'keyword.operator.expression', 'keyword.operator.logical.python'], c.kw),
		tc(['keyword.operator', 'punctuation.accessor', 'punctuation.separator', 'punctuation.terminator', 'meta.brace'], c.op),
		tc(['string', 'string.quoted', 'punctuation.definition.string'], c.str),
		tc(['constant.character.escape', 'string.regexp', 'constant.other.character-class.regexp'], c.rx),
		tc(['constant.numeric', 'constant.language.boolean', 'constant.language.null', 'constant.language.undefined'], c.num),
		tc(['constant', 'support.constant', 'variable.language'], c.cst),
		tc(['entity.name.type', 'entity.name.class', 'entity.other.inherited-class', 'support.type', 'support.class', 'entity.name.namespace', 'storage.type.cs', 'storage.type.kotlin'], c.type),
		tc(['entity.name.function', 'support.function', 'meta.function-call entity.name.function', 'entity.name.method'], c.fn),
		tc(['variable', 'variable.other.readwrite', 'meta.definition.variable'], c.va),
		tc(['variable.other.property', 'variable.other.object.property', 'support.type.property-name', 'meta.object-literal.key', 'entity.name.tag.yaml'], c.prop),
		tc(['entity.name.tag', 'punctuation.definition.tag', 'meta.tag'], c.kw),
		tc(['entity.other.attribute-name'], c.type),
		tc(['meta.annotation', 'storage.type.annotation', 'entity.name.decorator', 'meta.decorator'], c.cst),
		tc(['markup.heading', 'entity.name.section.markdown', 'markup.heading entity.name'], c.accent, 'bold'),
		tc(['markup.bold'], c.text, 'bold'), tc(['markup.italic'], c.text, 'italic'), tc(['markup.strikethrough'], c.muted, 'strikethrough'),
		tc(['markup.inline.raw', 'markup.fenced_code', 'markup.raw'], c.str),
		tc(['markup.underline.link', 'string.other.link'], c.info),
		tc(['markup.quote'], c.muted), tc(['markup.list punctuation.definition.list', 'punctuation.definition.list.begin.markdown'], c.accent),
		tc(['markup.inserted'], c.add), tc(['markup.deleted'], c.del), tc(['markup.changed'], c.warn),
		tc(['invalid', 'invalid.illegal'], c.err)
	];
	return {
		$schema: 'vscode://schemas/color-theme', name: c.name, type: c.type, colors, tokenColors,
		semanticHighlighting: true,
		semanticTokenColors: {
			'class': c.type, 'interface': c.type, 'enum': c.type, 'struct': c.type, 'typeParameter': c.type, 'type': c.type, 'namespace': c.type,
			'function': c.fn, 'method': c.fn, 'macro': c.cst, 'variable': c.va, 'parameter': c.va, 'property': c.prop, 'enumMember': c.cst, 'decorator': c.cst
		}
	};
}

// WCAG helpers for the report
const L = h => { const v = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(x => x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4)); return .2126 * v[0] + .7152 * v[1] + .0722 * v[2]; };
const cr = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };

for (const [k, c] of Object.entries(P)) {
	fs.writeFileSync(path.join(__dirname, '..', 'themes', `event-minimal-${k}.json`), JSON.stringify(build(c), null, '\t') + '\n');
	const pairs = [['text/bg', c.text, c.bg, 4.5], ['text/panel', c.text, c.panel, 4.5], ['muted/panel', c.muted, c.panel, 4.5], ['faint/bg', c.faint, c.bg, 4.5], ['faint/panel', c.faint, c.panel, 4.5], ['faint/surface', c.faint, c.surface, 4.5], ['muted/surface', c.muted, c.surface, 4.5],
		['accent/bg', c.accent, c.bg, 4.5], ['accent/panel', c.accent, c.panel, 4.5], ['onAccent/accent', c.onAccent, c.accent, 4.5], ['comment/bg', c.cm, c.bg, 4.5], ['kw/bg', c.kw, c.bg, 4.5], ['str/bg', c.str, c.bg, 4.5], ['type/bg', c.type, c.bg, 4.5],
		['num/bg', c.num, c.bg, 4.5], ['const/bg', c.cst, c.bg, 4.5], ['rx/bg', c.rx, c.bg, 4.5], ['err/bg', c.err, c.bg, 4.5], ['warn/bg', c.warn, c.bg, 4.5], ['ok/bg', c.ok, c.bg, 4.5], ['info/bg', c.info, c.bg, 4.5], ['ctrlBorder/elev', c.borderStrong, c.elev, 3], ['ctrlBorder/panel', c.borderStrong, c.panel, 3]];
	console.log('\n' + c.name);
	pairs.forEach(([n, f, b, need]) => { const r = cr(f, b); console.log((r >= need ? '  ok  ' : '  FAIL') + ' ' + n.padEnd(18) + r.toFixed(2)); });
}
