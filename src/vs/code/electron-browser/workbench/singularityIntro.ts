/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Singularity IDE contributors. Licensed under the MIT License.
 *  See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Cinematic startup overlay (Event Minimal). Runs in the renderer bootstrap, before the workbench
 * is imported, so it is part of the real startup rather than a page opened afterwards.
 *
 * - Pure CSS animation on transform and opacity of HTML layers. Every animation is finite and the scene
 *   comes to rest after about four seconds, so a slow workbench load does not keep the renderer animating.
 * - Built with DOM APIs: the window's CSP enforces Trusted Types.
 * - No assets, no network, no audio.
 * - Every failure path ends with the overlay removed: it can never keep the IDE from opening.
 */

/* eslint-disable no-restricted-globals */

import { INTRO_HARD_TIMEOUT_MS, INTRO_KEYS, INTRO_MIN_MS, IntroVariant, leaveDelayMs, resolveIntroVariant, skipHint } from '../../../base/common/singularityIntroLogic.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ID = 'singularity-intro';

interface IIntroWindowConfiguration {
	autoDetectHighContrast?: boolean;
	colorScheme?: { highContrast?: boolean };
	nls?: { language?: string };
	extensionTestsPath?: string;
	['enable-smoke-test-driver']?: boolean;
}

function storage(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function remember(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// private/blocked storage: the intro just behaves as "first run" every time
	}
}

function svg(tag: string, attrs: Record<string, string | number>, ...children: Element[]): SVGElement {
	const el = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) {
		el.setAttribute(k, String(v));
	}
	for (const c of children) {
		el.appendChild(c);
	}
	return el as SVGElement;
}

function html(tag: string, className: string, text?: string): HTMLElement {
	const el = document.createElement(tag);
	el.className = className;
	if (text !== undefined) {
		el.textContent = text;
	}
	return el;
}

function box(className: string, ...children: Element[]): HTMLElement {
	const el = html('div', className);
	for (const c of children) {
		el.appendChild(c);
	}
	return el;
}

const stop = (offset: number, color: string, opacity?: number): SVGElement => svg('stop', { offset, 'stop-color': color, ...(opacity !== undefined ? { 'stop-opacity': opacity } : {}) });

/** One full-size SVG per visual piece, wrapped in an HTML box: the boxes are what the compositor animates. */
function layer(...children: Element[]): SVGElement {
	return svg('svg', { class: 'si-layer', viewBox: '0 0 256 256', 'aria-hidden': 'true', focusable: 'false' }, ...children);
}

/** The approved Event Minimal mark (see branding/event-minimal): photon ring and accretion disc, plus a lensed arc and a moving hot spot. */
function buildLayers(): HTMLElement[] {
	const defs = svg('defs', {},
		svg('linearGradient', { id: 'si-ring', x1: 0, y1: 0, x2: 1, y2: 1 }, stop(0, '#FFE2B0'), stop(0.5, '#FFB45E'), stop(1, '#FF6A3D')),
		svg('linearGradient', { id: 'si-disc', x1: 0, y1: 0, x2: 1, y2: 0 }, stop(0, '#FFB45E', 0), stop(0.22, '#FFB45E'), stop(0.5, '#FFEBC9'), stop(0.78, '#FF7A45'), stop(1, '#FF7A45', 0)),
		svg('linearGradient', { id: 'si-hot', x1: 0, y1: 0, x2: 1, y2: 0 }, stop(0, '#FFFFFF', 0), stop(0.5, '#FFF4DC', 0.95), stop(1, '#FFFFFF', 0)),
	);
	// The far side of the disc, bent over the top of the shadow by gravity. Also carries the gradient definitions.
	const lens = box('si-lens', layer(defs, svg('path', { d: 'M 58 112 A 72 72 0 0 1 198 112', fill: 'none', stroke: 'url(#si-disc)', 'stroke-width': 2.4, 'stroke-linecap': 'round' })));
	const ring = box('si-ringbox', layer(svg('circle', { cx: 128, cy: 128, r: 60, fill: '#000000', stroke: 'url(#si-ring)', 'stroke-width': 8 })));
	const disc = box('si-tilt', box('si-disc', layer(svg('ellipse', { cx: 128, cy: 128, rx: 112, ry: 6, fill: 'url(#si-disc)' }))));
	const hot = box('si-tilt', box('si-hotmove', box('si-hot', layer(svg('ellipse', { cx: 128, cy: 128, rx: 26, ry: 3.2, fill: 'url(#si-hot)' })))));
	return [lens, ring, disc, hot];
}

