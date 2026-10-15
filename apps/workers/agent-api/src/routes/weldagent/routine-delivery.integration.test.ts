/**
 * Routine results land in a chat thread for their owner (pglite).
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { createAgent } from '@weldsuite/agent-domain/agents';
import { deliverRoutineResult, ROUTINE_RESULT_KIND } from '@weldsuite/agent-domain/routine-delivery';

const notify = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@weldsuite/notifications', () => ({
  sendWeldAgentReplyNotification: notify,
  sendWeldAgentRunNotification: vi.fn(),
}));

describe('deliverRoutineResult', () => {
  let db: Awaited<ReturnType<typeof createPgliteDb>>['db'];
  let agentId: string;
  const routine = { id: 'rtn_digest', name: 'Morning Task Digest' };

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    const agent = await createAgent(db, { name: 'Digest Bot', systemPrompt: 'Every weekday, send a digest.', createdBy: 'user_1' });
    agentId = agent.id;
  }, 120_000);

  const deliver = (text: string, success = true) =>
    deliverRoutineResult(db, {} as never, {
      workspaceId: 'org_1',
      routine,
      userId: 'user_1',
      agentId,
      runId: 'run_1',
      success,
      text,
      error: success ? undefined : 'Agent is draft',
    });

  it('posts each run into one thread per routine and notifies the owner', async () => {
    const first = await deliver('3 overdue tasks in Website');
    const second = await deliver('All clear today');
    expect(first).toBeTruthy();
    expect(second).toBe(first);

    const [conv] = await db
      .select()
      .from(schema.weldagentConversations)
      .where(eq(schema.weldagentConversations.id, first!));
    expect(conv).toMatchObject({ userId: 'user_1', agentId, name: 'Morning Task Digest' });

    const messages = await db
      .select()
      .from(schema.weldagentMessages)
      .where(and(eq(schema.weldagentMessages.conversationId, first!)));
    expect(messages.map((m) => m.content).sort()).toEqual(['3 overdue tasks in Website', 'All clear today']);
    expect(messages[0].metadata).toMatchObject({ kind: ROUTINE_RESULT_KIND, routineId: routine.id });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1', conversationId: first, agentName: 'Digest Bot' }),
    );
  });

  it('explains a failed run instead of posting nothing', async () => {
    const id = await deliver('', false);
    const messages = await db
      .select()
      .from(schema.weldagentMessages)
      .where(eq(schema.weldagentMessages.conversationId, id!));
    expect(messages.some((m) => m.content.includes('did not finish: Agent is draft'))).toBe(true);
  });

  it('skips system routines with no owner', async () => {
    expect(
      await deliverRoutineResult(db, {} as never, {
        workspaceId: 'org_1',
        routine,
        userId: 'system',
        agentId,
        success: true,
        text: 'x',
      }),
    ).toBeNull();
  });
});
