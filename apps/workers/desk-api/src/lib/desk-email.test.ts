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
import { MAX_EMAIL_ATTACHMENT_BYTES, sendDeskEmailReply } from './desk-email';
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

describe('sendDeskEmailReply attachments', () => {
  const publicUrl = 'https://files.test';
  const file = (name: string, size = 100) => ({
    name,
    url: `${publicUrl}/desk/ws_1/dconv_1/${name}`,
    contentType: 'application/pdf',
    filesize: size,
  });
  const bucket = (objects: Record<string, number>) =>
    ({
      get: vi.fn(async (key: string) =>
        key in objects ? { size: objects[key], arrayBuffer: async () => new ArrayBuffer(objects[key]!) } : null,
      ),
    }) as unknown as R2Bucket;
  const withFiles = (attachments: unknown[]) => ({ ...message, attachments }) as unknown as DeskMessage;
  const envWith = (extra: Record<string, unknown>) => ({ ...env, ...extra }) as unknown as Env;

  it('attaches files read from STORAGE as real MIME attachments', async () => {
    const storage = bucket({ 'desk/ws_1/dconv_1/invoice.pdf': 2000 });

    await sendDeskEmailReply(
      envWith({ STORAGE: storage, R2_PUBLIC_URL: `${publicUrl}/` }),
      db,
      conversation,
      withFiles([file('invoice.pdf', 2000)]),
      outbound,
    );

    expect(send).toHaveBeenCalledTimes(1);
    const params = send.mock.calls[0]![1];
    expect(params.attachments).toHaveLength(1);
    expect(params.attachments![0]).toMatchObject({ filename: 'invoice.pdf', contentType: 'application/pdf' });
    expect(params.text).toBe('Have you tried turning it off?');
    // The guard screens the file names and types, not the bytes.
    expect(guard.mock.calls[0]![2].attachments).toEqual([{ filename: 'invoice.pdf', contentType: 'application/pdf' }]);
  });

  it('falls back to links over the size cap and when the object is not in the bucket', async () => {
    const files = [file('big.pdf', MAX_EMAIL_ATTACHMENT_BYTES + 1), file('gone.pdf', 10), file('ok.pdf', 10)];
    const storage = bucket({ 'desk/ws_1/dconv_1/ok.pdf': 10 });

    await sendDeskEmailReply(
      envWith({ STORAGE: storage, R2_PUBLIC_URL: publicUrl }),
      db,
      conversation,
      withFiles(files),
      outbound,
    );

    const params = send.mock.calls[0]![1];
    expect(params.attachments?.map((a) => a.filename)).toEqual(['ok.pdf']);
    expect(params.text).toContain('Attachments:');
    expect(params.text).toContain(`- big.pdf: ${publicUrl}/desk/ws_1/dconv_1/big.pdf`);
    expect(params.text).toContain(`- gone.pdf: ${publicUrl}/desk/ws_1/dconv_1/gone.pdf`);
    expect(params.text).not.toContain('ok.pdf:');
    // The big file is never read.
    expect(storage.get).not.toHaveBeenCalledWith('desk/ws_1/dconv_1/big.pdf');
  });

  it('keeps total attached size under the cap, linking the file that would overflow it', async () => {
    const half = MAX_EMAIL_ATTACHMENT_BYTES / 2 + 1;
    const storage = bucket({ 'desk/ws_1/dconv_1/a.pdf': half, 'desk/ws_1/dconv_1/b.pdf': half });

    await sendDeskEmailReply(
      envWith({ STORAGE: storage, R2_PUBLIC_URL: publicUrl }),
      db,
      conversation,
      withFiles([file('a.pdf', half), file('b.pdf', half)]),
      outbound,
    );

    const params = send.mock.calls[0]![1];
    expect(params.attachments?.map((a) => a.filename)).toEqual(['a.pdf']);
    expect(params.text).toContain('- b.pdf:');
  });

  it('links a file that is not under our bucket instead of reading it', async () => {
    const stray = { name: 'x.pdf', url: 'https://evil.test/x.pdf', contentType: 'application/pdf', filesize: 1 };
    const storage = bucket({});

    await sendDeskEmailReply(
      envWith({ STORAGE: storage, R2_PUBLIC_URL: publicUrl }),
      db,
      conversation,
      withFiles([stray]),
      outbound,
    );

    expect(storage.get).not.toHaveBeenCalled();
    expect(send.mock.calls[0]![1].text).toContain('- x.pdf: https://evil.test/x.pdf');
  });

  it('sends an attachment-only reply, and links without STORAGE', async () => {
    const onlyFile = { ...message, body: null, attachments: [file('scan.pdf')] } as unknown as DeskMessage;

    await sendDeskEmailReply(envWith({ R2_PUBLIC_URL: publicUrl }), db, conversation, onlyFile, outbound);

    const params = send.mock.calls[0]![1];
    expect(params.attachments).toBeUndefined();
    expect(params.text).toBe(`Attachments:\n- scan.pdf: ${publicUrl}/desk/ws_1/dconv_1/scan.pdf`);
  });

  it('names attached files when a reply has no text at all', async () => {
    const onlyFile = { ...message, body: '', attachments: [file('scan.pdf', 5)] } as unknown as DeskMessage;
    const storage = bucket({ 'desk/ws_1/dconv_1/scan.pdf': 5 });

    await sendDeskEmailReply(
      envWith({ STORAGE: storage, R2_PUBLIC_URL: publicUrl }),
      db,
      conversation,
      onlyFile,
      outbound,
    );

    expect(send.mock.calls[0]![1].text).toBe('Attachments: scan.pdf');
  });
});