const CSS = `
#${ID}{position:fixed;inset:0;z-index:2147483000;background:#07080C;color:#EDEEF1;overflow:hidden;opacity:1;
 font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;-webkit-user-select:none;user-select:none;cursor:default;
 transition:opacity calc(var(--k) * 650ms + 150ms) cubic-bezier(.4,0,.2,1)}
#${ID}.si-leaving{opacity:0;pointer-events:none}
#${ID}.si-through{pointer-events:none}
#${ID} .si-stage{position:absolute;left:50%;top:44%;width:min(52vmin,440px);aspect-ratio:1;transform:translate(-50%,-50%);will-change:transform;
 transition:transform calc(var(--k) * 900ms + 200ms) cubic-bezier(.3,0,.2,1)}
#${ID}.si-leaving .si-stage{transform:translate(-50%,-50%) scale(1.07)}
#${ID} .si-layer,#${ID} .si-shimmer .si-layer,#${ID} .si-lens,#${ID} .si-ringbox,#${ID} .si-tilt,#${ID} .si-disc,#${ID} .si-hotmove,#${ID} .si-hot{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
#${ID} .si-tilt{transform:rotate(-14deg)}
#${ID} .si-halo{position:absolute;inset:-34%;border-radius:50%;pointer-events:none;will-change:transform,opacity;
 background:radial-gradient(circle,rgba(255,180,94,0) 33%,rgba(255,180,94,.20) 41%,rgba(255,140,60,.07) 52%,rgba(255,180,94,0) 66%);
 animation:si-halo calc(var(--k) * 1700ms) calc(var(--k) * 200ms) cubic-bezier(.2,.6,.2,1) backwards}
#${ID} .si-ringbox{will-change:transform,opacity;animation:si-ring calc(var(--k) * 1300ms) calc(var(--k) * 300ms) cubic-bezier(.2,.7,.2,1) backwards}
#${ID} .si-lens{opacity:.5;will-change:opacity;animation:si-fade calc(var(--k) * 1400ms) calc(var(--k) * 1600ms) ease-out backwards}
#${ID} .si-disc{will-change:transform,opacity;animation:si-disc calc(var(--k) * 1300ms) calc(var(--k) * 1000ms) cubic-bezier(.2,.7,.2,1) backwards}
#${ID} .si-hotmove{will-change:transform;animation:si-sweep calc(var(--k) * 2200ms) calc(var(--k) * 1800ms) cubic-bezier(.3,.1,.2,1) backwards}
#${ID} .si-hot{will-change:opacity;animation:si-fade calc(var(--k) * 400ms) calc(var(--k) * 1800ms) ease-out backwards}
#${ID} .si-shimmer{position:absolute;inset:0;pointer-events:none;opacity:.85;will-change:transform,opacity;
 animation:si-fade calc(var(--k) * 1100ms) calc(var(--k) * 900ms) ease-out backwards,si-spin calc(var(--k) * 3400ms) calc(var(--k) * 900ms) cubic-bezier(.25,.1,.25,1) backwards}
#${ID} .si-words{position:absolute;left:0;right:0;top:calc(44% + min(52vmin,440px) * .5 + 3vmin);text-align:center}
#${ID} .si-title{font-size:clamp(22px,4.6vmin,48px);font-weight:300;letter-spacing:.42em;padding-left:.42em;color:#EDEEF1;text-shadow:0 0 28px rgba(255,180,94,.22);
 animation:si-title calc(var(--k) * 1200ms) calc(var(--k) * 2000ms) cubic-bezier(.2,.7,.2,1) backwards}
#${ID} .si-sub{margin-top:1.1vmin;font-size:clamp(11px,1.9vmin,19px);font-weight:500;letter-spacing:.95em;padding-left:.95em;color:#FFB45E;
 animation:si-sub calc(var(--k) * 1000ms) calc(var(--k) * 2500ms) cubic-bezier(.2,.7,.2,1) backwards}
#${ID} .si-rule{width:min(22vmin,180px);height:1px;margin:2.2vmin auto 0;background:linear-gradient(90deg,transparent,rgba(255,180,94,.7),transparent);transform-origin:center;
 animation:si-rule calc(var(--k) * 1000ms) calc(var(--k) * 2700ms) cubic-bezier(.2,.7,.2,1) backwards}
#${ID} .si-hint{position:absolute;left:0;right:0;bottom:3.2vmin;text-align:center;font-size:12px;letter-spacing:.06em;color:#8089A3;
 animation:si-fade calc(var(--k) * 900ms) calc(var(--k) * 2400ms) ease-out backwards}
@keyframes si-halo{from{opacity:0;transform:scale(.86)}}
@keyframes si-ring{from{opacity:0;transform:scale(.93)}}
@keyframes si-disc{from{opacity:0;transform:scaleX(.05)}}
@keyframes si-sweep{from{transform:translateX(-30%)}}
@keyframes si-fade{from{opacity:0}}
@keyframes si-spin{to{transform:rotate(360deg)}}
@keyframes si-title{from{opacity:0;transform:translateY(10px) scale(1.05)}}
@keyframes si-sub{from{opacity:0;transform:translateY(6px)}}
@keyframes si-rule{from{opacity:0;transform:scaleX(0)}}
#${ID}.si-static *{animation:none!important}
#${ID}.si-static .si-shimmer,#${ID}.si-static .si-hot,#${ID}.si-static .si-hint{display:none}
#${ID}.si-static,#${ID}.si-static .si-stage{transition:opacity .2s linear!important}
#${ID}.si-static.si-leaving .si-stage{transform:translate(-50%,-50%)}
@media (prefers-reduced-motion:reduce){#${ID} *{animation:none!important}}
`;

