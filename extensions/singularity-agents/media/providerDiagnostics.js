(function () {
 'use strict';
 const vscode = acquireVsCodeApi(), list = document.getElementById('providers'), notice = document.getElementById('notice');
 let busy = false;
 const label = { ready:'Disponível', 'not-installed':'Não instalado', 'authentication-required':'Conectar conta', unavailable:'Indisponível', error:'Falha de diagnóstico' };
 const auth = { configured:'Conexão oficial configurada; acesso ao modelo ainda depende do provedor', 'not-configured':'Nenhuma conexão oficial configurada', unknown:'Não verificada' };
 function node(tag, text, parent) { const e = document.createElement(tag); if (text !== undefined) { e.textContent = text; } if (parent) { parent.append(e); } return e; }
 function button(text, action, parent) { const b = node('button', text, parent); b.dataset.action = action; return b; }
 function render(providers) {
  list.replaceChildren();
  for (const p of providers) {
   const card = node('article', undefined, list); card.className = 'provider'; card.dataset.provider = p.id;
   node('h2', p.name, card); const dl = node('dl', undefined, card), d = p.diagnostic;
   for (const [key, value] of [['Versão instalada',p.version || 'Não confirmada'],['Estado', label[p.status] || p.status],['Autenticação',d ? auth[d.authentication] : p.authenticated ? 'Conexão informada pelo CLI' : 'Não verificada'],['Catálogo',d ? d.catalog === 'available' ? 'Disponível' : 'Indisponível' : 'Não consultado neste diagnóstico'],['Configuração',d?.profile === 'isolated' ? 'Isolada · somente este workspace' : 'Perfil normal'],['Problema identificado',d?.message || p.reason || 'Nenhum problema informado'],['Ação recomendada',d?.recommendation || 'Use Instalação e conta para gerenciar este provedor.']]) { node('dt',key,dl); node('dd',value,dl); }
   if (d?.code === 'plugins') { node('p','A fase de ativação foi identificada; o plugin ou a dependência responsável continua indeterminado.',card).className='hint'; }
   const actions = node('div',undefined,card); actions.className = 'actions';
   if (p.id === 'opencode') { button('Diagnosticar','diagnose',actions); if (d?.code === 'plugins' && d.profile !== 'isolated' && d.version?.startsWith('2.')) { button('Iniciar com configuração isolada','isolated',actions); } if (d?.profile === 'isolated') { button('Retornar ao perfil normal','normal',actions); } }
  }
  for (const b of document.querySelectorAll('button')) { b.disabled = busy; }
 }
 document.addEventListener('click',event=>{const b=event.target.closest('button');const action=b?.dataset.action || ({retry:'retry',manage:'manage',use:'use'})[b?.id];if(action&&!busy) { vscode.postMessage({action}); }});
 window.addEventListener('message',({data})=>{if(data?.type==='providers') { render(data.providers); } if(data?.type==='notice') { notice.textContent=data.message; } if(data?.type==='busy') { busy=data.value; for(const b of document.querySelectorAll('button')) { b.disabled=busy; } }});
 vscode.postMessage({action:'ready'});
})();
