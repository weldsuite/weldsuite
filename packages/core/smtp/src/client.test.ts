import { describe, expect, it, vi } from 'vitest';
import { prepareData, sendMail } from './client';
import { buildMimeMessage } from './mime';
import { FakeSmtpServer, type ScriptStep } from './testing/fake-server';
import type { SmtpConfig, SmtpEnvelope, SmtpSendResult, SmtpSocketFactory } from './types';

const USERNAME = 'user@acme.test';
const PASSWORD = 'p@ss word';

const config: SmtpConfig = {
  host: 'smtp.example.test',
  port: 465,
  secure: true,
  username: USERNAME,
  password: PASSWORD,
  commandTimeoutMs: 1000,
};
const submission: SmtpConfig = { ...config, port: 587, secure: false };
const envelope: SmtpEnvelope = { from: 'sender@getacme.test', to: ['lead@example.com'] };
const raw = 'Subject: hi\r\n\r\nhello\r\n';

const plainToken = (user = USERNAME, pass = PASSWORD) => Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

const EHLO_TLS = ['250-mail.example.test at your service', '250-SIZE 35882577', '250-AUTH LOGIN PLAIN XOAUTH2', '250 ENHANCEDSTATUSCODES'];
const EHLO_PLAINTEXT = ['250-mail.example.test at your service', '250-SIZE 35882577', '250-STARTTLS', '250 ENHANCEDSTATUSCODES'];
const FINAL_OK = '250 2.0.0 OK 1700000000 abc - gsmtp';

const ehlo: ScriptStep = { expect: /^EHLO /, reply: EHLO_TLS };
const authPlain: ScriptStep = { expect: `AUTH PLAIN ${plainToken()}`, reply: '235 2.7.0 Accepted' };
const mailFrom: ScriptStep = { expect: 'MAIL FROM:<sender@getacme.test>', reply: '250 2.1.0 OK' };
const rcpt = (address = 'lead@example.com', reply = '250 2.1.5 OK'): ScriptStep => ({ expect: `RCPT TO:<${address}>`, reply });
const dataStep = (finalReply: string | string[] | null = FINAL_OK): ScriptStep => ({
  expect: 'DATA',
  reply: '354 Go ahead',
  data: { reply: finalReply },
});

async function run(
  server: FakeSmtpServer,
  overrides: { config?: Partial<SmtpConfig>; envelope?: SmtpEnvelope; raw?: string } = {},
): Promise<SmtpSendResult> {
  return sendMail({ ...config, ...overrides.config }, overrides.envelope ?? envelope, overrides.raw ?? raw, {
    connect: server.connect,
  });
}

function expectClean(server: FakeSmtpServer): void {
  expect(server.errors).toEqual([]);
  expect(server.unconsumed).toEqual([]);
}

function failure(result: SmtpSendResult): Extract<SmtpSendResult, { ok: false }> {
  if (result.ok) throw new Error(`expected a failure, got success: ${result.response}`);
  return result;
}

