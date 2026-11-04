// Third-party extension probe: uses the public Chat / language-model API the way a real extension would and records what it saw.
const vscode = require('vscode');
const fs = require('fs');
exports.activate = async context => {
  const out = { api: {}, behaviour: {}, errors: [] };
  const t = v => typeof v;
  out.api.chat = t(vscode.chat);
  out.api.createChatParticipant = t(vscode.chat && vscode.chat.createChatParticipant);
  out.api.lm = t(vscode.lm);
  out.api.selectChatModels = t(vscode.lm && vscode.lm.selectChatModels);
  out.api.registerTool = t(vscode.lm && vscode.lm.registerTool);
  out.api.tools = Array.isArray(vscode.lm && vscode.lm.tools);
  out.api.ChatRequestTurn = t(vscode.ChatRequestTurn);
  out.api.LanguageModelChatMessage = t(vscode.LanguageModelChatMessage);
  out.api.authentication = t(vscode.authentication && vscode.authentication.getSession);
  try {
    const participant = vscode.chat.createChatParticipant('chat-compat-probe.participant', async () => ({}));
    out.behaviour.participantCreated = !!participant && t(participant.dispose) === 'function';
    participant.dispose();
  } catch (e) { out.errors.push('participant: ' + e.message); }
  try {
    const tool = vscode.lm.registerTool('chat_compat_probe_tool', { invoke: async () => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('ok')]) });
    out.behaviour.toolRegistered = !!tool;
    tool.dispose();
  } catch (e) { out.errors.push('tool: ' + e.message); }
  try { out.behaviour.models = (await vscode.lm.selectChatModels({})).length; } catch (e) { out.errors.push('models: ' + e.message); }
  out.setting = vscode.workspace.getConfiguration('chat').get('disableAIFeatures');
  fs.writeFileSync(process.env.CHAT_COMPAT_OUT, JSON.stringify(out, null, 2));
};
