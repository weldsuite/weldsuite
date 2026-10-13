/**
 * Edge cases of the two patterns that guard what reaches the wire: the
 * recipient check in `sendMail` and the domain cleanup in `generateMessageId`.
 * Both are written so they cannot backtrack badly, so the long inputs matter.
 */
import { describe, expect, it, vi } from 'vitest';
import { sendMail } from './client';
import { generateMessageId } from './mime';
import { FakeSmtpServer, type ScriptStep } from './testing/fake-server';
import type { SmtpConfig, SmtpSendResult, SmtpSocketFactory } from './types';

const config: SmtpConfig = {
  host: 'smtp.example.test',
  port: 465,
  secure: true,
  username: 'user@acme.test',
  password: 'secret',
  commandTimeoutMs: 1000,
};
const raw = 'Subject: hi\r\n\r\nhello\r\n';
const FINAL_OK = '250 2.0.0 OK 1700000000 abc - gsmtp';

describe('sendMail: recipient shape', () => {
  it.each([
    ['a space', 'a b@example.com'],
    ['a tab', 'a\tb@example.com'],
    ['a line break', 'a\nb@example.com'],
    ['a NUL', 'a\x00b@example.com'],
    ['a DEL', 'a\x7fb@example.com'],
    ['a no-break space', 'a b@example.com'],
    ['an em space', 'a b@example.com'],
    ['a byte order mark', 'a﻿b@example.com'],
    ['an angle bracket', 'a<b@example.com'],
    ['a quote', 'a"b@example.com'],
    ['a backslash', 'a\\b@example.com'],
    ['a second @', 'a@b@example.com'],
    ['a leading space', ' a@example.com'],
    ['a trailing space', 'a@example.com '],
    ['a domain that ends in a dot', 'a@example.com.'],
    ['no local part', '@example.com'],
  ])('refuses an address with %s without connecting', async (_label, address) => {
    const connect = vi.fn<SmtpSocketFactory>();
    const result: SmtpSendResult = await sendMail(config, { from: 'sender@getacme.test', to: [address] }, raw, { connect });
    expect(connect).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, permanent: true, stage: 'rcpt', recipientRejected: true });
  });

  it.each(['first.last+tag@sub.example.com', "o'brien@example.com", 'a_b%c@a-b.example.com', 'x@1.example.com'])(
    'accepts %s',
    async (address) => {
      const script: ScriptStep[] = [
        { expect: /^EHLO /, reply: ['250-mail.example.test at your service', '250 AUTH PLAIN'] },
        { expect: /^AUTH PLAIN /, reply: '235 2.7.0 Accepted' },
        { expect: 'MAIL FROM:<sender@getacme.test>', reply: '250 2.1.0 OK' },
        { expect: `RCPT TO:<${address}>`, reply: '250 2.1.5 OK' },
        { expect: 'DATA', reply: '354 Go ahead', data: { reply: FINAL_OK } },
      ];
      const server = new FakeSmtpServer({ script });
      const result = await sendMail(config, { from: 'sender@getacme.test', to: [address] }, raw, { connect: server.connect });
      expect(result).toEqual({ ok: true, response: FINAL_OK, accepted: [address] });
      expect(server.errors).toEqual([]);
    },
  );

  it('rejects a very long local part quickly', async () => {
    const connect = vi.fn<SmtpSocketFactory>();
    const start = Date.now();
    const result = await sendMail(config, { from: 'sender@getacme.test', to: [`${'a'.repeat(100_000)} @example.com`] }, raw, { connect });
    expect(result).toMatchObject({ ok: false, recipientRejected: true });
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('generateMessageId: domain edges', () => {
  it('trims leading and trailing dots and hyphens but keeps inner ones', () => {
    expect(generateMessageId('.-getacme.com-.')).toMatch(/@getacme\.com$/);
    expect(generateMessageId('mail.get-acme.com.')).toMatch(/@mail\.get-acme\.com$/);
    expect(() => generateMessageId('.-.-')).toThrow(TypeError);
  });

  it('cleans a long run of dots and hyphens quickly', () => {
    const start = Date.now();
    const id = generateMessageId(`${'.'.repeat(100_000)}getacme.com${'-.'.repeat(50_000)}x`);
    expect(id).toMatch(/@getacme\.com[-.]+x$/);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
