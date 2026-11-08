/**
 * Routing when an agent changes a conversation's type or tags (PATCH
 * /api/desk/conversations/:id), on pglite: the workspace's first matching
 * routing rule moves the team, priority and tags (author `system`,
 * `metadata.routingRuleId`), and auto-assignment then picks among the new
 * team's members; a change that set the team itself keeps it. The worker has
 * no HELPDESK_WORKFLOW binding here, so the pick is the local balanced one.
 * Runs against Rust in conformance mode ("desk: webchat and channels").
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createDeskConversation, type DeskMessage } from '@weldsuite/db/lib/desk';
import { generateId } from '@weldsuite/worker-kit/id';
import { deskConversationsRoutes } from './index';

let db: Database;

const patch = (id: string, body: unknown) =>
  createTestApp('/api/desk/conversations', deskConversationsRoutes, {
    context: { permissions: permissions('conversations:update'), tenantDb: db, userId: 'user_agent' },
  }).request(`/api/desk/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface PatchBody {
  data: {
    conversation: { id: string; departmentId: string | null; priority: string | null; tags: string[]; assigneeId: string | null };
    message: DeskMessage | null;
  };
}

const at = new Date(Date.UTC(2026, 2, 1, 9));

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_r_ann', userId: 'user_r_ann', name: 'Ann', status: 'ACTIVE', memberType: 'INTERNAL' },
    { id: 'wm_r_bob', userId: 'user_r_bob', name: 'Bob', status: 'ACTIVE', memberType: 'INTERNAL' },
    { id: 'wm_r_cy', userId: 'user_r_cy', name: 'Cy', status: 'ACTIVE', memberType: 'INTERNAL' },
  ] as Array<typeof schema.workspaceMembers.$inferInsert>);
  await db.insert(schema.helpdeskTicketTypes).values([
    { id: 'tt_r_billing', name: 'Billing', createdAt: at, updatedAt: at, isActive: true },
  ]);
  await db.insert(schema.helpdeskDepartments).values([
    { id: 'dep_r_tier2', name: 'Tier 2', agentIds: ['user_r_cy'], createdAt: at, updatedAt: at, isActive: true },
    { id: 'dep_r_finance', name: 'Finance', agentIds: ['user_r_bob'], createdAt: at, updatedAt: at, isActive: true },
    { id: 'dep_r_sales', name: 'Sales', createdAt: at, updatedAt: at, isActive: true },
  ]);
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.helpdeskSettings);
  await db.insert(schema.helpdeskSettings).values({
    id: 'hds_r',
    createdAt: at,
    updatedAt: at,
    automation: {
      enabled: false,
      deskAssignment: { mode: 'round_robin', memberIds: ['user_r_ann'], awayMemberIds: [], maxOpenPerMember: null },
      deskRouting: {
        rules: [
          { id: 'rule_off', name: 'Off', enabled: false, conditions: { tags: ['vip'] }, actions: { departmentId: 'dep_r_sales' } },
          {
            id: 'rule_vip',
            name: 'VIP',
            enabled: true,
            conditions: { tags: ['VIP'] },
            actions: { departmentId: 'dep_r_tier2', priority: 'high', addTags: ['escalated'] },
          },
          {
            id: 'rule_billing',
            name: 'Billing',
            enabled: true,
            conditions: { ticketTypeIds: ['tt_r_billing'] },
            actions: { departmentId: 'dep_r_finance' },
          },
        ],
      },
    },
  });
});

const start = async (visitorId: string) =>
  (await createDeskConversation(db, { generateId, visitorId, name: 'Rita', body: 'Help' })).conversation;

const timeline = (id: string) =>
  db
    .select()
    .from(schema.deskMessages)
    .where(and(eq(schema.deskMessages.conversationId, id), eq(schema.deskMessages.kind, 'event')))
    .orderBy(asc(schema.deskMessages.createdAt), asc(schema.deskMessages.id));

describe('PATCH /api/desk/conversations/:id · routing', () => {
  it('routes on a new tag: team, priority and tags, then a pick among the team', async () => {
    const conversation = await start('vis_route_vip');
    const res = await patch(conversation.id, { tags: ['vip'] });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as PatchBody;
    expect(data.conversation).toMatchObject({
      departmentId: 'dep_r_tier2',
      priority: 'high',
      tags: ['vip', 'escalated'],
      assigneeId: 'user_r_cy',
    });
    // The agent's own change is the message the route answers with.
    expect(data.message?.metadata).toMatchObject({ eventType: 'attributes_changed', changes: [{ field: 'tags' }] });

    const events = await timeline(conversation.id);
    expect(events.map((e) => [e.authorType, e.metadata?.eventType])).toEqual([
      ['agent', 'attributes_changed'],
      ['system', 'attributes_changed'],
      ['system', 'assigned'],
    ]);
    expect(events[1]!.metadata).toMatchObject({ routingRuleId: 'rule_vip' });
    expect(events[2]!.metadata).toMatchObject({ assigneeId: 'user_r_cy', auto: true, teamId: 'dep_r_tier2' });
  });

  it('keeps a team the change set itself, and still applies the rest', async () => {
    const conversation = await start('vis_route_keep');
    const res = await patch(conversation.id, { tags: ['vip'], departmentId: 'dep_r_sales' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as PatchBody;
    expect(data.conversation).toMatchObject({ departmentId: 'dep_r_sales', priority: 'high' });
    // Sales has no members: the roster takes it.
    expect(data.conversation.assigneeId).toBe('user_r_ann');
  });

  it('routes on a new type', async () => {
    const conversation = await start('vis_route_type');
    const res = await patch(conversation.id, { ticketTypeId: 'tt_r_billing' });
    const { data } = (await res.json()) as PatchBody;
    expect(data.conversation).toMatchObject({ departmentId: 'dep_r_finance', assigneeId: 'user_r_bob' });
  });

  it('does nothing more for a change routing does not look at', async () => {
    const conversation = await start('vis_route_priority');
    const res = await patch(conversation.id, { priority: 'low' });
    const { data } = (await res.json()) as PatchBody;
    expect(data.conversation).toMatchObject({ departmentId: null, priority: 'low', assigneeId: null });
    expect((await timeline(conversation.id)).map((e) => e.metadata?.eventType)).toEqual(['attributes_changed']);
  });

  it("doesn't run the rule that placed it again: the agent's later edits stay", async () => {
    const conversation = await start('vis_route_again');
    await patch(conversation.id, { tags: ['vip'] }); // rule_vip: Tier 2, high, +escalated
    await patch(conversation.id, { priority: 'low' });

    // Removing the tag the rule added edits the tags, but rule_vip already applied.
    const res = await patch(conversation.id, { tags: ['vip'] });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as PatchBody;
    expect(data.conversation).toMatchObject({ tags: ['vip'], priority: 'low', departmentId: 'dep_r_tier2' });
    const routed = (await timeline(conversation.id)).filter((e) => e.metadata?.routingRuleId);
    expect(routed).toHaveLength(1);
  });

  it('never takes a conversation away from its owner', async () => {
    const conversation = await start('vis_route_owned');
    await db.update(schema.deskConversations).set({ assigneeId: 'user_r_ann' }).where(eq(schema.deskConversations.id, conversation.id));
    const res = await patch(conversation.id, { tags: ['vip'] });
    const { data } = (await res.json()) as PatchBody;
    expect(data.conversation).toMatchObject({ departmentId: 'dep_r_tier2', assigneeId: 'user_r_ann' });
  });
});
