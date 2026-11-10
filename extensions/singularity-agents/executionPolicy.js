// The execution policy of the implementer, per workspace. It is read and changed only here, on the computer of the owner: the phone can
// see it and nothing else. Changing it is always explicit, and the two modes that let an agent run commands ask for a modal confirmation.
'use strict';

const MODES = {
	restricted: { label: 'Restrito', icon: '$(lock)', detail: 'O Implementador edita arquivos e não executa comandos. É o comportamento de antes.' },
	development: { label: 'Desenvolvimento', icon: '$(terminal)', detail: 'O Implementador usa o terminal na cópia de trabalho da equipe: instalar dependências, compilar, testar, lint e Git.' },
	autonomous: { label: 'Autônomo', icon: '$(rocket)', detail: 'O Implementador trabalha sem os limites que a ferramenta permite retirar, sem pedir aprovação a cada comando.' }
};

/** What is shown about a policy, in the words of the product. Pure, so it can be tested without the editor. */
function describe(policy) {
	const mode = MODES[policy?.mode] ? policy.mode : 'restricted';
	return { mode, label: MODES[mode].label, text: `${MODES[mode].icon} Implementador: ${MODES[mode].label}${mode !== 'restricted' && policy.external ? ' + publicação' : ''}`,
		tooltip: `${MODES[mode].detail}\n${mode === 'restricted' ? '' : policy.external ? 'Operações externas (git push, deploy, publicação de pacotes) estão autorizadas neste projeto.' : 'Operações externas (git push, deploy, publicação de pacotes) não estão autorizadas.'}\nClique para mudar.`.replace(/\n\n/g, '\n') };
}

/** The confirmation text of a mode: what the owner accepts by choosing it. */
function warning(mode, external) {
	const lines = mode === 'development'
		? ['O agente poderá executar comandos neste computador, com a sua conta do Windows.', 'Ele começa na cópia de trabalho da equipe, mas uma pasta não é uma barreira de segurança: um comando pode ler ou alterar arquivos fora dela e usar a rede.']
		: ['O agente poderá executar qualquer comando neste computador, com a sua conta do Windows, sem pedir aprovação.', 'No Claude Code isso usa o modo que ignora as permissões; no Codex CLI, o acesso total sem sandbox; no OpenCode, as permissões padrão.', 'Use somente em projetos seus e com tarefas que você acompanha.'];
	lines.push(external ? 'Você também autoriza operações que saem deste computador: git push, deploy e publicação de pacotes, com as contas em que este computador já está autenticado.'
		: 'Operações que saem deste computador (git push, deploy, publicação) continuam não autorizadas. Esse bloqueio é uma lista de comandos conhecidos, não uma garantia.');
	lines.push('O Revisor e o Testador continuam sem terminal e sem editar. Aplicar a solução ao projeto continua sendo um passo seu.');
	return lines.join('\n\n');
}

function register(vscode, hub, workspaceOf) {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
	item.command = 'singularity.agents.executionPolicy';
	let shown;
	const refresh = async () => {
		const workspace = workspaceOf();
		if (!workspace || hub.getState().hub.status !== 'connected') { item.hide(); return; }
		try { shown = await hub.sessionRequest('policy.get', { workspace }); const view = describe(shown); item.text = view.text; item.tooltip = view.tooltip; item.show(); }
		catch { item.hide(); }
	};
	const command = vscode.commands.registerCommand('singularity.agents.executionPolicy', async () => {
		try {
			const workspace = workspaceOf();
			if (!workspace) { void vscode.window.showInformationMessage('Abra a pasta do projeto para escolher o modo de execução do Implementador.'); return; }
			await hub.start(true);
			const current = await hub.sessionRequest('policy.get', { workspace });
			const picked = await vscode.window.showQuickPick(Object.entries(MODES).map(([mode, info]) => ({ label: `${info.icon} ${info.label}`, description: current.mode === mode ? 'atual' : '', detail: info.detail, mode })),
				{ title: 'Modo de execução do Implementador neste projeto', placeHolder: 'Vale para equipes e comparações iniciadas aqui ou pelo celular' });
			if (!picked) { return; }
			let external = false;
			if (picked.mode !== 'restricted') {
				const outside = await vscode.window.showQuickPick([
					{ label: '$(shield) Não autorizar operações externas', detail: 'git push, deploy e publicação de pacotes ficam bloqueados para o agente.', external: false },
					{ label: '$(cloud-upload) Autorizar operações externas', detail: 'O agente pode usar git push e CLIs de deploy (Vercel, GitHub e outras) quando a tarefa pedir.', external: true }
				], { title: 'Operações que saem deste computador', placeHolder: current.external ? 'Hoje: autorizadas' : 'Hoje: não autorizadas' });
				if (!outside) { return; }
				external = outside.external;
				const accept = picked.mode === 'autonomous' ? 'Ativar o modo autônomo' : 'Ativar o modo desenvolvimento';
				const answer = await vscode.window.showWarningMessage(`${MODES[picked.mode].label}: confirmar para este projeto?`, { modal: true, detail: warning(picked.mode, external) }, accept);
				if (answer !== accept) { return; }
			}
			await hub.sessionRequest('policy.set', { workspace, mode: picked.mode, external, confirm: true });
			await refresh();
			void vscode.window.showInformationMessage(`Implementador neste projeto: ${MODES[picked.mode].label}${picked.mode !== 'restricted' ? (external ? ', com operações externas autorizadas' : ', sem operações externas') : ''}.`);
		} catch (error) { void vscode.window.showErrorMessage(error && error.message ? error.message : 'Não foi possível mudar o modo de execução.'); }
	});
	void refresh();
	return [item, command, { dispose: hub.onDidChange(() => { void refresh(); }) }, vscode.workspace.onDidChangeWorkspaceFolders(() => { void refresh(); })];
}

module.exports = { register, describe, warning, MODES };
