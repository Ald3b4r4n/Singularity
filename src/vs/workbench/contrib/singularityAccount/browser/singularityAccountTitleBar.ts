/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Singularity IDE contributors. Licensed under the MIT License.
 *  See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/singularityAccountTitleBar.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IsWebContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';

/**
 * The account entry of the title bar. The account itself (OAuth device flow, tokens, publishing authorization) lives in the
 * `singularity-account` extension; this file only shows its public state and routes the click to its commands.
 *
 * The extension publishes, with `setContext`, only public values: whether it is ready, whether an account is connected,
 * the login, the display name, the avatar as a data URI and whether publishing is authorized. Tokens never reach the workbench.
 */
const KEY = {
	ready: 'singularity.account.ready',
	signedIn: 'singularity.account.signedIn',
	login: 'singularity.account.login',
	name: 'singularity.account.name',
	avatar: 'singularity.account.avatar',
	publishAuthorized: 'singularity.account.publishAuthorized',
};

const ACTION_ID = 'singularity.account.titleBarEntry';
const SIGN_IN_COMMAND = 'singularity.account.signIn';
const MANAGE_COMMAND = 'singularity.account.manage';

class AccountTitleBarEntryAction extends Action2 {
	constructor() {
		super({
			id: ACTION_ID,
			title: localize2('singularity.account.titleBar', "Conta GitHub"),
			f1: false,
			menu: [{
				id: MenuId.TitleBarAdjacentCenter,
				order: 0,
				// shown only when the account extension is running, so the button is never a dead end
				when: ContextKeyExpr.and(IsWebContext.negate(), ContextKeyExpr.has(KEY.ready)),
			}]
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const signedIn = !!accessor.get(IContextKeyService).getContextKeyValue<boolean>(KEY.signedIn);
		return accessor.get(ICommandService).executeCommand(signedIn ? MANAGE_COMMAND : SIGN_IN_COMMAND);
	}
}

class AccountTitleBarEntry extends BaseActionViewItem {

	private content: HTMLElement | undefined;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super(undefined, action, options);

		const keys = new Set<string>(Object.values(KEY));
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(keys)) {
				this.renderState();
			}
		}));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.setAttribute('role', 'button');
		this.content = append(container, $('.singularity-account-entry'));
		this.renderState();
	}

	private renderState(): void {
		if (!this.content) {
			return;
		}

		const signedIn = !!this.contextKeyService.getContextKeyValue<boolean>(KEY.signedIn);
		const login = this.contextKeyService.getContextKeyValue<string>(KEY.login) ?? '';
		const avatar = this.contextKeyService.getContextKeyValue<string>(KEY.avatar) ?? '';
		const publishAuthorized = !!this.contextKeyService.getContextKeyValue<boolean>(KEY.publishAuthorized);

		clearNode(this.content);
		this.content.classList.toggle('signed-in', signedIn);
		this.content.classList.toggle('signed-out', !signedIn);

		let label: string;
		if (signedIn) {
			// only an image produced by the extension from the account's public avatar is accepted
			if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) {
				const img = append(this.content, $<HTMLImageElement>('img.avatar'));
				img.src = avatar;
				img.alt = '';
			} else {
				append(this.content, $('span.codicon.codicon-account'));
			}
			append(this.content, $('span.login')).textContent = login;
			append(this.content, $('span.status-dot'));
			label = publishAuthorized
				? localize('singularity.account.signedInPublishOn', "GitHub: {0}. Conectada. Publicação autorizada. Clique para gerenciar.", login)
				: localize('singularity.account.signedInPublishOff', "GitHub: {0}. Conectada. Publicação não autorizada. Clique para gerenciar.", login);
		} else {
			append(this.content, $('span.codicon.codicon-github'));
			append(this.content, $('span.login')).textContent = localize('singularity.account.signIn', "Entrar com GitHub");
			label = localize('singularity.account.signInTooltip', "Entrar com a sua conta GitHub");
		}

		if (this.element) {
			this.element.setAttribute('aria-label', label);
			this.element.title = label;
		}
	}

	protected override updateLabel(): void { /* the label is derived from the account state */ }
}

class SingularityAccountTitleBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.singularityAccountTitleBar';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(actionViewItemService.register(
			MenuId.TitleBarAdjacentCenter,
			ACTION_ID,
			(action, options) => instantiationService.createInstance(AccountTitleBarEntry, action, options)
		));
	}
}

registerAction2(AccountTitleBarEntryAction);
registerWorkbenchContribution2(SingularityAccountTitleBarContribution.ID, SingularityAccountTitleBarContribution, WorkbenchPhase.BlockRestore);
