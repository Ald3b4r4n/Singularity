/*---------------------------------------------------------------------------------------------
 *  Singularity IDE. MIT License.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { INTRO_KEYS } from '../../../../base/common/singularityIntroLogic.js';

const SETTING = 'singularity.startup.intro';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'singularity.startup',
	order: 1,
	title: localize('singularity.startup', "Singularity Startup"),
	type: 'object',
	properties: {
		[SETTING]: {
			type: 'string',
			enum: ['firstRun', 'always', 'quick', 'off'],
			enumDescriptions: [
				localize('singularity.startup.intro.firstRun', "Play the full opening on the first launch and a brief one afterwards."),
				localize('singularity.startup.intro.always', "Play the full opening on every launch."),
				localize('singularity.startup.intro.quick', "Always play the brief opening."),
				localize('singularity.startup.intro.off', "Never play an opening."),
			],
			default: 'firstRun',
			description: localize('singularity.startup.intro.description', "Controls the Singularity opening shown while the window loads. The opening never delays the workbench, can be skipped with Esc, and is replaced by a still image when reduced motion is requested. A change takes effect from the next launch."),
		},
	},
});

/**
 * Hands two things to the renderer bootstrap, which runs before settings are available:
 *  - the user's choices (mirrored into localStorage, read at the next start), and
 *  - the moment the workbench is restored (a window event), so the opening can leave.
 */
class SingularityIntroContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.singularityIntro';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		this.mirror();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SETTING) || e.affectsConfiguration('workbench.reduceMotion')) {
				this.mirror();
			}
		}));
		lifecycleService.when(LifecyclePhase.Restored).then(() => {
			(mainWindow as unknown as { __singularityWorkbenchRestored?: boolean }).__singularityWorkbenchRestored = true;
			mainWindow.dispatchEvent(new Event('singularity:workbench-restored'));
		});
	}

	private mirror(): void {
		try {
			mainWindow.localStorage.setItem(INTRO_KEYS.mode, String(this.configurationService.getValue<string>(SETTING) ?? 'firstRun'));
			mainWindow.localStorage.setItem(INTRO_KEYS.reduceMotion, String(this.configurationService.getValue<string>('workbench.reduceMotion') ?? 'auto'));
		} catch {
			// storage unavailable: the bootstrap falls back to defaults
		}
	}
}

registerWorkbenchContribution2(SingularityIntroContribution.ID, SingularityIntroContribution, WorkbenchPhase.BlockStartup);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'singularity.intro.replay',
			title: localize2('singularity.intro.replay', "Replay the Opening"),
			category: localize2('singularity.category', "Singularity"),
			f1: true,
		});
	}

	run(): void {
		mainWindow.dispatchEvent(new Event('singularity:play-intro'));
	}
});
