/**
 * WeldDesk email replies behind the outbound mail guard: `sendDeskEmailReply`
 * asks the guard as a `desk` reply, stamps the sent Message-Id, and treats a
 * refusal like a failed send: logged, never thrown, the stored reply untouched.
 *
 * The guard's own checks are covered in @weldsuite/mail-domain; here it is
 * stubbed at the module boundary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DeskConversation, DeskMessage } from '@weldsuite/db/lib/desk';
import { OutboundDeniedError, guardedSend } from '@weldsuite/mail-domain/outbound';
import { sendEmail } from '@weldsuite/worker-email';
import { getDeskEmailReplyContext, stampDeskMessageEmailId, type DeskEmailReplyContext } from '@weldsuite/db/lib/desk';
import { sendDeskEmailReply } from './desk-email';
import type { Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';

vi.mock('@weldsuite/worker-email', () => ({ sendEmail: vi.fn() }));
vi.mock('@weldsuite/db/lib/desk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/db/lib/desk')>()),
  getDeskEmailReplyContext: vi.fn(),
  stampDeskMessageEmailId: vi.fn(),
}));
// Keep the real `OutboundDeniedError` (the send path tests for it), stub the guard.
vi.mock('@weldsuite/mail-domain/outbound', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/mail-domain/outbound')>()),
  guardedSend: vi.fn(),
}));

const guard = vi.mocked(guardedSend);
const send = vi.mocked(sendEmail);
const replyContext = vi.mocked(getDeskEmailReplyContext);
const stamp = vi.mocked(stampDeskMessageEmailId);

const env = { SEND_EMAIL: {} } as unknown as Env;
const db = {} as Database;
const outbound = { clerkOrgId: 'org_desk', waitUntil: vi.fn() };

const conversation = { id: 'dconv_1', channel: 'email', email: 'customer@example.org', title: 'Printer' } as DeskConversation;
const message = { id: 'dmsg_1', kind: 'message', body: 'Have you tried turning it off?' } as DeskMessage;

const thread: DeskEmailReplyContext = {
  helpdeskAddress: 'support@acme.test',
  lastEmailMessageId: '<abc@example.org>',
  references: ['<abc@example.org>'],
  subject: 'Printer is on fire',
  customerEmail: 'customer@example.org',
};

beforeEach(() => {
  vi.resetAllMocks();
  replyContext.mockResolvedValue(thread);
  send.mockResolvedValue({ messageId: '<reply@acme.test>' });
  // Allowed by default: run the send, like the real guard does.
  guard.mockImplementation(async (_env, _db, _input, run) => run());
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendDeskEmailReply', () => {
  it('asks the guard as a desk reply, sends in the thread, and stamps the Message-Id', async () => {
    await sendDeskEmailReply(env, db, conversation, message, outbound);

    expect(guard).toHaveBeenCalledTimes(1);
    const [guardEnv, guardDb, input, , opts] = guard.mock.calls[0]!;
    expect(guardEnv).toBe(env);
    expect(guardDb).toBe(db);
    expect(input).toMatchObject({
      subject: { kind: 'workspace', clerkOrgId: 'org_desk' },
      source: 'desk',
      kind: 'reply',
      from: 'support@acme.test',
      to: ['customer@example.org'],
      subjectLine: 'Re: Printer is on fire',
      text: 'Have you tried turning it off?',
    });
    expect(opts).toEqual({ waitUntil: outbound.waitUntil });

    expect(send).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        from: 'support@acme.test',
        to: ['customer@example.org'],
        subject: 'Re: Printer is on fire',
        inReplyTo: '<abc@example.org>',
        references: ['<abc@example.org>'],
      }),
    );
    expect(stamp).toHaveBeenCalledWith(db, 'dmsg_1', '<reply@acme.test>');
  });

  it('logs a refusal and resolves: nothing sent, nothing stamped', async () => {
    guard.mockRejectedValueOnce(new OutboundDeniedError({ code: 'SENDER_NOT_OWNED', reason: 'address_registered_elsewhere' }));

    await expect(sendDeskEmailReply(env, db, conversation, message, outbound)).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(stamp).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('SENDER_NOT_OWNED'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('dconv_1'));
  });

  it('still throws any other send failure, for the route to log', async () => {
    guard.mockImplementationOnce(async () => {
      throw new Error('send_email failed');
    });
    await expect(sendDeskEmailReply(env, db, conversation, message, outbound)).rejects.toThrow('send_email failed');
    expect(stamp).not.toHaveBeenCalled();
  });

  it.each([
    ['a conversation on another channel', { ...conversation, channel: 'chat' }, message],
    ['an internal note', conversation, { ...message, kind: 'note' }],
    ['a reply with no body', conversation, { ...message, body: '  ' }],
    ['a conversation without a customer address', { ...conversation, email: null }, message],
  ])('does not touch the guard for %s', async (_label, conv, msg) => {
    await sendDeskEmailReply(env, db, conv as DeskConversation, msg as DeskMessage, outbound);
    expect(guard).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('skips the guard when the thread has no helpdesk address to send from', async () => {
    replyContext.mockResolvedValueOnce({ ...thread, helpdeskAddress: null });
    await sendDeskEmailReply(env, db, conversation, message, outbound);
    expect(guard).not.toHaveBeenCalled();
  });
});
