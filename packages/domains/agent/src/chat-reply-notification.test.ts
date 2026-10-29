/**
 * A chat reply notifies ("<agent> replied") only when the person probably left:
 * not for a turn they waited for in the chat.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const replied = vi.hoisted(() => vi.fn(async (_params: unknown) => 'notif_1'));
vi.mock('@weldsuite/notifications', () => ({
  sendWeldAgentReplyNotification: replied,
  sendWeldAgentRunNotification: vi.fn(),
}));

const { INTERACTIVE_REPLY_WINDOW_MS, finishAcceptedTurn, shouldNotifyChatReply } = await import('./complete-turn');

describe('shouldNotifyChatReply', () => {
  it('stays quiet for a reply the person waited for, and speaks up for a long one', () => {
    expect(shouldNotifyChatReply({ elapsedMs: 2_000 })).toBe(false);
    expect(shouldNotifyChatReply({ elapsedMs: INTERACTIVE_REPLY_WINDOW_MS - 1 })).toBe(false);
    expect(shouldNotifyChatReply({ elapsedMs: INTERACTIVE_REPLY_WINDOW_MS })).toBe(true);
    expect(shouldNotifyChatReply({ elapsedMs: 5 * 60_000 })).toBe(true);
  });

  it('lets the caller force it either way', () => {
    expect(shouldNotifyChatReply({ notify: true, elapsedMs: 100 })).toBe(true);
    expect(shouldNotifyChatReply({ notify: false, elapsedMs: 10 * 60_000 })).toBe(false);
  });
});

describe('finishAcceptedTurn', () => {
  let db: Database;
  let seq = 0;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 120_000);

  afterEach(() => {
    replied.mockClear();
    vi.useRealTimers();
  });

  async function accepted() {
    seq += 1;
    const conversationId = `conv_notify_${seq}`;
    await db.insert(schema.weldagentConversations).values({ id: conversationId, userId: 'user_1', name: 'Chat' });
    return {
      conversationId,
      userId: 'user_1',
      workspaceId: 'org_1',
      boundAgentId: null,
      userMessage: { id: 'msg_q' } as never,
      chatMessages: [{ role: 'user' as const, content: 'Hello' }],
      historyOffset: 0,
      actorPermissions: null,
    };
  }

  const generate = (delayMs: number) => async () => {
    if (delayMs > 0) vi.setSystemTime(Date.now() + delayMs);
    return { text: "I'm set up as **CRM QA Assistant**", creditsUsed: 1, success: true };
  };

  it('sends no "replied" notification for a quick reply in the chat the person is watching', async () => {
    vi.useFakeTimers();
    const result = await finishAcceptedTurn({ db, env: {} as never, accepted: await accepted(), generate: generate(3_000) });
    expect(result.success).toBe(true);
    expect(replied).not.toHaveBeenCalled();
  });

  it('notifies when the turn took long enough that the person left', async () => {
    vi.useFakeTimers();
    await finishAcceptedTurn({
      db,
      env: {} as never,
      accepted: await accepted(),
      generate: generate(INTERACTIVE_REPLY_WINDOW_MS + 5_000),
    });
    expect(replied).toHaveBeenCalledTimes(1);
    expect(replied.mock.calls[0][0]).toMatchObject({ userId: 'user_1', previewText: "I'm set up as **CRM QA Assistant**" });
  });

  it('notifies a quick reply when the caller asks for it, and never when it says not to', async () => {
    vi.useFakeTimers();
    await finishAcceptedTurn({ db, env: {} as never, accepted: await accepted(), generate: generate(0), notify: true });
    expect(replied).toHaveBeenCalledTimes(1);
    replied.mockClear();
    await finishAcceptedTurn({
      db,
      env: {} as never,
      accepted: await accepted(),
      generate: generate(INTERACTIVE_REPLY_WINDOW_MS * 4),
      notify: false,
    });
    expect(replied).not.toHaveBeenCalled();
  });
});
