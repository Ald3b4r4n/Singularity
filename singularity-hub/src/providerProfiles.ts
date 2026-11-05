export type OpenCodeProfile = 'normal' | 'isolated';
// Official inline config + documented ordered plugin filters. No files or credentials are copied.
export const ISOLATED_CONFIG = JSON.stringify({ plugins: ['-*', 'opencode.*'] });
export function profileEnvironment(profile: OpenCodeProfile, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
 if (profile === 'normal') { return inherited; }
 if (inherited.OPENCODE_CONFIG_CONTENT?.trim()) { throw new Error('O ambiente já contém configuração inline do OpenCode. O isolamento não pode substituí-la com segurança.'); }
 return { ...inherited, OPENCODE_CONFIG_CONTENT: ISOLATED_CONFIG };
}
