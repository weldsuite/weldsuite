/**
 * `adaptCloudflareEmail` must keep the raw RFC 5322 bytes through to
 * `rawMessageBytes` so `storeEmail` can write them to R2
 * (docs/plans/weldmail-mailbox-store-design.md decision 4; the bug this fixes:
 * `rawMessage` was only ever set when `rawEmail` was a string, but
 * `CloudflareReceiveProvider` always hands back an `ArrayBuffer` — raw MIME
 * was NULL for every Cloudflare-routed message).
 */

import { describe, it, expect } from 'vitest';
import type { ForwardableEmailMessage } from '@weldsuite/email/providers/cloudflare';
import { adaptCloudflareEmail } from './cf-email-adapter';

const RAW_EMAIL = [
  'From: Sender <sender@example.com>',
  'To: Recipient <recipient@example.com>',
  'Subject: Hello',
  'Message-ID: <abc123@example.com>',
  '',
  'Body text.',
  '',
].join('\r\n');

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakeMessage(raw: string, to = 'recipient@example.com'): ForwardableEmailMessage {
  return {
    from: 'sender@example.com',
    to,
    raw: streamOf(raw),
    headers: new Headers(),
    rawSize: new TextEncoder().encode(raw).byteLength,
    setReject: () => {},
    forward: async () => {},
  };
}

describe('adaptCloudflareEmail', () => {
  it('keeps the raw bytes in rawMessageBytes, matching what Cloudflare delivered', async () => {
    const { email } = await adaptCloudflareEmail(fakeMessage(RAW_EMAIL));

    expect(email.rawMessageBytes).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(email.rawMessageBytes)).toBe(RAW_EMAIL);
  });

  it('leaves rawMessage (the Postgres text column source) undefined, same as before', async () => {
    // Cloudflare's provider always hands back an ArrayBuffer (receive.ts),
    // never a string, so this field — which feeds a column workspace mail no
    // longer writes raw MIME to — must stay exactly as it was: unset.
    const { email } = await adaptCloudflareEmail(fakeMessage(RAW_EMAIL));

    expect(email.rawMessage).toBeUndefined();
  });

  it('parses the envelope recipient and subject as before, unaffected by the raw-bytes fix', async () => {
    const { email } = await adaptCloudflareEmail(fakeMessage(RAW_EMAIL, 'recipient@example.com'));

    expect(email.subject).toBe('Hello');
    expect(email.envelopeTo).toEqual(['recipient@example.com']);
    expect(email.from.email).toBe('sender@example.com');
  });
});
