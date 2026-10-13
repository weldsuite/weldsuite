/**
 * The email branch of WeldDesk's channel dispatch behind the outbound mail
 * guard: an agent reply goes through `guardedSend` as a `desk` reply, and a
 * refusal is logged like any other failed dispatch (best-effort, never thrown;
 * the message is already stored).
 *
 * The guard's own checks are covered in @weldsuite/mail-domain; here it is
 * stubbed at the module boundary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OutboundDeniedError, guardedSend } from '@weldsuite/mail-domain/outbound';
import { sendEmail } from '@weldsuite/worker-email';
import type { Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../../types';
import { dispatchOutbound, type DispatchConversation, type DispatchMessage } from './channel-dispatch';

vi.mock('@weldsuite/worker-email', () => ({ sendEmail: vi.fn() }));
// Keep the real `OutboundDeniedError` (the dispatcher tests for it), stub the guard.
vi.mock('@weldsuite/mail-domain/outbound', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/mail-domain/outbound')>()),
  guardedSend: vi.fn(),
}));

const guard = vi.mocked(guardedSend);
const send = vi.mocked(sendEmail);

const env = { SEND_EMAIL: {} } as unknown as Env;
const outbound = { clerkOrgId: 'org_desk' };

/** Records the two metadata updates dispatchEmail makes after a send. */
function fakeDb() {
  const updates: unknown[] = [];
  const db = {
    update: () => ({
      set: (values: unknown) => {
        updates.push(values);
        return { where: async () => undefined };
      },
    }),
  } as unknown as Database;
  return { db, updates };
}

const conversation: DispatchConversation = {
  id: 'conv_1',
  channel: 'email',
  subject: 'Printer is on fire',
  customerEmail: 'customer@example.org',
  metadata: { helpdeskEmailAddress: 'support@acme.test', lastEmailMessageId: '<abc@example.org>' },
};
const message: DispatchMessage = { id: 'msg_1', content: 'Have you tried turning it off?', authorName: 'Sam' };

beforeEach(() => {
  vi.resetAllMocks();
  send.mockResolvedValue({ messageId: '<reply@acme.test>' });
  // Allowed by default: run the send, like the real guard does.
  guard.mockImplementation(async (_env, _db, _input, run) => run());
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dispatchOutbound (email)', () => {
  it('asks the guard as a desk reply, sends, and records the Message-Id', async () => {
    const { db, updates } = fakeDb();

    await dispatchOutbound(env, db, conversation, message, outbound);

    expect(guard).toHaveBeenCalledTimes(1);
    const [guardEnv, guardDb, input] = guard.mock.calls[0]!;
    expect(guardEnv).toBe(env);
    expect(guardDb).toBe(db);
    expect(input).toMatchObject({
      subject: { kind: 'workspace', clerkOrgId: 'org_desk' },
      source: 'desk',
      kind: 'reply',
      from: '"Sam" <support@acme.test>',
      to: ['customer@example.org'],
      subjectLine: 'Re: Printer is on fire',
      text: 'Have you tried turning it off?',
    });

    expect(send).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        from: '"Sam" <support@acme.test>',
        to: ['customer@example.org'],
        subject: 'Re: Printer is on fire',
        headers: { 'In-Reply-To': '<abc@example.org>' },
      }),
    );
    expect(updates).toHaveLength(2);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('passes waitUntil on so the guard can count the send after the response', async () => {
    const waitUntil = vi.fn();
    await dispatchOutbound(env, fakeDb().db, conversation, message, { clerkOrgId: 'org_desk', waitUntil });
    expect(guard.mock.calls[0]![4]).toEqual({ waitUntil });
  });

  it('logs a refusal as a warning and resolves: nothing sent, nothing recorded, no error log', async () => {
    guard.mockRejectedValueOnce(new OutboundDeniedError({ code: 'SENDING_SUSPENDED' }));
    const { db, updates } = fakeDb();

    await expect(dispatchOutbound(env, db, conversation, message, outbound)).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('SENDING_SUSPENDED'));
    expect(console.error).not.toHaveBeenCalled();
  });

  it('logs any other failure as an error, as before', async () => {
    guard.mockImplementationOnce(async () => {
      throw new Error('send_email failed');
    });
    await expect(dispatchOutbound(env, fakeDb().db, conversation, message, outbound)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith('[ChannelDispatch:Email] Failed to send:', expect.any(Error));
  });

  it('does not ask the guard for internal notes or for channels that are not email', async () => {
    const { db } = fakeDb();
    await dispatchOutbound(env, db, conversation, { ...message, isInternal: true }, outbound);
    await dispatchOutbound(env, db, { ...conversation, channel: 'chat' }, message, outbound);
    expect(guard).not.toHaveBeenCalled();
  });

  it('does not ask the guard when the conversation has no email addresses to use', async () => {
    await dispatchOutbound(env, fakeDb().db, { ...conversation, customerEmail: null }, message, outbound);
    expect(guard).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
