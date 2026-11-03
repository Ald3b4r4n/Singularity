// Run after `npm run compile-client`:  node --test scripts/singularity-intro.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INTRO_MIN_MS, leaveDelayMs, parseMode, resolveIntroVariant } from '../out/vs/base/common/singularityIntroLogic.js';

const base = { mode: undefined, seen: false, reduceMotionSetting: 'auto', osReducedMotion: false, highContrast: false, automated: false };
const variant = over => resolveIntroVariant({ ...base, ...over });

test('first launch plays the full opening, later launches the brief one (default mode)', () => {
	assert.equal(variant({}), 'full');
	assert.equal(variant({ seen: true }), 'quick');
	assert.equal(variant({ mode: null, seen: true }), 'quick');
});

test('"always" is full every time, "quick" is brief every time, "off" never plays', () => {
	assert.equal(variant({ mode: 'always', seen: true }), 'full');
	assert.equal(variant({ mode: 'quick', seen: false }), 'quick');
	assert.equal(variant({ mode: 'off', seen: false }), 'none');
});

test('an unknown stored value behaves like the default', () => {
	assert.equal(parseMode('banana'), 'firstRun');
	assert.equal(variant({ mode: 'banana' }), 'full');
});

test('reduced motion (setting or OS) turns every variant into a still image', () => {
	assert.equal(variant({ reduceMotionSetting: 'on' }), 'static');
	assert.equal(variant({ reduceMotionSetting: 'auto', osReducedMotion: true }), 'static');
	assert.equal(variant({ reduceMotionSetting: 'on', mode: 'always' }), 'static');
	assert.equal(variant({ reduceMotionSetting: 'off', osReducedMotion: true }), 'full', 'an explicit "off" wins over the OS hint');
	assert.equal(variant({ reduceMotionSetting: 'on', mode: 'off' }), 'none', 'off stays off');
});

test('high contrast and automated runs never get an overlay', () => {
	assert.equal(variant({ highContrast: true }), 'none');
	assert.equal(variant({ automated: true, mode: 'always' }), 'none');
});

test('the workbench is never held back: the overlay leaves as soon as it is ready and its minimum has passed', () => {
	assert.equal(leaveDelayMs('full', 100, false), undefined, 'waits for the workbench');
	assert.equal(leaveDelayMs('full', 100, true), INTRO_MIN_MS.full - 100);
	assert.equal(leaveDelayMs('full', 9000, true), 0, 'a slow workbench adds nothing on top');
	assert.equal(leaveDelayMs('quick', 10, true), INTRO_MIN_MS.quick - 10);
	assert.ok(INTRO_MIN_MS.quick < 1000 && INTRO_MIN_MS.static < INTRO_MIN_MS.quick && INTRO_MIN_MS.full < 5000);
});
