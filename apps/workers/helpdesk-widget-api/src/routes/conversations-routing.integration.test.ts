/**
 * Routing rules and team-aware auto-assignment when a visitor starts a
 * conversation, through the whole worker on pglite.
 *
 * A new conversation goes through the workspace's routing rules
 * (`helpdesk_settings.automation.deskRouting`) in the background: the first
 * enabled rule that matches moves the team, priority and tags (an internal,
 * system `attributes_changed` event with `metadata.routingRuleId`) or names an
 * owner; then auto-assignment picks among the team's members when it has any,
 * else the roster (`metadata.teamId` on a team pick). The hub also hears the
 * new conversation and its first message (`desk_conversation created`,
 * `desk_message created`). The worker has no `WORKFLOW_WORKER` binding here,
 * so the pick is the local balanced one.
 *
 * Conformance-ready: the harness records and compares the realtime and
 * entity-event side effects of both backends ("desk: helpdesk widget").
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import * as tenantSchema from '@weldsuite/db/schema';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { WIDGET, addWidget, at, json, member, seedWorkspaces, visitorRow, visitorToken, widgetEnv } from '../test/widget-fixtures';

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
  getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
  getWorkspaceForOrg: async () => ({ id: 'ws_acme' }),
}));

import worker from '../index';

const { deskConversations, deskMessages, deskVisitors, helpdeskDepartments, helpdeskSettings, workspaceMembers } = tenantSchema;

let tenantDb: Database;
let masterDb: Database;

function app() {
  return createTestApp('/', worker as never, {
    context: { tenantDb, masterDb, orgId: null, clerkOrgId: null },
    env: widgetEnv(),
    rustBasePath: '/public/helpdesk-widget',
  });
}

interface Setup {
  mode: 'off' | 'round_robin' | 'balanced';
  rules: tenantSchema.DeskRoutingRule[];
}

async function arrange({ mode, rules }: Setup) {
  // Earlier scenarios' conversations are closed so they count for nobody.
  await tenantDb.update(deskConversations).set({ state: 'closed' });
  await tenantDb.delete(helpdeskSettings);
  await tenantDb.insert(helpdeskSettings).values({
    id: 'hds_routing',
    createdAt: at(0),
    updatedAt: at(0),
    automation: {
      enabled: false,
      deskAssignment: { mode, memberIds: ['user_ann', 'user_bob'], awayMemberIds: [], maxOpenPerMember: null },
      deskRouting: { rules },
    },
  });
}

async function start(visitorId: string): Promise<string> {
  const res = await app().request(
    '/api/conversations',
    json({ body: 'I need help with my order' }, { token: await visitorToken(visitorId) }),
  );
  expect(res.status).toBe(201);
  const { data } = (await res.json()) as { data: { conversation: { id: string } } };
  return data.conversation.id;
}

const events = (conversationId: string) =>
  tenantDb
    .select()
    .from(deskMessages)
    .where(and(eq(deskMessages.conversationId, conversationId), eq(deskMessages.kind, 'event')))
    .orderBy(asc(deskMessages.createdAt), asc(deskMessages.id));

const row = async (id: string) => (await tenantDb.select().from(deskConversations).where(eq(deskConversations.id, id)))[0]!;

/** The background routing landed: `count` timeline events. */
async function settled(id: string, count: number) {
  return vi.waitFor(
    async () => {
      const found = await events(id);
      expect(found).toHaveLength(count);
      return found;
    },
    { timeout: 10_000, interval: 25 },
  );
}

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
  holder.master = masterDb;
  holder.tenant = tenantDb;
  await seedWorkspaces(masterDb);
  await addWidget(masterDb, tenantDb, WIDGET);
  await tenantDb
    .insert(deskVisitors)
    .values([visitorRow('vis_route_team'), visitorRow('vis_route_owner'), visitorRow('vis_route_empty'), visitorRow('vis_route_none')]);
  await tenantDb.insert(workspaceMembers).values([
    member('user_ann', { name: 'Ann Agent' }),
    member('user_bob', { name: 'Bob Builder' }),
    member('user_cy', { name: 'Cy Support' }),
    member('user_dan', { name: 'Dan Desk' }),
  ]);
  await tenantDb.insert(helpdeskDepartments).values([
    { id: 'dep_chat', name: 'Chat team', agentIds: ['user_cy', 'user_dan'], createdAt: at(0), updatedAt: at(0) },
    { id: 'dep_empty', name: 'Nobody yet', agentIds: [], createdAt: at(0), updatedAt: at(0) },
  ]);
}, 120_000);

describe('routing a new widget conversation', () => {
  it('moves it to the matching team and hands it to one of the team', async () => {
    await arrange({
      mode: 'round_robin',
      rules: [
        { id: 'rule_email', name: 'Email', enabled: true, conditions: { channels: ['email'] }, actions: { departmentId: 'dep_empty' } },
        {
          id: 'rule_chat',
          name: 'Chat',
          enabled: true,
          conditions: { channels: ['messenger'] },
          actions: { departmentId: 'dep_chat', priority: 'high', addTags: ['chat'] },
        },
      ],
    });
    const id = await start('vis_route_team');
    const found = await settled(id, 2);
    expect(found[0]).toMatchObject({ authorType: 'system', metadata: { eventType: 'attributes_changed', routingRuleId: 'rule_chat' } });
    expect(found[1]).toMatchObject({
      authorType: 'system',
      metadata: { eventType: 'assigned', assigneeId: 'user_cy', auto: true, teamId: 'dep_chat' },
    });
    expect(await row(id)).toMatchObject({ departmentId: 'dep_chat', priority: 'high', tags: ['chat'], assigneeId: 'user_cy' });
  });

  it('gives it to the teammate a rule names, with auto-assignment off', async () => {
    await arrange({
      mode: 'off',
      rules: [{ id: 'rule_owner', name: 'Owner', enabled: true, conditions: {}, actions: { assigneeId: 'user_bob' } }],
    });
    const id = await start('vis_route_owner');
    const found = await settled(id, 1);
    expect(found[0]).toMatchObject({ metadata: { eventType: 'assigned', assigneeId: 'user_bob', routingRuleId: 'rule_owner' } });
    expect((await row(id)).assigneeId).toBe('user_bob');
  });

  it('lets the roster take a team without members', async () => {
    await arrange({
      mode: 'balanced',
      rules: [{ id: 'rule_empty', name: 'Empty', enabled: true, conditions: {}, actions: { departmentId: 'dep_empty' } }],
    });
    const id = await start('vis_route_empty');
    const found = await settled(id, 2);
    expect(found[1]!.metadata).toEqual({ eventType: 'assigned', assigneeId: 'user_ann', auto: true });
    expect(await row(id)).toMatchObject({ departmentId: 'dep_empty', assigneeId: 'user_ann' });
  });

  it('skips disabled rules', async () => {
    await arrange({
      mode: 'off',
      rules: [{ id: 'rule_off', name: 'Off', enabled: false, conditions: {}, actions: { departmentId: 'dep_chat' } }],
    });
    const id = await start('vis_route_none');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await events(id)).toEqual([]);
    expect(await row(id)).toMatchObject({ departmentId: null, assigneeId: null });
  });
});
