// Only fixed messages and allow-listed metadata leave provider diagnostics.
export type DiagnosticCode = 'ready' | 'plugins' | 'local-authentication' | 'authentication' | 'rate-limit' | 'catalog' | 'startup' | 'unavailable' | 'unknown';
export interface ProviderDiagnostic {
 service: 'opencode'; profile: 'normal' | 'isolated'; code: DiagnosticCode; at: number; version?: string;
 authentication: 'configured' | 'not-configured' | 'unknown'; catalog: 'available' | 'unavailable';
 message: string; recommendation: string; httpStatus?: number; operation?: string;
 cause: 'activation-phase' | 'undetermined' | 'confirmed';
 integrations: Array<{ id: string; authentication: 'configured' | 'not-configured' }>;
}
const messages: Record<DiagnosticCode, [string, string]> = {
 ready: ['Catálogo disponível.', 'Selecione um modelo disponível. A presença de credencial não comprova acesso ao modelo.'],
 plugins: ['A ativação dos plugins do OpenCode não terminou (HTTP 503).', 'Verifique compatibilidade e dependências dos plugins. O plugin responsável ainda não foi identificado. Não reinstale nem altere sua conta para contornar este erro.'],
 'local-authentication': ['O servidor local recusou a autenticação do Hub.', 'Diagnostique a conexão local. Isto não comprova falha no login da assinatura.'],
 authentication: ['Nenhuma conexão configurada foi informada para OpenCode/OpenCode Go.', 'Conecte sua conta pelo fluxo oficial antes de executar inferência.'],
 'rate-limit': ['O OpenCode informou limite de utilização (HTTP 429).', 'Aguarde a disponibilidade da conta ou do modelo; não serão feitos retries automáticos.'],
 catalog: ['O catálogo OpenCode está indisponível.', 'Teste novamente quando o serviço estiver disponível. Não é possível atribuir esta falha a um plugin.'],
 startup: ['O servidor OpenCode não iniciou ou não confirmou o contrato v2.', 'Confira a versão instalada e o funcionamento do executável oficial.'],
 unavailable: ['OpenCode v2 não foi encontrado.', 'Instale ou selecione um executável oficial OpenCode v2.'],
 unknown: ['A causa da falha não pôde ser determinada com segurança.', 'Teste novamente ou consulte as instruções oficiais. Nenhuma configuração foi alterada.']
};
export function providerDiagnostic(code: DiagnosticCode, facts: Partial<Pick<ProviderDiagnostic, 'profile' | 'version' | 'authentication' | 'integrations' | 'httpStatus' | 'operation'>> = {}): ProviderDiagnostic {
 return { service: 'opencode', profile: facts.profile ?? 'normal', code, at: Date.now(), authentication: facts.authentication ?? 'unknown', catalog: code === 'ready' || code === 'authentication' ? 'available' : 'unavailable', message: messages[code][0], recommendation: messages[code][1], cause: code === 'plugins' ? 'activation-phase' : ['unknown', 'catalog', 'startup'].includes(code) ? 'undetermined' : 'confirmed', integrations: facts.integrations ?? [], ...facts };
}
export function classifyProviderFailure(status?: number, pluginsBlocked = false): DiagnosticCode {
 if (status === 503 && pluginsBlocked) { return 'plugins'; }
 if (status === 401 || status === 403) { return 'local-authentication'; }
 if (status === 429) { return 'rate-limit'; }
 return status ? 'catalog' : 'startup';
}
export function connectionFacts(raw: unknown): ProviderDiagnostic['integrations'] {
 const data = (raw as { data?: unknown })?.data;
 if (!Array.isArray(data)) { return []; }
 return data.filter(p => p && (p.id === 'opencode' || p.id === 'opencode-go')).slice(0, 2).map(p => ({ id: p.id as string,
  authentication: Array.isArray(p.connections) && p.connections.some((c: { type?: string }) => c && c.type === 'credential') ? 'configured' : 'not-configured' }));
}
/** Never return upstream text, headers, config, plugin paths, credential identifiers or labels. */
export async function pluginActivationFailure(response: Response): Promise<boolean> {
 if (response.status !== 503 || !response.body) { await response.body?.cancel(); return false; }
 const reader = response.body.getReader(); let length = 0; const chunks: Uint8Array[] = [];
 try { for (;;) { const item = await reader.read(); if (item.done) { break; } length += item.value.length; if (length > 16384) { return false; } chunks.push(item.value); }
  const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { _tag?: unknown; message?: unknown };
  return raw._tag === 'ServiceUnavailableError' && raw.message === 'Location plugins did not finish activating';
 } catch { return false; } finally { await reader.cancel().catch(() => {}); }
}
