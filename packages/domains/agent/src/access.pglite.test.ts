/**
 * `memberCanUseAgent` against a real tenant schema (pglite): what an assigned
 * issue's run is checked against. The member must be an active member holding
 * `weldagent:use` (denies win), and reach the agent by its visibility.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { memberCanUseAgent } from './access';

let db: Database;

const agent = (id: string, visibility: string, ownerId: string | null = 'user_owner') => ({ id, ownerId, visibility });

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_owner', userId: 'user_owner', email: 'owner@example.com', role: 'MEMBER' },
    { id: 'wm_member', userId: 'user_member', email: 'member@example.com', role: 'MEMBER' },
    { id: 'wm_listed', userId: 'user_listed', email: 'listed@example.com', role: 'MEMBER' },
    { id: 'wm_admin', userId: 'user_admin', email: 'admin@example.com', role: 'ADMIN' },
    { id: 'wm_viewer', userId: 'user_viewer', email: 'viewer@example.com', role: 'VIEWER' },
    { id: 'wm_denied', userId: 'user_denied', email: 'denied@example.com', role: 'MEMBER', permissionDenies: ['weldagent:use'] },
    { id: 'wm_gone', userId: 'user_gone', email: 'gone@example.com', role: 'MEMBER', status: 'SUSPENDED' },
  ]);
  await db.insert(schema.weldagentAgentMembers).values({ id: 'agm_1', agentId: 'agt_members', userId: 'user_listed' });
}, 120_000);

describe('memberCanUseAgent', () => {
  it('lets a member use a workspace agent, their own, and a members agent they are listed on', async () => {
    expect(await memberCanUseAgent(db, agent('agt_ws', 'workspace'), 'user_member')).toBe(true);
    expect(await memberCanUseAgent(db, agent('agt_private', 'private'), 'user_owner')).toBe(true);
    expect(await memberCanUseAgent(db, agent('agt_members', 'members'), 'user_listed')).toBe(true);
  });

  it('refuses a private or members agent the member does not reach', async () => {
    expect(await memberCanUseAgent(db, agent('agt_private', 'private'), 'user_member')).toBe(false);
    expect(await memberCanUseAgent(db, agent('agt_members', 'members'), 'user_member')).toBe(false);
  });

  it('lets a holder of weldagent:manage use every agent', async () => {
    expect(await memberCanUseAgent(db, agent('agt_private', 'private'), 'user_admin')).toBe(true);
  });

  it('refuses without weldagent:use, a deny on it, a suspended member or no member at all', async () => {
    expect(await memberCanUseAgent(db, agent('agt_ws', 'workspace'), 'user_viewer')).toBe(false);
    expect(await memberCanUseAgent(db, agent('agt_ws', 'workspace'), 'user_denied')).toBe(false);
    expect(await memberCanUseAgent(db, agent('agt_ws', 'workspace'), 'user_gone')).toBe(false);
    expect(await memberCanUseAgent(db, agent('agt_ws', 'workspace'), 'user_nobody')).toBe(false);
    expect(await memberCanUseAgent(db, agent('agt_ws', 'workspace'), '')).toBe(false);
    expect(await memberCanUseAgent(db, agent('agt_ws', 'workspace'), 'system')).toBe(false);
  });
});