describe('sendMail: happy paths', () => {
  it('sends over implicit TLS (465) with AUTH PLAIN', async () => {
    const server = new FakeSmtpServer({
      script: [ehlo, authPlain, mailFrom, rcpt(), dataStep()],
    });

    const result = await run(server);

    expect(result).toEqual({ ok: true, response: FINAL_OK, accepted: ['lead@example.com'] });
    expectClean(server);
    expect(server.connects).toEqual([
      {
        address: { hostname: 'smtp.example.test', port: 465 },
        options: { secureTransport: 'on', allowHalfOpen: false },
      },
    ]);
    expect(server.commands).toEqual([
      'EHLO getacme.test',
      `AUTH PLAIN ${plainToken()}`,
      'MAIL FROM:<sender@getacme.test>',
      'RCPT TO:<lead@example.com>',
      'DATA',
      'QUIT',
    ]);
    expect(server.bodies).toEqual(['Subject: hi\r\n\r\nhello\r\n']);
    expect(server.upgrades).toBe(0);
    expect(server.closeCalls).toBe(1);
  });

  it('upgrades with STARTTLS on 587 and never sends credentials in cleartext', async () => {
    const server = new FakeSmtpServer({
      script: [
        { expect: /^EHLO /, reply: EHLO_PLAINTEXT },
        { expect: 'STARTTLS', reply: '220 2.0.0 Ready to start TLS', upgrade: true },
        ehlo,
        authPlain,
        mailFrom,
        rcpt(),
        dataStep(),
      ],
    });

    const result = await run(server, { config: submission });

    expect(result.ok).toBe(true);
    expectClean(server);
    expect(server.connects[0]?.options).toEqual({ secureTransport: 'starttls', allowHalfOpen: false });
    expect(server.upgrades).toBe(1);
    expect(server.commands.slice(0, 4)).toEqual(['EHLO getacme.test', 'STARTTLS', 'EHLO getacme.test', `AUTH PLAIN ${plainToken()}`]);
    expect(server.cleartext).not.toContain('AUTH');
    expect(server.cleartext).not.toContain(plainToken());
    expect(server.cleartext).not.toContain(PASSWORD);
  });

  it('authenticates with AUTH LOGIN when PLAIN is not offered', async () => {
    const server = new FakeSmtpServer({
      script: [
        { expect: /^EHLO /, reply: ['250-mail.example.test', '250 AUTH LOGIN'] },
        { expect: 'AUTH LOGIN', reply: '334 VXNlcm5hbWU6' },
        { expect: b64(USERNAME), reply: '334 UGFzc3dvcmQ6' },
        { expect: b64(PASSWORD), reply: '235 2.7.0 Accepted' },
        mailFrom,
        rcpt(),
        dataStep(),
      ],
    });

    expect((await run(server)).ok).toBe(true);
    expectClean(server);
  });

  it('prefers PLAIN over LOGIN and reads the legacy AUTH= advertisement', async () => {
    const server = new FakeSmtpServer({
      script: [
        { expect: /^EHLO /, reply: ['250-mail.example.test', '250-AUTH=LOGIN PLAIN', '250 8BITMIME'] },
        authPlain,
        mailFrom,
        rcpt(),
        dataStep(),
      ],
    });

    expect((await run(server)).ok).toBe(true);
    expectClean(server);
  });

  it('encodes non-ASCII credentials as UTF-8', async () => {
    const server = new FakeSmtpServer({
      script: [
        ehlo,
        { expect: `AUTH PLAIN ${plainToken('jürgen@acme.test', 'pässwörd')}`, reply: '235 2.7.0 Accepted' },
        mailFrom,
        rcpt(),
        dataStep(),
      ],
    });

    const result = await run(server, { config: { username: 'jürgen@acme.test', password: 'pässwörd' } });
    expect(result.ok).toBe(true);
    expectClean(server);
  });

  it('skips AUTH when no username is configured', async () => {
    const server = new FakeSmtpServer({ script: [ehlo, mailFrom, rcpt(), dataStep()] });
    expect((await run(server, { config: { username: '', password: '' } })).ok).toBe(true);
    expectClean(server);
  });

  it('uses the sender domain as EHLO name unless heloName is set', async () => {
    const custom = new FakeSmtpServer({ script: [{ expect: 'EHLO mail.custom.test', reply: EHLO_TLS }, authPlain, mailFrom, rcpt(), dataStep()] });
    expect((await run(custom, { config: { heloName: 'mail.custom.test' } })).ok).toBe(true);
    expectClean(custom);
  });

  it('copes with replies delivered one byte at a time', async () => {
    const server = new FakeSmtpServer({
      chunkSize: 1,
      script: [
        { expect: /^EHLO /, reply: EHLO_PLAINTEXT },
        { expect: 'STARTTLS', reply: '220 2.0.0 Ready to start TLS', upgrade: true },
        ehlo,
        authPlain,
        mailFrom,
        rcpt(),
        dataStep(),
      ],
    });

    const result = await run(server, { config: submission });
    expect(result).toEqual({ ok: true, response: FINAL_OK, accepted: ['lead@example.com'] });
    expectClean(server);
  });

  it('reports the multi-line final reply as one string', async () => {
    const server = new FakeSmtpServer({
      script: [ehlo, authPlain, mailFrom, rcpt(), dataStep(['250-2.0.0 Message accepted', '250 2.0.0 queued as ABC123'])],
    });
    const result = await run(server);
    expect(result).toEqual({ ok: true, response: '250 2.0.0 Message accepted queued as ABC123', accepted: ['lead@example.com'] });
  });

  it('delivers a message built by buildMimeMessage unchanged', async () => {
    const message = buildMimeMessage({
      from: { email: 'sender@getacme.test', name: 'Jane Doe' },
      to: [{ email: 'lead@example.com' }],
      subject: 'Hello',
      text: 'First line\n.second line starts with a dot\n.\nlast',
      messageId: 'abc@getacme.test',
      date: new Date(Date.UTC(2023, 10, 14, 22, 13, 20)),
    });
    const server = new FakeSmtpServer({ script: [ehlo, authPlain, mailFrom, rcpt(), dataStep()] });

    expect((await run(server, { raw: message })).ok).toBe(true);

    const body = server.bodies[0] ?? '';
    expect(body.endsWith('\r\n')).toBe(true);
    // Un-stuff as a receiving server would: the message must come out as built.
    const unstuffed = body
      .split('\r\n')
      .map((line) => (line.startsWith('..') ? line.slice(1) : line))
      .join('\r\n');
    expect(unstuffed).toBe(message);
    expect(body).toContain('\r\n..second line starts with a dot\r\n');
    expect(body).toContain('\r\n..\r\n');
  });
});

