import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HubConnection, RpcFailure } from '../client';
import { startInProcess, tempHome, cleanup } from './helpers';

test('profile RPC blocks active work and permits explicit recovery revalidation for a paused team, without inference', async () => {
 const home = tempHome('profile-rpc'), hub = await startInProcess(home), client = await HubConnection.connect({ home, clientName: 'profile-policy-fixture' });
 // Coordinator ports are local fixtures; the real authenticated transport and dispatch guard are exercised.
 const ports = hub.server as unknown as { sessionRequests: number; teams: { active: () => boolean; list: (workspace: string) => Array<{ state: string }> }; comparisons: { active: () => boolean }; opencode: { selectProfile: (...args: unknown[]) => Promise<unknown> } };
 const original = { teamActive: ports.teams.active, teamList: ports.teams.list, comparisonActive: ports.comparisons.active, select: ports.opencode.selectProfile };
 let phase = 'running', changes = 0;
 ports.teams.active = () => true; ports.teams.list = () => [{ state: phase }]; ports.comparisons.active = () => true;
 ports.opencode.selectProfile = async () => { changes++; return { selected: true, profile: 'isolated' }; };
 const choose = () => client.request<{ selected: boolean }>('providers.profile', { id: 'opencode', workspace: home, profile: 'isolated', approved: true });
 try {
  await assert.rejects(choose(), (e: unknown) => e instanceof RpcFailure && e.code === -32006); assert.equal(changes, 0);
  phase = 'paused'; assert.equal((await choose()).selected, true); assert.equal(changes, 1);
  ports.sessionRequests = 1; await assert.rejects(choose(), (e: unknown) => e instanceof RpcFailure && e.code === -32006); assert.equal(changes, 1);
  ports.sessionRequests = 0; ports.teams.active = () => false;
  await assert.rejects(choose(), (e: unknown) => e instanceof RpcFailure && e.code === -32006); assert.equal(changes, 1);
 } finally { ports.sessionRequests = 0; ports.teams.active = original.teamActive; ports.teams.list = original.teamList; ports.comparisons.active = original.comparisonActive; ports.opencode.selectProfile = original.select; client.close(); await hub.release(); cleanup(home); }
});