let current: { dispose(): void } | undefined;
let hint = skipHint();

function play(variant: Exclude<IntroVariant, 'none'>, readyAlready: boolean): void {
	current?.dispose();

	const k = variant === 'full' ? 1 : variant === 'quick' ? 0.22 : 0;
	const style = document.createElement('style');
	style.id = `${ID}-style`;
	style.textContent = CSS;

	const overlay = html('div', `si-${variant}`);
	overlay.id = ID;
	overlay.setAttribute('aria-hidden', 'true');
	overlay.style.setProperty('--k', String(k));

	const stage = html('div', 'si-stage');
	stage.appendChild(html('div', 'si-halo'));
	for (const l of buildLayers()) {
		stage.appendChild(l);
	}
	stage.appendChild(box('si-shimmer', layer(svg('path', { d: 'M 82.04 89.43 A 60 60 0 0 1 166.57 82.04', fill: 'none', stroke: 'url(#si-hot)', 'stroke-width': 8.5, 'stroke-linecap': 'round' }))));
	const words = html('div', 'si-words');
	words.appendChild(html('div', 'si-title', 'SINGULARITY'));
	words.appendChild(html('div', 'si-sub', 'IDE'));
	words.appendChild(html('div', 'si-rule'));
	overlay.appendChild(stage);
	overlay.appendChild(words);
	if (variant === 'full') {
		overlay.appendChild(html('div', 'si-hint', hint));
	}

	const startedAt = performance.now();
	let ready = readyAlready;
	let finished = false;
	let leaveTimer: number | undefined;
	// eslint-disable-next-line prefer-const
	let hardTimer: number | undefined;
	let removeTimer: number | undefined;

	const cleanup = (): void => {
		window.removeEventListener('singularity:workbench-restored', onReady);
		window.removeEventListener('keydown', onKey, true);
		window.removeEventListener('pointerdown', onPointer, true);
		window.clearTimeout(leaveTimer);
		window.clearTimeout(hardTimer);
		window.clearTimeout(removeTimer);
		overlay.remove();
		style.remove();
		if (current === handle) {
			current = undefined;
		}
	};
	const handle = { dispose: cleanup };
	current = handle; // registered before touching the DOM, so a failure below is cleaned up by the caller

	const leave = (reason: string): void => {
		if (finished) {
			return;
		}
		finished = true;
		performance.mark(`singularity/introLeave:${reason}`);
		overlay.classList.add('si-leaving');
		const ms = variant === 'static' ? 220 : k * 650 + 150;
		removeTimer = window.setTimeout(() => { performance.mark('singularity/introEnd'); cleanup(); }, ms + 80);
	};

	const scheduleLeave = (): void => {
		const delay = leaveDelayMs(variant, performance.now() - startedAt, ready);
		if (delay === undefined || finished) {
			return;
		}
		window.clearTimeout(leaveTimer);
		leaveTimer = window.setTimeout(() => leave('done'), delay);
	};

	function onReady(): void {
		if (ready) {
			return;
		}
		ready = true;
		performance.mark('singularity/introReady');
		// The IDE is usable from now on: clicks go through, and the overlay only plays out its minimum.
		overlay.classList.add('si-through');
		scheduleLeave();
	}
	function onKey(e: KeyboardEvent): void {
		if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
			leave('skip-key');
		}
	}
	function onPointer(): void {
		leave('skip-pointer');
	}

	window.document.head.appendChild(style);
	window.document.body.appendChild(overlay);
	performance.mark('singularity/introStart');
	window.addEventListener('singularity:workbench-restored', onReady);
	window.addEventListener('keydown', onKey, true);
	window.addEventListener('pointerdown', onPointer, true);
	hardTimer = window.setTimeout(() => leave('timeout'), INTRO_HARD_TIMEOUT_MS);
	if (ready) {
		overlay.classList.add('si-through');
	}
	scheduleLeave();
}