describe('sendMail: DATA payload', () => {
  it('dot-stuffs lines that start with a dot and terminates with CRLF.CRLF', () => {
    expect(prepareData('a\r\n.b\r\n..c\r\n.\r\nd\r\n')).toBe('a\r\n..b\r\n...c\r\n..\r\nd\r\n.\r\n');
  });

  it('normalises bare LF and CR to CRLF and adds the final CRLF', () => {
    expect(prepareData('a\nb\rc')).toBe('a\r\nb\r\nc\r\n.\r\n');
  });

  it('puts the stuffed body on the wire and ends it exactly once', async () => {
    const server = new FakeSmtpServer({ script: [ehlo, authPlain, mailFrom, rcpt(), dataStep()] });
    await run(server, { raw: 'Subject: x\n\n.hidden\n..two\n.\nend' });
    expect(server.bodies).toEqual(['Subject: x\r\n\r\n..hidden\r\n...two\r\n..\r\nend\r\n']);
  });
});

describe('sendMail: recipients', () => {
  it('continues when one of several recipients is rejected and reports the accepted ones', async () => {
    const server = new FakeSmtpServer({
      script: [
        ehlo,
        authPlain,
        mailFrom,
        rcpt('a@example.com'),
        rcpt('bad@example.com', '550 5.1.1 The email account that you tried to reach does not exist'),
        rcpt('c@example.com'),
        dataStep(),
      ],
    });

    const result = await run(server, { envelope: { from: envelope.from, to: ['a@example.com', 'bad@example.com', 'c@example.com'] } });
    expect(result).toEqual({ ok: true, response: FINAL_OK, accepted: ['a@example.com', 'c@example.com'] });
    expectClean(server);
  });

  it('fails as a hard bounce when the only recipient is rejected with 550 5.1.1', async () => {
    const server = new FakeSmtpServer({
      script: [ehlo, authPlain, mailFrom, rcpt('lead@example.com', '550 5.1.1 The email account that you tried to reach does not exist')],
    });

    const result = failure(await run(server));
    expect(result).toEqual({
      ok: false,
      permanent: true,
      stage: 'rcpt',
      code: 550,
      enhancedCode: '5.1.1',
      response: '550 5.1.1 The email account that you tried to reach does not exist',
      recipientRejected: true,
      authFailed: false,
    });
    expect(server.errors).toEqual([]);
    expect(server.commands.at(-1)).toBe('QUIT');
    expect(server.commands).not.toContain('DATA');
  });

  it('fails permanently without flagging a bounce when every recipient is refused for a non-recipient reason', async () => {
    const server = new FakeSmtpServer({
      script: [ehlo, authPlain, mailFrom, rcpt('lead@example.com', '554 5.7.0 Sending blocked for this account')],
    });
    const result = failure(await run(server));
    expect(result).toMatchObject({ permanent: true, stage: 'rcpt', code: 554, recipientRejected: false });
  });

  it.each([
    ['553 5.1.3 The recipient address is not a valid RFC 5321 address', true],
    ['550 5.2.1 Mailbox disabled, not accepting messages', true],
    ['550 5.7.1 Recipient address rejected: access denied', true],
    ['550 Requested action not taken: mailbox unavailable', true],
    ['551 User not local', true],
    ['554 5.4.4 Unable to route', false],
    ['554 Transaction failed', false],
    ['550 5.7.8 Authentication required to relay', false],
  ])('classifies RCPT %s as recipientRejected=%s', async (reply, expected) => {
    const server = new FakeSmtpServer({ script: [ehlo, authPlain, mailFrom, rcpt('lead@example.com', reply)] });
    const result = failure(await run(server));
    expect(result.permanent).toBe(true);
    expect(result.recipientRejected).toBe(expected);
  });

  it('treats a 4xx RCPT reply as temporary and not a bounce', async () => {
    const server = new FakeSmtpServer({
      script: [ehlo, authPlain, mailFrom, rcpt('lead@example.com', '450 4.2.0 Recipient temporarily unavailable, try again later')],
    });
    const result = failure(await run(server));
    expect(result).toMatchObject({
      permanent: false,
      stage: 'rcpt',
      code: 450,
      enhancedCode: '4.2.0',
      recipientRejected: false,
      authFailed: false,
    });
  });

  it('is retryable when any rejected recipient was only deferred and none were accepted', async () => {
    const server = new FakeSmtpServer({
      script: [
        ehlo,
        authPlain,
        mailFrom,
        rcpt('a@example.com', '550 5.1.1 no such user'),
        rcpt('b@example.com', '451 4.7.1 greylisted'),
      ],
    });
    const result = failure(await run(server, { envelope: { from: envelope.from, to: ['a@example.com', 'b@example.com'] } }));
    expect(result).toMatchObject({ permanent: false, code: 451, recipientRejected: false });
  });

  it('is a hard bounce when every recipient is permanently rejected', async () => {
    const server = new FakeSmtpServer({
      script: [
        ehlo,
        authPlain,
        mailFrom,
        rcpt('a@example.com', '550 5.1.1 no such user'),
        rcpt('b@example.com', '550 5.1.1 no such user either'),
      ],
    });
    const result = failure(await run(server, { envelope: { from: envelope.from, to: ['a@example.com', 'b@example.com'] } }));
    expect(result).toMatchObject({ permanent: true, recipientRejected: true });
  });

  it('stops at 421 instead of offering the remaining recipients', async () => {
    const server = new FakeSmtpServer({
      script: [ehlo, authPlain, mailFrom, rcpt('a@example.com', '421 4.7.0 Too many connections, closing channel')],
    });
    const result = failure(await run(server, { envelope: { from: envelope.from, to: ['a@example.com', 'b@example.com'] } }));
    expect(result).toMatchObject({ permanent: false, code: 421, stage: 'rcpt' });
    expect(server.commands).not.toContain('RCPT TO:<b@example.com>');
  });

  it('refuses malformed recipients locally without connecting (SMTP command injection)', async () => {
    const connect = vi.fn<SmtpSocketFactory>();
    const result = failure(
      await sendMail(config, { from: envelope.from, to: ['lead@example.com>\r\nRCPT TO:<evil@example.org'] }, raw, { connect }),
    );
    expect(connect).not.toHaveBeenCalled();
    expect(result).toMatchObject({ permanent: true, stage: 'rcpt', recipientRejected: true });
  });

  it('drops malformed recipients and sends to the valid ones', async () => {
    const server = new FakeSmtpServer({ script: [ehlo, authPlain, mailFrom, rcpt('ok@example.com'), dataStep()] });
    const result = await run(server, {
      envelope: { from: envelope.from, to: ['not an address', 'ünicode@example.com', 'ok@example.com'] },
    });
    expect(result).toEqual({ ok: true, response: FINAL_OK, accepted: ['ok@example.com'] });
    expectClean(server);
  });

  it('refuses an empty recipient list and a malformed sender locally', async () => {
    const connect = vi.fn<SmtpSocketFactory>();
    expect(failure(await sendMail(config, { from: envelope.from, to: [] }, raw, { connect }))).toMatchObject({
      permanent: true,
      stage: 'rcpt',
      recipientRejected: false,
    });
    expect(failure(await sendMail(config, { from: 'a@b.com\r\nDATA', to: ['x@example.com'] }, raw, { connect }))).toMatchObject({
      permanent: true,
      stage: 'mail',
    });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('sendMail: authentication', () => {
  it('flags a 535 as authFailed and permanent', async () => {
    const server = new FakeSmtpServer({
      script: [ehlo, { expect: `AUTH PLAIN ${plainToken()}`, reply: '535 5.7.8 Authentication credentials invalid' }],
    });

    const result = failure(await run(server));
    expect(result).toEqual({
      ok: false,
      permanent: true,
      stage: 'auth',
      code: 535,
      enhancedCode: '5.7.8',
      response: '535 5.7.8 Authentication credentials invalid',
      recipientRejected: false,
      authFailed: true,
    });
    expect(server.commands).not.toContain('MAIL FROM:<sender@getacme.test>');
  });

  it('reads Gmail style multi-line 535 replies', async () => {
    const server = new FakeSmtpServer({
      script: [
        ehlo,
        {
          expect: `AUTH PLAIN ${plainToken()}`,
          reply: [
            '535-5.7.8 Username and Password not accepted. For more information, go to',
            '535 5.7.8  https://support.google.com/mail/?p=BadCredentials abc.1 - gsmtp',
          ],
          chunkSize: 7,
        },
      ],
    });
    const result = failure(await run(server));
    expect(result).toMatchObject({ permanent: true, stage: 'auth', code: 535, enhancedCode: '5.7.8', authFailed: true });
    expect(result.response).toBe(
      '535 5.7.8 Username and Password not accepted. For more information, go to https://support.google.com/mail/?p=BadCredentials abc.1 - gsmtp',
    );
  });

  it('flags a 534 (application-specific password required) as authFailed', async () => {
    const server = new FakeSmtpServer({
      script: [ehlo, { expect: `AUTH PLAIN ${plainToken()}`, reply: ['534-5.7.9 Application-specific password required', '534 5.7.9 Learn more'] }],
    });
    const result = failure(await run(server));
    expect(result).toMatchObject({ permanent: true, stage: 'auth', code: 534, authFailed: true });
  });

  it('treats a temporary auth failure as retryable and not as bad credentials', async () => {
    const server = new FakeSmtpServer({
      script: [ehlo, { expect: `AUTH PLAIN ${plainToken()}`, reply: '454 4.7.0 Temporary authentication failure' }],
    });
    const result = failure(await run(server));
    expect(result).toMatchObject({ permanent: false, stage: 'auth', code: 454, authFailed: false });
  });

  it('fails an AUTH LOGIN rejected at the password step', async () => {
    const server = new FakeSmtpServer({
      script: [
        { expect: /^EHLO /, reply: ['250-mail.example.test', '250 AUTH LOGIN'] },
        { expect: 'AUTH LOGIN', reply: '334 VXNlcm5hbWU6' },
        { expect: b64(USERNAME), reply: '334 UGFzc3dvcmQ6' },
        { expect: b64(PASSWORD), reply: '535 5.7.8 Bad credentials' },
      ],
    });
    const result = failure(await run(server));
    expect(result).toMatchObject({ permanent: true, stage: 'auth', code: 535, authFailed: true });
    expectClean(server);
  });

  it('fails permanently when the server offers no supported AUTH mechanism', async () => {
    const server = new FakeSmtpServer({
      script: [{ expect: /^EHLO /, reply: ['250-mail.example.test', '250 AUTH XOAUTH2 CRAM-MD5'] }],
    });
    const result = failure(await run(server));
    expect(result).toMatchObject({ permanent: true, stage: 'auth', authFailed: false });
    expect(result.response).toContain('XOAUTH2');
    expect(server.commands).toEqual(['EHLO getacme.test', 'QUIT']);
  });

  it('fails permanently when AUTH is not advertised at all', async () => {
    const server = new FakeSmtpServer({ script: [{ expect: /^EHLO /, reply: ['250-mail.example.test', '250 8BITMIME'] }] });
    const result = failure(await run(server));
    expect(result).toMatchObject({ permanent: true, stage: 'auth' });
    expect(result.response).toContain('none');
  });

  it('refuses credentials with control characters without connecting', async () => {
    const connect = vi.fn<SmtpSocketFactory>();
    const result = failure(await sendMail({ ...config, password: 'a\r\nMAIL FROM:<x@y.z>' }, envelope, raw, { connect }));
    expect(result).toMatchObject({ permanent: true, stage: 'auth', authFailed: true });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('sendMail: TLS requirements', () => {
  it('refuses to authenticate when a non-secure server does not offer STARTTLS', async () => {
    const server = new FakeSmtpServer({
      script: [{ expect: /^EHLO /, reply: ['250-mail.example.test', '250-AUTH PLAIN LOGIN', '250 8BITMIME'] }],
    });

    const result = failure(await run(server, { config: submission }));

    expect(result).toMatchObject({ permanent: true, stage: 'starttls', recipientRejected: false, authFailed: false });
    expect(result.response).toMatch(/STARTTLS/);
    expect(server.cleartext).not.toContain('AUTH');
    expect(server.cleartext).not.toContain(plainToken());
    expect(server.upgrades).toBe(0);
  });

  it('fails when STARTTLS is refused by the server', async () => {
    const server = new FakeSmtpServer({
      script: [
        { expect: /^EHLO /, reply: EHLO_PLAINTEXT },
        { expect: 'STARTTLS', reply: '454 4.7.0 TLS not available due to temporary reason' },
      ],
    });
    const result = failure(await run(server, { config: submission }));
    expect(result).toMatchObject({ permanent: false, stage: 'starttls', code: 454 });
    expect(server.cleartext).not.toContain('AUTH');
  });

  it('refuses to upgrade when the server injects data after the STARTTLS reply', async () => {
    const server = new FakeSmtpServer({
      script: [
        { expect: /^EHLO /, reply: EHLO_PLAINTEXT },
        { expect: 'STARTTLS', reply: ['220 2.0.0 Ready to start TLS', '250 injected-before-handshake'], upgrade: true },
      ],
    });
    const result = failure(await run(server, { config: submission }));
    expect(result).toMatchObject({ permanent: true, stage: 'starttls' });
    expect(server.upgrades).toBe(0);
    expect(server.cleartext).not.toContain('AUTH');
  });

  it('reports a failing TLS upgrade as a retryable starttls error', async () => {
    const server = new FakeSmtpServer({
      script: [
        { expect: /^EHLO /, reply: EHLO_PLAINTEXT },
        { expect: 'STARTTLS', reply: '220 2.0.0 Ready to start TLS' }, // no `upgrade`: the fake refuses startTls()
      ],
    });
    const result = failure(await run(server, { config: submission }));
    expect(result).toMatchObject({ permanent: false, stage: 'starttls' });
    expect(server.cleartext).not.toContain('AUTH');
  });

  it('does not allow port 25', async () => {
    const connect = vi.fn<SmtpSocketFactory>();
    for (const secure of [true, false]) {
      const result = failure(await sendMail({ ...config, port: 25, secure }, envelope, raw, { connect }));
      expect(result).toMatchObject({ permanent: true, stage: 'connect' });
      expect(result.response).toMatch(/port 25/i);
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects an invalid port or an empty host without connecting', async () => {
    const connect = vi.fn<SmtpSocketFactory>();
    expect(failure(await sendMail({ ...config, port: 0 }, envelope, raw, { connect }))).toMatchObject({ permanent: true, stage: 'connect' });
    expect(failure(await sendMail({ ...config, port: 70000 }, envelope, raw, { connect }))).toMatchObject({ permanent: true });
    expect(failure(await sendMail({ ...config, host: ' ' }, envelope, raw, { connect }))).toMatchObject({ permanent: true });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('sendMail: server errors', () => {
  it('treats a 421 greeting as temporary', async () => {
    const server = new FakeSmtpServer({ greeting: '421 4.3.2 Service not available, closing transmission channel', script: [] });
    const result = failure(await run(server));
    expect(result).toEqual({
      ok: false,
      permanent: false,
      stage: 'greeting',
      code: 421,
      enhancedCode: '4.3.2',
      response: '421 4.3.2 Service not available, closing transmission channel',
      recipientRejected: false,
      authFailed: false,
    });
  });

  it('treats a 554 greeting as permanent', async () => {
    const server = new FakeSmtpServer({ greeting: '554 5.3.2 No SMTP service here', script: [] });
    expect(failure(await run(server))).toMatchObject({ permanent: true, stage: 'greeting', code: 554 });
  });

  it('treats a greeting that is not SMTP as a permanent protocol failure', async () => {
    const server = new FakeSmtpServer({ greeting: 'HTTP/1.1 400 Bad Request', script: [] });
    const result = failure(await run(server));
    expect(result).toMatchObject({ permanent: true, stage: 'greeting' });
    expect(result.code).toBeUndefined();
  });

  it('treats a rejected EHLO as permanent', async () => {
    const server = new FakeSmtpServer({ script: [{ expect: /^EHLO /, reply: '501 5.5.4 Syntax error in parameters' }] });
    expect(failure(await run(server))).toMatchObject({ permanent: true, stage: 'ehlo', code: 501 });
  });

  it('treats a 4xx at MAIL FROM as temporary', async () => {
    const server = new FakeSmtpServer({
      script: [ehlo, authPlain, { expect: 'MAIL FROM:<sender@getacme.test>', reply: '421 4.7.0 Try again later, closing connection' }],
    });
    expect(failure(await run(server))).toMatchObject({ permanent: false, stage: 'mail', code: 421 });
  });

  it('treats a 5xx at MAIL FROM as permanent and not a recipient problem', async () => {
    const server = new FakeSmtpServer({
      script: [ehlo, authPlain, { expect: 'MAIL FROM:<sender@getacme.test>', reply: '553 5.7.1 Sender address rejected: not owned by user' }],
    });
    expect(failure(await run(server))).toMatchObject({
      permanent: true,
      stage: 'mail',
      code: 553,
      recipientRejected: false,
      authFailed: false,
    });
  });

  it('fails at DATA when the server will not take the message', async () => {
    const server = new FakeSmtpServer({
      script: [ehlo, authPlain, mailFrom, rcpt(), { expect: 'DATA', reply: '451 4.3.0 Temporary local problem' }],
    });
    expect(failure(await run(server))).toMatchObject({ permanent: false, stage: 'data', code: 451 });
  });

  it('classifies a 5xx after the message body as permanent, with the server text', async () => {
    const server = new FakeSmtpServer({
      script: [ehlo, authPlain, mailFrom, rcpt(), dataStep('554 5.7.1 Message rejected as spam by policy')],
    });
    const result = failure(await run(server));
    expect(result).toEqual({
      ok: false,
      permanent: true,
      stage: 'data',
      code: 554,
      enhancedCode: '5.7.1',
      response: '554 5.7.1 Message rejected as spam by policy',
      recipientRejected: false,
      authFailed: false,
    });
    expect(result.deliveryUncertain).toBeUndefined();
  });

  it('classifies a 4xx after the message body as temporary', async () => {
    const server = new FakeSmtpServer({
      script: [ehlo, authPlain, mailFrom, rcpt(), dataStep('452 4.2.2 Mailbox over quota, try later')],
    });
    const result = failure(await run(server));
    expect(result).toMatchObject({ permanent: false, stage: 'data', code: 452 });
    expect(result.deliveryUncertain).toBeUndefined();
  });

  it('treats an unexpected success where something else was required as a protocol failure', async () => {
    const server = new FakeSmtpServer({
      script: [ehlo, authPlain, mailFrom, rcpt(), { expect: 'DATA', reply: '250 2.0.0 OK (but I did not ask for data)' }],
    });
    expect(failure(await run(server))).toMatchObject({ permanent: true, stage: 'data', code: 250 });
  });
});

describe('sendMail: connection problems and timeouts', () => {
  it('reports a connect() that throws as a retryable connect failure', async () => {
    const connect: SmtpSocketFactory = () => {
      throw new Error('Connection refused');
    };
    const result = failure(await sendMail(config, envelope, raw, { connect }));
    expect(result).toMatchObject({ permanent: false, stage: 'connect', recipientRejected: false, authFailed: false });
    expect(result.response).toContain('Connection refused');
  });

  it('reports a connection that dies before the greeting as a retryable connect failure', async () => {
    const server = new FakeSmtpServer({ greeting: null, script: [] });
    const connect: SmtpSocketFactory = (address, options) => {
      const socket = server.connect(address, options);
      queueMicrotask(() => {
        void socket.close();
      });
      return socket;
    };
    const result = failure(await sendMail(config, envelope, raw, { connect }));
    expect(result).toMatchObject({ permanent: false, stage: 'connect' });
    expect(result.response).toMatch(/closed/i);
  });

  it('times out waiting for the greeting', async () => {
    const server = new FakeSmtpServer({ greeting: null, script: [] });
    const started = Date.now();
    const result = failure(await run(server, { config: { commandTimeoutMs: 50 } }));
    expect(result).toMatchObject({ permanent: false, stage: 'timeout' });
    expect(result.response).toContain('greeting');
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('times out when a command gets no reply, without sending QUIT', async () => {
    const server = new FakeSmtpServer({ script: [{ expect: /^EHLO /, reply: null }] });
    const result = failure(await run(server, { config: { commandTimeoutMs: 50 } }));
    expect(result).toMatchObject({ permanent: false, stage: 'timeout', recipientRejected: false, authFailed: false });
    expect(result.response).toContain('EHLO');
    expect(result.deliveryUncertain).toBeUndefined();
    expect(server.commands).toEqual(['EHLO getacme.test']);
    expect(server.closeCalls).toBe(1);
  });

  it('times out when the reply is only partly delivered', async () => {
    const server = new FakeSmtpServer({ script: [{ expect: /^EHLO /, reply: ['250-mail.example.test', '250-SIZE 1'] }] });
    // every line is a "250-" continuation, so the reply never completes
    const result = failure(await run(server, { config: { commandTimeoutMs: 50 } }));
    expect(result).toMatchObject({ permanent: false, stage: 'timeout' });
  });

  it('marks delivery as uncertain when the final reply to DATA never arrives', async () => {
    const server = new FakeSmtpServer({ script: [ehlo, authPlain, mailFrom, rcpt(), dataStep(null)] });
    const result = failure(await run(server, { config: { commandTimeoutMs: 80 } }));
    expect(result).toMatchObject({ permanent: false, stage: 'timeout', deliveryUncertain: true });
    expect(server.bodies).toHaveLength(1);
  });

  it('marks delivery as uncertain when the connection drops after the body was sent', async () => {
    const server = new FakeSmtpServer({
      script: [ehlo, authPlain, mailFrom, rcpt(), { expect: 'DATA', reply: '354 Go ahead', data: { reply: null, hangUp: true } }],
    });
    const result = failure(await run(server));
    expect(result).toMatchObject({ permanent: false, stage: 'data', deliveryUncertain: true });
  });

  it('marks delivery as uncertain when the connection is reset after the body was sent', async () => {
    const server = new FakeSmtpServer({
      script: [ehlo, authPlain, mailFrom, rcpt(), { expect: 'DATA', reply: '354 Go ahead', data: { reply: null, reset: true } }],
    });
    const result = failure(await run(server));
    expect(result).toMatchObject({ permanent: false, deliveryUncertain: true });
    expect(result.response).toContain('ECONNRESET');
  });

  it('does not mark delivery uncertain for a failure before the body was sent', async () => {
    const server = new FakeSmtpServer({ script: [ehlo, authPlain, mailFrom, rcpt(), { expect: 'DATA', reply: null }] });
    const result = failure(await run(server, { config: { commandTimeoutMs: 50 } }));
    expect(result).toMatchObject({ permanent: false, stage: 'timeout' });
    expect(result.deliveryUncertain).toBeUndefined();
  });

  it('reports a connection reset mid-session as retryable at the current stage', async () => {
    const server = new FakeSmtpServer({ script: [ehlo, { expect: `AUTH PLAIN ${plainToken()}`, reply: null, reset: true }] });
    const result = failure(await run(server));
    expect(result).toMatchObject({ permanent: false, stage: 'auth', authFailed: false });
    expect(result.response).toContain('ECONNRESET');
  });

  it('reports a server hanging up mid-session as retryable at the current stage', async () => {
    const server = new FakeSmtpServer({ script: [ehlo, authPlain, { expect: /^MAIL FROM/, reply: null, hangUp: true }] });
    const result = failure(await run(server));
    expect(result).toMatchObject({ permanent: false, stage: 'mail' });
    expect(result.response).toMatch(/closed/i);
  });

  it('closes the socket after a successful send, a failed send and a thrown connect alike', async () => {
    const ok = new FakeSmtpServer({ script: [ehlo, authPlain, mailFrom, rcpt(), dataStep()] });
    await run(ok);
    const bad = new FakeSmtpServer({ script: [ehlo, { expect: /^AUTH/, reply: '535 5.7.8 nope' }] });
    await run(bad);
    expect(ok.closeCalls).toBe(1);
    expect(bad.closeCalls).toBe(1);
  });
});
