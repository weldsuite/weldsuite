/**
 * An approval raised in a WeldChat room: the person who asked decides it from
 * the room, the room's reply learns the decision, and the outcome is posted in
 * words, not tool names (pglite).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { schema } from '@weldsuite/worker-kit/db';
import { createAgent } from '@weldsuite/agent-domain/agents';
import { createApproval, getApproval } from '@weldsuite/agent-domain/parity';
import { weldagentRoutes } from '../../routes/weldagent/index';

const ASKER = 'user_asker';
const OWNER = 'user_owner';

describe('approvals raised in a room', () => {
  let db: Awaited<ReturnType<typeof createPgliteDb>>['db'];
  let agentId: string;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    const agent = await createAgent(db, {
      name: 'Room helper',
      createdBy: OWNER,
      permissions: ['tasks:create', 'people:create'],
    });
    agentId = agent.id;
    await db.insert(schema.chatChannels).values({ id: 'chan_apr', name: 'ops', slug: 'ops-apr', type: 'private' });
    await db.insert(schema.chatChannelMembers).values([
      { id: 'cmb_asker', channelId: 'chan_apr', userId: ASKER, role: 'member' },
      { id: 'cmb_agent', channelId: 'chan_apr', userId: agentId, memberType: 'agent', role: 'member' },
    ]);
  }, 120_000);

  /** The agent's room reply carrying one parked action, as the dispatch posts it. */
  async function parkedAction(toolName: string, args: Record<string, unknown>, label: string) {
    const approval = await createApproval(db, {
      agentId,
      conversationId: 'chan_apr',
      toolName,
      args,
      riskLevel: 'high',
      createdBy: ASKER,
    });
    const messageId = `msg_${approval.id}`;
    await db.insert(schema.chatMessages).values({
      id: messageId,
      channelId: 'chan_apr',
      authorId: agentId,
      authorName: 'Room helper',
      authorType: 'agent',
      content: 'This needs your approval before I can do it.',
      metadata: { approvals: [{ id: approval.id, label, status: 'pending' }] },
    });
    return { approval, messageId };
  }

  /** The asker, who holds weldagent:use only (not the owner, not a manager). */
  function asAsker() {
    return createTestApp('/api/weldagent', weldagentRoutes, {
      context: { permissions: permissions('weldagent:use', 'weldagent:read', 'tasks:create'), tenantDb: db, userId: ASKER },
    });
  }

  const decide = (request: ReturnType<typeof asAsker>['request'], id: string, decision: 'approved' | 'rejected') =>
    request(`/api/weldagent/approvals/${id}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    });

  const messageMetadata = async (id: string) =>
    (await db.select({ metadata: schema.chatMessages.metadata }).from(schema.chatMessages).where(eq(schema.chatMessages.id, id)))[0]
      .metadata as { approvals: Array<{ id: string; status: string }> };

  const outcomes = async () =>
    (await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.authorId, agentId))).map((m) => m.content);

  it('lets the person who asked approve from the room: the action runs, the reply updates, the outcome is in words', async () => {
    const { approval, messageId } = await parkedAction('create_task', { title: 'QA agent chat task' }, 'Create task "QA agent chat task"');
    const { request } = asAsker();

    const res = await decide(request, approval.id, 'approved');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; execution: { ran: boolean; ok: boolean } } };
    expect(body.data).toMatchObject({ status: 'approved', execution: { ran: true, ok: true } });

    // The task exists and carries who is responsible for it.
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.title, 'QA agent chat task'));
    expect(task).toBeDefined();
    expect(task.reporterId).toBe(ASKER);

    // The reply that carried the buttons now says what happened to that approval.
    expect((await messageMetadata(messageId)).approvals).toEqual([
      { id: approval.id, label: 'Create task "QA agent chat task"', status: 'approved' },
    ]);
    expect(await outcomes()).toContain('Approved — created the task "QA agent chat task".');
    expect((await getApproval(db, approval.id))?.status).toBe('approved');
  });

  it('lets them reject it too: nothing runs and the room is told in words', async () => {
    const { approval, messageId } = await parkedAction('create_person', { firstName: 'QA Agent', lastName: 'Testperson' }, 'Create person "QA Agent Testperson"');
    const { request } = asAsker();

    const res = await decide(request, approval.id, 'rejected');
    expect(res.status).toBe(200);
    expect((await messageMetadata(messageId)).approvals[0].status).toBe('rejected');
    expect(await outcomes()).toContain('Rejected — I did not create the person "QA Agent Testperson".');
    expect(await db.select().from(schema.people).where(eq(schema.people.firstName, 'QA Agent'))).toEqual([]);
  });

  it('is decided once: a second click finds nothing pending', async () => {
    const { approval } = await parkedAction('create_task', { title: 'Only once' }, 'Create task "Only once"');
    const { request } = asAsker();
    expect((await decide(request, approval.id, 'approved')).status).toBe(200);
    expect((await decide(request, approval.id, 'approved')).status).toBe(404);
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.title, 'Only once'))).toHaveLength(1);
  });

  it('does not let a bystander decide it', async () => {
    const { approval } = await parkedAction('create_task', { title: 'Not yours' }, 'Create task "Not yours"');
    const { request } = createTestApp('/api/weldagent', weldagentRoutes, {
      context: { permissions: permissions('weldagent:use', 'weldagent:read'), tenantDb: db, userId: 'user_bystander' },
    });
    expect((await decide(request, approval.id, 'approved')).status).toBe(403);
    expect((await getApproval(db, approval.id))?.status).toBe('pending');
  });
});
