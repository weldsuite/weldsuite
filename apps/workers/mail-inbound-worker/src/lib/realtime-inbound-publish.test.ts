/**
 * Dual-path inbound publish: personal mail:new + hub email:created.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mailEvent = vi.fn();
const personalMailEvent = vi.fn();
const publishEntityEventRaw = vi.fn();

vi.mock('@weldsuite/realtime/server', () => ({
  RealtimePublisher: class {
    mailEvent = mailEvent;
    personalMailEvent = personalMailEvent;
    publish = vi.fn();
    helpdeskEvent = vi.fn();
    conversationPublish = vi.fn();
  },
}));

vi.mock('@weldsuite/entity-events', () => ({
  publishEntityEventRaw: (...args: unknown[]) => publishEntityEventRaw(...args),
}));

import {
  publishInboundEmailCreated,
  publishNewEmailToUser,
  publishNewPersonalEmail,
} from './realtime';

const payload = {
  accountId: 'acc_1',
  messageId: 'msg_1',
  smtpMessageId: '<smtp@example.com>',
  threadId: 'thr_1',
  from: { email: 'a@example.com', name: 'A' },
  subject: 'Hello',
  preview: 'Hi',
  receivedAt: '2026-09-18T00:00:00.000Z',
  isRead: false,
  hasAttachments: false,
};

describe('inbound mail dual-path publish', () => {
  beforeEach(() => {
    mailEvent.mockReset();
    personalMailEvent.mockReset();
    publishEntityEventRaw.mockReset();
    publishEntityEventRaw.mockResolvedValue(undefined);
    mailEvent.mockResolvedValue(undefined);
    personalMailEvent.mockResolvedValue(undefined);
  });

  it('publishNewEmailToUser keeps personal mail:new', async () => {
    const env = { REALTIME: {} } as never;
    await publishNewEmailToUser(env, 'org_1', 'user_1', payload);
    expect(mailEvent).toHaveBeenCalledWith('org_1', 'user_1', 'mail:new', payload);
    expect(publishEntityEventRaw).not.toHaveBeenCalled();
  });

  it('publishInboundEmailCreated enqueues hub email:created once', async () => {
    const env = { ENTITY_EVENTS: { send: vi.fn() } } as never;
    await publishInboundEmailCreated(env, 'org_1', payload);
    expect(publishEntityEventRaw).toHaveBeenCalledTimes(1);
    expect(publishEntityEventRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'org_1',
        userId: 'system',
        entityType: 'email',
        action: 'created',
        entityId: 'msg_1',
        source: 'system',
        data: expect.objectContaining({
          id: 'msg_1',
          accountId: 'acc_1',
          threadId: 'thr_1',
          subject: 'Hello',
          from: 'a@example.com',
        }),
      }),
    );
    expect(mailEvent).not.toHaveBeenCalled();
  });

  it('personal consumer path does not use hub email:created', async () => {
    const env = { REALTIME: {} } as never;
    await publishNewPersonalEmail(env, 'user_personal', payload);
    expect(personalMailEvent).toHaveBeenCalledWith('user_personal', 'mail:new', payload);
    expect(publishEntityEventRaw).not.toHaveBeenCalled();
  });
});