/** The user and OS locales the main process put in VSCODE_NLS_CONFIG (the renderer's navigator.language is always en-US). */
function osLocales(raw: string | undefined): string[] {
	try {
		const parsed = raw ? JSON.parse(raw) as { userLocale?: string; osLocale?: string } : undefined;
		return [parsed?.userLocale, parsed?.osLocale].filter((l): l is string => typeof l === 'string');
	} catch {
		return [];
	}
}

function isWorkbenchReady(): boolean {
	return (window as unknown as { __singularityWorkbenchRestored?: boolean }).__singularityWorkbenchRestored === true;
}

/**
 * Called from the renderer bootstrap right after the parts splash. Never throws.
 * `INTRO_MIN_MS` is a floor for how long the overlay is visible, not a delay on the workbench,
 * which keeps loading underneath.
 */
export function showSingularityIntro(configuration: IIntroWindowConfiguration, rawNlsConfig?: string): void {
	try {
		hint = skipHint(configuration.nls?.language, osLocales(rawNlsConfig), window.navigator.language);
		const variant = resolveIntroVariant({
			mode: storage(INTRO_KEYS.mode),
			seen: storage(INTRO_KEYS.seen) === '1',
			reduceMotionSetting: storage(INTRO_KEYS.reduceMotion),
			osReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
			highContrast: !!(configuration.autoDetectHighContrast && configuration.colorScheme?.highContrast),
			automated: typeof configuration.extensionTestsPath === 'string' || configuration['enable-smoke-test-driver'] === true,
		});

		// The "Replay the Opening" command asks for a full replay on a running workbench.
		window.addEventListener('singularity:play-intro', () => {
			try {
				const setting = storage(INTRO_KEYS.reduceMotion);
				const reduce = setting === 'on' || (setting !== 'off' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
				play(reduce ? 'static' : 'full', isWorkbenchReady());
			} catch {
				current?.dispose();
			}
		});

		if (variant === 'none') {
			return;
		}
		if (variant === 'full') {
			remember(INTRO_KEYS.seen, '1');
		}
		play(variant, isWorkbenchReady());
	} catch {
		current?.dispose();
	}
}

export { INTRO_MIN_MS };
