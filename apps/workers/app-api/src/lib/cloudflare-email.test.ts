/**
 * Unit coverage for the REAL (non-dry-run) outbound transmit wiring.
 *
 * `cfEmail.sendEmail` is everything WeldSuite owns on the send path: it parses
 * the `from` header and hands the whole recipient set to the Cloudflare
 * `send_email` binding in ONE structured call. That single call is what makes a
 * multi-recipient send arrive as one message addressed to the group — building
 * a raw message per recipient instead turns a three-way reply-all into three
 * separate one-to-one messages. The ONLY thing stubbed here is Cloudflare's
 * actual transport (`SEND_EMAIL.send`), which isn't our code and can't run
 * off-edge.
 *
 * This is the layer the `dryRun` flag short-circuits, so it gets its own test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { sendEmail } from './cloudflare-email';
import type { Env } from '../types';

/** The structured request shape the binding receives. */
interface SentRequest {
  from: { email: string; name?: string };
  to: { email: string }[];
  cc?: { email: string }[];
  bcc?: { email: string }[];
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; type: string; disposition: string; contentId?: string }[];
}

/** Build an Env whose SEND_EMAIL binding is a spy. */
function envWithSpy(send = vi.fn().mockResolvedValue({ messageId: '<generated@cf.test>' })) {
  return { env: { SEND_EMAIL: { send } } as unknown as Env, send };
}

const FROM = 'Sales Team <sales@acme.test>';

beforeEach(() => vi.clearAllMocks());

describe('cfEmail.sendEmail — real transmit wiring', () => {
  it('sends ONE message carrying every to / cc / bcc recipient', async () => {
    const { env, send } = envWithSpy();

    const result = await sendEmail(env, {
      from: FROM,
      to: ['a@x.test', 'b@x.test'],
      cc: ['c@x.test'],
      bcc: ['d@x.test'],
      subject: 'Hello',
      text: 'plain body',
      html: '<p>rich body</p>',
    });

    // A single binding call — not one per recipient.
    expect(send).toHaveBeenCalledTimes(1);

    const req = send.mock.calls[0][0] as SentRequest;
    expect(req.to.map((a) => a.email)).toEqual(['a@x.test', 'b@x.test']);
    expect(req.cc?.map((a) => a.email)).toEqual(['c@x.test']);
    expect(req.bcc?.map((a) => a.email)).toEqual(['d@x.test']);
    expect(req.from).toEqual({ email: 'sales@acme.test', name: 'Sales Team' });
    expect(req.subject).toBe('Hello');
    expect(req.text).toBe('plain body');
    expect(req.html).toBe('<p>rich body</p>');

    // Cloudflare owns the Message-ID and returns it; we persist what it gives us.
    expect(result.messageId).toBe('<generated@cf.test>');
    expect(result.pendingVerification).toBe(false);
  });

  it('omits cc / bcc entirely when there are none', async () => {
    const { env, send } = envWithSpy();
    await sendEmail(env, { from: FROM, to: ['solo@x.test'], subject: 'Hi', text: 'hi' });

    const req = send.mock.calls[0][0] as SentRequest;
    expect(req.to.map((a) => a.email)).toEqual(['solo@x.test']);
    expect(req.cc).toBeUndefined();
    expect(req.bcc).toBeUndefined();
  });

  it('parses a bare from address with no display name', async () => {
    const { env, send } = envWithSpy();
    await sendEmail(env, { from: 'sales@acme.test', to: ['a@x.test'], subject: 'Hi', text: 'hi' });

    const req = send.mock.calls[0][0] as SentRequest;
    expect(req.from).toEqual({ email: 'sales@acme.test' });
  });

  it('passes threading headers (In-Reply-To / References) through to the binding', async () => {
    const { env, send } = envWithSpy();
    await sendEmail(env, {
      from: FROM,
      to: ['a@x.test'],
      subject: 'Re: Thread',
      text: 'reply',
      headers: { 'In-Reply-To': '<parent@x.test>', References: '<root@x.test> <parent@x.test>' },
    });

    const req = send.mock.calls[0][0] as SentRequest;
    expect(req.headers).toMatchObject({
      'In-Reply-To': '<parent@x.test>',
      References: '<root@x.test> <parent@x.test>',
    });
  });

  it('maps attachments to the binding shape, marking cid parts inline', async () => {
    const { env, send } = envWithSpy();
    await sendEmail(env, {
      from: FROM,
      to: ['a@x.test'],
      subject: 'With files',
      text: 'see attached',
      attachments: [
        { filename: 'report.pdf', contentType: 'application/pdf', content: new ArrayBuffer(4) },
        { filename: 'logo.png', contentType: 'image/png', content: new ArrayBuffer(4), cid: 'logo1' },
      ],
    });

    const req = send.mock.calls[0][0] as SentRequest;
    expect(req.attachments).toMatchObject([
      { filename: 'report.pdf', type: 'application/pdf', disposition: 'attachment' },
      { filename: 'logo.png', type: 'image/png', disposition: 'inline', contentId: 'logo1' },
    ]);
  });

  it('rejects a send that exceeds the binding recipient cap', async () => {
    const { env, send } = envWithSpy();
    const many = Array.from({ length: 51 }, (_, i) => `r${i}@x.test`);

    await expect(
      sendEmail(env, { from: FROM, to: many, subject: 's', text: 'x' }),
    ).rejects.toThrow(/at most 50/i);
    expect(send).not.toHaveBeenCalled();
  });

  it('throws when there are no recipients at all', async () => {
    const { env } = envWithSpy();
    await expect(sendEmail(env, { from: FROM, to: [], subject: 's' })).rejects.toThrow(/no recipients/i);
  });

  it('throws when the SEND_EMAIL binding is missing', async () => {
    const env = {} as unknown as Env;
    await expect(
      sendEmail(env, { from: FROM, to: ['a@x.test'], subject: 's' }),
    ).rejects.toThrow(/SEND_EMAIL binding missing/i);
  });

  it('surfaces a transport failure from the binding (unverified recipient, etc.)', async () => {
    const send = vi.fn().mockRejectedValue(new Error('550 recipient not verified'));
    const env = { SEND_EMAIL: { send } } as unknown as Env;
    await expect(
      sendEmail(env, { from: FROM, to: ['a@x.test'], subject: 's', text: 'x' }),
    ).rejects.toThrow(/send_email failed/i);
  });
});
