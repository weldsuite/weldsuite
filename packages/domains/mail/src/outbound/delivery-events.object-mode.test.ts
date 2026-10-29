/**
 * Object-mode test for `markSentCopy`'s store wiring (design task D1):
 * `delivery.match` through a real `ObjectMailboxStore` (the C2 fakes, which
 * run the real `MailboxObject` class underneath), with the same "latest SENT
 * copy, never downgrade a stronger status" semantics `guard.test.ts` pins for
 * the direct-Postgres path.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { generateId } from '@weldsuite/worker-kit/id';
import { markSentCopy, type ParsedSendingEvent } from './delivery-events';
import { ObjectMailboxStore } from '../store/object';
import { createFakeMailboxNamespace } from '../store/object/testing/fake-env';
import type { IngestMessage, MailboxRef } from '../store/types';

const WORKSPACE_ID = 'ws_delivery_object';
const ORG_ID = 'org_delivery_object';

function storeFor(accountId: string): ObjectMailboxStore {
  const mailbox = createFakeMailboxNamespace();
  const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
  return new ObjectMailboxStore({ MAILBOX_STORE: mailbox.namespace, MAIL_STORAGE: createMemoryR2() }, ref);
}

describe('markSentCopy · object mode (store supplied)', () => {
  it('marks the latest SENT copy and never downgrades a stronger status', async () => {
    const accountId = generateId('mail');
    const store = storeFor(accountId);
    const sentAt = new Date('2026-10-13T09:00:00.000Z');
    const messageId = generateId('msg');
    const message: IngestMessage = {
      id: messageId,
      source: 'sent',
      rfcMessageId: `<${messageId}@acme.com>`,
      threadId: null,
      from: { email: 'events@acme.com' },
      to: [{ email: 'Reader@Example.com' }],
      subject: 'Hi',
      preview: null,
      sentAt: sentAt.getTime(),
      receivedAt: null,
      createdAt: sentAt.getTime(),
      isRead: true,
      labels: ['SENT'],
      isSpam: false,
      isReply: false,
      attachments: [],
    };
    await store.apply({ kind: 'ingest', message }, sentAt.getTime());

    const base: Omit<ParsedSendingEvent, 'type'> = {
      sender: 'events@acme.com',
      recipient: 'reader@example.com',
      at: new Date('2026-10-13T09:05:00.000Z'),
      detail: null,
    };
    expect(await markSentCopy({} as never, accountId, { ...base, type: 'complained' }, store)).toBe(true);
    expect(await markSentCopy({} as never, accountId, { ...base, type: 'delivered' }, store)).toBe(false);

    const record = await store.getMessage(messageId);
    expect(record?.deliveryStatus).toBe('complained');
  });

  it('matches nothing when no SENT copy exists for that recipient', async () => {
    const accountId = generateId('mail');
    const store = storeFor(accountId);
    const event: ParsedSendingEvent = {
      sender: 'events@acme.com',
      recipient: 'nobody@example.com',
      at: new Date(),
      type: 'delivered',
      detail: null,
    };
    expect(await markSentCopy({} as never, accountId, event, store)).toBe(false);
  });
});
