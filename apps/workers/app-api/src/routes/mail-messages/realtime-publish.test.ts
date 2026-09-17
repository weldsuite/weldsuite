/**
 * Ensures WeldMail mutation routes that move/update messages fan out
 * `email` entity events for live cross-screen sync.
 */
import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import { mailMessagesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';

vi.mock('../../services/mail/access', () => ({
  checkAccountAccess: vi.fn(),
  isAdminOrOwner: vi.fn(),
  userAccessCondition: vi.fn(() => ({ _tag: 'sql' })),
  hasAccessToAccount: vi.fn(),
}));

vi.mock('../../services/mail/messages', () => ({
  getMessageAccountId: vi.fn(),
  getMessage: vi.fn(),
  getThread: vi.fn(),
  listMessages: vi.fn(),
  getMessageStats: vi.fn(),
  updateMessage: vi.fn(),
  softDeleteMessage: vi.fn(),
  bulkUpdateMessages: vi.fn(),
  addMessageLabels: vi.fn(),
  removeMessageLabels: vi.fn(),
}));

vi.mock('../../services/mail/send', () => ({
  replyAndPersist: vi.fn(),
  forwardAndPersist: vi.fn(),
  MailSendError: class MailSendError extends Error {
    constructor(
      public readonly code: string,
      public readonly message: string,
      public readonly details?: unknown,
    ) {
      super(message);
    }
  },
}));

vi.mock('../../db', () => ({
  schema: {
    mailAccounts: {
      id: 'id',
      isShared: 'isShared',
      assignedUserIds: 'assignedUserIds',
      deletedAt: 'deletedAt',
    },
    mailMessages: {
      id: 'id',
      accountId: 'accountId',
      deletedAt: 'deletedAt',
    },
  },
}));

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

import * as access from '../../services/mail/access';
import * as msgs from '../../services/mail/messages';
import { publishEntityEvent } from '@weldsuite/entity-events';

const checkAccountAccess = access.checkAccountAccess as MockedFunction<
  typeof access.checkAccountAccess
>;
const isAdminOrOwner = access.isAdminOrOwner as MockedFunction<typeof access.isAdminOrOwner>;
const getMessageAccountId = msgs.getMessageAccountId as MockedFunction<
  typeof msgs.getMessageAccountId
>;
const bulkUpdateMessages = msgs.bulkUpdateMessages as MockedFunction<
  typeof msgs.bulkUpdateMessages
>;
const addMessageLabels = msgs.addMessageLabels as MockedFunction<typeof msgs.addMessageLabels>;
const removeMessageLabels = msgs.removeMessageLabels as MockedFunction<
  typeof msgs.removeMessageLabels
>;
const mockedPublish = publishEntityEvent as ReturnType<typeof vi.fn>;

const ACCOUNT_ID = 'acc_1';
const MESSAGE_ID = 'msg_001';
const USER_ID = 'user_1';

function makeApp() {
  return createTestApp('/api/mail-messages', mailMessagesRoutes, {
    context: {
      userId: USER_ID,
      permissions: permissions('messages:read', 'messages:update', 'messages:delete'),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mail-messages realtime publish', () => {
  it('publishes email:updated on bulk actions', async () => {
    isAdminOrOwner.mockResolvedValueOnce(true);
    getMessageAccountId.mockResolvedValueOnce(ACCOUNT_ID);
    bulkUpdateMessages.mockResolvedValueOnce({ affected: 2 });

    const { request } = makeApp();
    const res = await request('/api/mail-messages/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageIds: [MESSAGE_ID, 'msg_002'],
        action: 'trash',
      }),
    });

    expect(res.status).toBe(200);
    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'email',
        entityId: MESSAGE_ID,
        action: 'updated',
        data: expect.objectContaining({
          id: MESSAGE_ID,
          accountId: ACCOUNT_ID,
        }),
      }),
    );
  });

  it('publishes email:deleted on bulk delete', async () => {
    isAdminOrOwner.mockResolvedValueOnce(true);
    getMessageAccountId.mockResolvedValueOnce(ACCOUNT_ID);
    bulkUpdateMessages.mockResolvedValueOnce({ affected: 1 });

    const { request } = makeApp();
    const res = await request('/api/mail-messages/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIds: [MESSAGE_ID], action: 'delete' }),
    });

    expect(res.status).toBe(200);
    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'email',
        action: 'deleted',
      }),
    );
  });

  it('publishes email:updated on label add/remove', async () => {
    getMessageAccountId.mockResolvedValue(ACCOUNT_ID);
    checkAccountAccess.mockResolvedValue(true);
    addMessageLabels.mockResolvedValueOnce(['INBOX', 'STARRED']);
    removeMessageLabels.mockResolvedValueOnce(['INBOX']);

    const { request } = makeApp();

    const addRes = await request(`/api/mail-messages/${MESSAGE_ID}/labels/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: ['STARRED'] }),
    });
    expect(addRes.status).toBe(200);
    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'email',
        entityId: MESSAGE_ID,
        action: 'updated',
      }),
    );

    mockedPublish.mockClear();

    const removeRes = await request(`/api/mail-messages/${MESSAGE_ID}/labels/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: ['STARRED'] }),
    });
    expect(removeRes.status).toBe(200);
    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'email',
        entityId: MESSAGE_ID,
        action: 'updated',
      }),
    );
  });
});
