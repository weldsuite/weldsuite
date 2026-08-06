/**
 * Unit coverage for the REAL (non-dry-run) outbound transmit wiring.
 *
 * `cfEmail.sendEmail` is everything WeldSuite owns on the send path: it parses
 * the `from` header, builds ONE RFC-5322 payload, and hands that same payload
 * to the Cloudflare `send_email` binding once per envelope recipient (the
 * binding takes one at a time). Sharing the payload is the point — one
 * Message-ID and one set of To/Cc headers, so a three-way reply-all arrives as
 * a single message addressed to the group instead of three private ones. The
 * ONLY thing stubbed here is Cloudflare's actual transport (`SEND_EMAIL.send`),
 * which isn't our code and can't run off-edge.
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

/** The (from, to, raw) triples the binding was handed. */
function envelopes(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls.map((c) => c[0] as { from: string; to: string; raw: string });
}

beforeEach(() => vi.clearAllMocks());

describe('cfEmail.sendEmail — real transmit wiring', () => {
  it('fans out one envelope per to / cc / bcc recipient', async () => {
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
    expect(envelopes(send).map((e) => e.to).sort()).toEqual([
      'a@x.test',
      'b@x.test',
      'c@x.test',
      'd@x.test',
    ]);

    for (const e of envelopes(send)) {
      expect(e.from).toContain('sales@acme.test');
      expect(e.raw.length).toBeGreaterThan(0);
    }

    expect(result.messageId).toBeTruthy();
    expect(result.pendingVerification).toBe(false);
  });

  it('sends ONE message to everybody, not one private message each', async () => {
    const { env, send } = envWithSpy();

    await sendEmail(env, {
      from: FROM,
      to: ['a@x.test', 'b@x.test'],
      cc: ['c@x.test'],
      subject: 'Hello',
      text: 'plain body',
    });

    const raws = envelopes(send).map((e) => e.raw);

    // Identical payload per envelope — same Message-ID, so mail clients treat
    // the copies as one message rather than three separate ones.
    expect(new Set(raws).size).toBe(1);

    // ...and its headers name the whole group, so recipients can reply-all.
    // Long header values are line-folded, so unfold before matching.
    const unfolded = raws[0]!.replace(/\r?\n[ \t]+/g, ' ');
    const to = unfolded.match(/^To:.*$/m)?.[0] ?? '';
    const cc = unfolded.match(/^Cc:.*$/m)?.[0] ?? '';
    expect(to).toContain('a@x.test');
    expect(to).toContain('b@x.test');
    expect(cc).toContain('c@x.test');
  });

  it('gives bcc recipients an envelope but keeps them out of the headers', async () => {
    const { env, send } = envWithSpy();

    await sendEmail(env, {
      from: FROM,
      to: ['a@x.test'],
      bcc: ['secret@x.test'],
      subject: 'Hello',
      text: 'plain body',
    });

    expect(envelopes(send).map((e) => e.to).sort()).toEqual(['a@x.test', 'secret@x.test']);

    // The blind list must not be disclosed to anyone who receives the message.
    for (const e of envelopes(send)) {
      expect(e.raw).not.toMatch(/^Bcc:/m);
      expect(e.raw).not.toContain('secret@x.test');
    }
  });

  it('sends a single envelope for a lone recipient', async () => {
    const { env, send } = envWithSpy();
    await sendEmail(env, { from: FROM, to: ['solo@x.test'], subject: 'Hi', text: 'hi' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(envelopes(send)[0]!.to).toBe('solo@x.test');
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
    const raw = envelopes(send)[0]!.raw;
    expect(raw).toContain('<parent@x.test>');
    expect(raw).toContain('<root@x.test>');
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

  it('surfaces a transport failure from the binding', async () => {
    const send = vi.fn().mockRejectedValue(new Error('550 relay error'));
    const env = { SEND_EMAIL: { send } } as unknown as Env;
    await expect(
      sendEmail(env, { from: FROM, to: ['a@x.test'], subject: 's', text: 'x' }),
    ).rejects.toThrow(/send_email failed for a@x\.test: Error 550 relay error/i);
  });

  it('still identifies a binding error that carries no message', async () => {
    // A bare throw produced "send_email failed:" in production and told us
    // nothing about what broke — the name/code must survive into the log.
    const bare = Object.assign(new Error(''), { code: 'E_INTERNAL_SERVER_ERROR' });
    const { env } = envWithSpy(vi.fn().mockRejectedValue(bare));

    await expect(
      sendEmail(env, { from: FROM, to: ['a@x.test'], subject: 's', text: 'x' }),
    ).rejects.toThrow(/E_INTERNAL_SERVER_ERROR/);
  });

  it('reports a recipient outside the allowed list as pending verification', async () => {
    // Cloudflare rejects unallowed destinations with a coded Error. That's a
    // state the user can act on (verify the address), not a failed send.
    const err = Object.assign(new Error('recipient not allowed'), {
      code: 'E_RECIPIENT_NOT_ALLOWED',
    });
    const { env } = envWithSpy(vi.fn().mockRejectedValue(err));

    const result = await sendEmail(env, {
      from: FROM,
      to: ['a@x.test'],
      subject: 's',
      text: 'x',
    });

    expect(result.pendingVerification).toBe(true);
  });

  it('keeps delivering to the other recipients when one needs verifying', async () => {
    const err = Object.assign(new Error('recipient not allowed'), {
      code: 'E_RECIPIENT_NOT_ALLOWED',
    });
    const send = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(err))
      .mockResolvedValue(undefined);
    const { env } = envWithSpy(send);

    const result = await sendEmail(env, {
      from: FROM,
      to: ['blocked@x.test', 'fine@x.test'],
      subject: 's',
      text: 'x',
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(result.pendingVerification).toBe(true);
    expect(result.messageId).toBeTruthy();
  });
});
