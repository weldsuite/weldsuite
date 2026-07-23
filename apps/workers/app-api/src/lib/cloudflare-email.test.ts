/**
 * Unit coverage for the REAL (non-dry-run) outbound transmit wiring.
 *
 * `cfEmail.sendEmail` is everything WeldSuite owns on the send path: it fans a
 * single envelope out to one `EmailMessage` per recipient (the Cloudflare
 * `send_email` binding takes one recipient at a time, so to/cc/bcc are expanded
 * here), parses the `from` header, builds the RFC-5322 message, and hands each
 * one to the binding. The ONLY thing stubbed here is Cloudflare's actual
 * transport (`SEND_EMAIL.send`) — which isn't our code and can't run off-edge.
 *
 * This is the layer the `dryRun` flag short-circuits, so it gets its own test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `cloudflare:email` is a Workers runtime module; provide a fake EmailMessage
// that records the (from, to, raw) it was constructed with so we can assert the
// fan-out. Hoisted by vitest above the import below.
vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(
      public readonly from: string,
      public readonly to: string,
      public readonly raw: string,
    ) {}
  },
}));

import { sendEmail } from './cloudflare-email';
import type { Env } from '../types';

/** Build an Env whose SEND_EMAIL binding is a spy. */
function envWithSpy(send = vi.fn().mockResolvedValue(undefined)) {
  return { env: { SEND_EMAIL: { send } } as unknown as Env, send };
}

const FROM = 'Sales Team <sales@acme.test>';

beforeEach(() => vi.clearAllMocks());

describe('cfEmail.sendEmail — real transmit wiring', () => {
  it('fans out one EmailMessage per to / cc / bcc recipient', async () => {
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

    // 2 to + 1 cc + 1 bcc = 4 individual envelopes.
    expect(send).toHaveBeenCalledTimes(4);
    const recipients = send.mock.calls.map((c) => (c[0] as { to: string }).to);
    expect(recipients.sort()).toEqual(['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test']);

    // Every envelope carries the parsed From and a non-empty RFC-5322 payload.
    for (const call of send.mock.calls) {
      const msg = call[0] as { from: string; raw: string };
      expect(msg.from).toContain('sales@acme.test');
      expect(msg.raw.length).toBeGreaterThan(0);
    }

    expect(result.messageId).toBeTruthy();
    expect(result.pendingVerification).toBe(false);
  });

  it('sends a single envelope for a lone recipient', async () => {
    const { env, send } = envWithSpy();
    await sendEmail(env, { from: FROM, to: ['solo@x.test'], subject: 'Hi', text: 'hi' });
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0][0] as { to: string }).to).toBe('solo@x.test');
  });

  it('embeds threading headers (In-Reply-To / References) into the message', async () => {
    const { env, send } = envWithSpy();
    await sendEmail(env, {
      from: FROM,
      to: ['a@x.test'],
      subject: 'Re: Thread',
      text: 'reply',
      headers: { 'In-Reply-To': '<parent@x.test>', References: '<root@x.test> <parent@x.test>' },
    });
    const raw = (send.mock.calls[0][0] as { raw: string }).raw;
    expect(raw).toContain('<parent@x.test>');
    expect(raw).toContain('<root@x.test>');
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
