/*---------------------------------------------------------------------------------------------
 *  Singularity IDE. MIT License.
 *  Pure decisions for the startup intro. No DOM, so it can be tested in plain Node.
 *--------------------------------------------------------------------------------------------*/

export type IntroMode = 'firstRun' | 'always' | 'quick' | 'off';
export type IntroVariant = 'full' | 'quick' | 'static' | 'none';

/** localStorage keys shared by the bootstrap (reads) and the workbench contribution (writes). */
export const INTRO_KEYS = {
	mode: 'singularity.intro.mode',
	seen: 'singularity.intro.seen',
	reduceMotion: 'singularity.intro.reduceMotion',
} as const;

/** The intro never needs longer than this, whatever happens to the workbench. */
export const INTRO_HARD_TIMEOUT_MS = 20_000;

/** Shortest time each variant stays up, counted from its start. Not a delay once the workbench is ready and the minimum has passed. */
export const INTRO_MIN_MS: Record<Exclude<IntroVariant, 'none'>, number> = {
	full: 3600,
	quick: 650,
	static: 350,
};

export function parseMode(value: string | null | undefined): IntroMode {
	return value === 'always' || value === 'quick' || value === 'off' || value === 'firstRun' ? value : 'firstRun';
}

export interface IntroInputs {
	/** Raw stored value of the singularity.startup.intro setting. */
	mode?: string | null;
	/** True once a full intro has been shown on this machine and profile. */
	seen: boolean;
	/** Raw stored value of workbench.reduceMotion: 'on' | 'off' | 'auto'. */
	reduceMotionSetting?: string | null;
	/** matchMedia('(prefers-reduced-motion: reduce)'). */
	osReducedMotion: boolean;
	highContrast: boolean;
	/** Extension tests and the smoke driver must never see an overlay. */
	automated: boolean;
}

export function resolveIntroVariant(input: IntroInputs): IntroVariant {
	const mode = parseMode(input.mode);
	if (mode === 'off' || input.automated || input.highContrast) {
		return 'none';
	}
	const wanted: 'full' | 'quick' = mode === 'quick' ? 'quick' : mode === 'always' ? 'full' : input.seen ? 'quick' : 'full';
	const reduce = input.reduceMotionSetting === 'on' || (input.reduceMotionSetting !== 'off' && input.osReducedMotion);
	return reduce ? 'static' : wanted;
}

/** When the overlay may start leaving: the later of "workbench ready" and the variant's minimum. */
export function leaveDelayMs(variant: Exclude<IntroVariant, 'none'>, elapsedMs: number, workbenchReady: boolean): number | undefined {
	if (!workbenchReady) {
		return undefined;
	}
	return Math.max(0, INTRO_MIN_MS[variant] - elapsedMs);
}
