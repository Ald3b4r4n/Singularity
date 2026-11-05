
'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
function openProviderDiagnostics(hub, workspace, useProvider, manage, changed = () => {}) {
 const media = vscode.Uri.file(path.join(__dirname, 'media'));
 const panel = vscode.window.createWebviewPanel('singularity.providers.diagnostics', 'Gerenciar provedores', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true });
 const nonce = randomBytes(18).toString('base64');
 const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'providerDiagnostics.js'));
 panel.webview.html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">
 body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:1100px;margin:auto}h1{font-size:24px}p{line-height:1.6}#providers{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px}.provider{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:18px;min-width:0;overflow-wrap:anywhere}.provider h2{margin-top:0}dt{font-weight:600;margin-top:12px}dd{margin:4px 0 0}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}button{border:1px solid var(--vscode-button-border,var(--vscode-focusBorder));border-radius:5px;padding:8px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}button:disabled{opacity:.55;cursor:wait}#notice{white-space:pre-wrap}#notice:empty{display:none}.hint{color:var(--vscode-descriptionForeground)}
 </style></head><body><h1>Gerenciar provedores</h1><p>Diagnóstico de instalação, conexão e catálogo. Nenhuma tarefa de IA é iniciada por estes testes.</p><p id="notice" role="status" aria-live="polite"></p><section id="providers" aria-label="Condição dos provedores"></section><div class="actions"><button id="retry">Testar novamente</button><button id="manage">Instalação e conta</button><button id="use">Voltar aos Agentes</button></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
 let busy = false, disposed = false;
 const post = data => { if (!disposed) { void panel.webview.postMessage(data); } };
 async function refresh() {
  await hub.start(true);
  const providers = await hub.inspectProviders({ workspace, refresh: false });
  post({ type: 'providers', providers: providers.filter(p => p.id !== 'gemini-cli').map(p => ({ id: p.id, name: p.name, version: p.version, status: p.status, reason: p.reason, authenticated: p.authenticated, diagnostic: p.diagnostic })) });
 }
 const listener = panel.webview.onDidReceiveMessage(async message => {
  if (busy || !message || !['ready','retry','diagnose','isolated','normal','manage','use'].includes(message.action)) { return; }
  busy = true; post({ type: 'busy', value: true });
  try {
   if (message.action === 'manage') { await manage(); return; }
   if (message.action === 'use') { await useProvider('opencode'); return; }
   if (message.action === 'isolated' || message.action === 'normal') {
    if (!workspace || !vscode.workspace.isTrusted) { throw new Error('Abra um workspace local confiável para escolher o perfil.'); }
    if (message.action === 'isolated') {
     const choice = await vscode.window.showWarningMessage('Iniciar com configuração isolada?', { modal: true, detail: 'Somente novas sessões deste workspace usarão uma sobreposição temporária de plugins. Plugins fora do namespace nativo opencode.* serão filtrados: integrações, ferramentas e automações fornecidas por eles podem ficar indisponíveis. Plugins nativos e políticas administradas permanecem. Nenhum arquivo ou credencial será copiado; privacidade e região permanecem nas configurações existentes. A conexão oficial e o catálogo serão consultados antes de liberar sessões. A presença de credencial não garante acesso ao modelo. Sessões existentes não serão alteradas. O perfil normal será o padrão de novas sessões ao reiniciar o Hub.' }, 'Iniciar configuração isolada');
     if (choice !== 'Iniciar configuração isolada') { return; }
    }
    const result = await hub.selectProviderProfile({ id: 'opencode', workspace, profile: message.action, approved: true });
    if (!result?.selected) { post({ type: 'notice', message: result?.reason || 'O perfil não foi alterado.' }); }
    else { post({ type: 'notice', message: result.profile === 'isolated' ? 'Configuração isolada ativa para novas sessões deste workspace. Use Voltar aos Agentes para selecionar um modelo.' : 'Perfil normal restaurado para novas sessões. Sessões isoladas existentes permanecem identificadas.' }); changed(); }
   } else if (message.action === 'diagnose' || message.action === 'retry') {
    const diagnostic = await hub.diagnoseProvider({ id: 'opencode', workspace, refresh: true });
    post({ type: 'notice', message: diagnostic.message + '\n' + diagnostic.recommendation });
   }
   await refresh();
  } catch (error) { post({ type: 'notice', message: error.message || 'O diagnóstico não pôde ser concluído.' }); }
  finally { busy = false; post({ type: 'busy', value: false }); }
 });
 panel.onDidDispose(() => { disposed = true; listener.dispose(); });
 return panel;
}
module.exports = { openProviderDiagnostics };
