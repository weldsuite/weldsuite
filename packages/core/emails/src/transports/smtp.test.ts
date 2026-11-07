import { readFileSync, existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { createTransport, type Transporter } from 'nodemailer';
import { afterEach, describe, expect, it } from 'vitest';
import { icsAttachment } from '../ics';
import type { OutgoingEmail } from '../transport';
import { transportFromNodeEnv } from './node-env';
import { nodemailerTransport, parseSmtpUrl, smtpMessage, smtpOptions, smtpTransport } from './smtp';

const sample: OutgoingEmail = {
  from: { email: 'notifications@mail.weldsuite.org', name: 'WeldCalendar' },
  to: [{ email: 'guest@example.com', name: 'Guest' }, { email: 'second@example.com' }],
  cc: [{ email: 'cc@example.com', name: 'Copy' }],
  bcc: [{ email: 'hidden@example.com' }],
  replyTo: { email: 'host@acme.com', name: 'Host "The Boss" <x>' },
  subject: 'Planning on Friday',
  html: '<p>Hello <strong>Guest</strong></p>',
  text: 'Hello Guest',
  attachments: [
    icsAttachment({ uid: 'evt_1@weldsuite.org', title: 'Planning', attendees: [] }),
    { filename: 'data.bin', content: new Uint8Array([0, 1, 2, 253, 254, 255]), contentType: 'application/octet-stream' },
  ],
  headers: { 'List-Unsubscribe': '<https://app.weldsuite.org/unsubscribe>', 'X-Entity-Ref-ID': 'evt_1' },
};

describe('parseSmtpUrl', () => {
  it('reads the forms the Rust server documents', () => {
    expect(parseSmtpUrl('smtp://user:password@relay:587?tls=required')).toEqual({
      host: 'relay',
      port: 587,
      security: 'starttls',
      auth: { user: 'user', pass: 'password' },
    });
    expect(parseSmtpUrl('smtps://user:password@relay.example.com:465')).toEqual({
      host: 'relay.example.com',
      port: 465,
      security: 'tls',
      auth: { user: 'user', pass: 'password' },
    });
    expect(parseSmtpUrl('smtp://mailpit:1025')).toEqual({ host: 'mailpit', port: 1025, security: 'none' });
  });

  it('defaults the port as lettre does: 25 plain, 587 with tls, 465 for smtps', () => {
    expect(parseSmtpUrl('smtp://relay').port).toBe(25);
    expect(parseSmtpUrl('smtp://relay?tls=required').port).toBe(587);
    expect(parseSmtpUrl('smtp://relay?tls=opportunistic')).toMatchObject({ port: 587, security: 'opportunistic' });
    expect(parseSmtpUrl('smtps://relay').port).toBe(465);
  });

  it('ignores the tls parameter on smtps, as lettre does', () => {
    expect(parseSmtpUrl('smtps://relay:2465?tls=required')).toMatchObject({ port: 2465, security: 'tls' });
  });

  it('percent-decodes credentials and uses them only with a password', () => {
    expect(parseSmtpUrl('smtp://us%40er:p%40ss%2Fw%3Ard@relay?tls=required').auth).toEqual({
      user: 'us@er',
      pass: 'p@ss/w:rd',
    });
    expect(parseSmtpUrl('smtp://apikey@relay').auth).toBeUndefined();
  });

  it('takes the path as the EHLO name', () => {
    expect(parseSmtpUrl('smtp://relay:25/mail.example.eu').helloName).toBe('mail.example.eu');
    expect(parseSmtpUrl('smtp://relay:25/').helloName).toBeUndefined();
  });

  it('accepts surrounding whitespace and an upper-case scheme', () => {
    expect(parseSmtpUrl('  SMTPS://relay  ')).toMatchObject({ host: 'relay', security: 'tls' });
  });

  it('gives an IPv6 relay without brackets', () => {
    expect(parseSmtpUrl('smtp://[::1]:1025')).toMatchObject({ host: '::1', port: 1025 });
  });

  it.each([
    ['http://relay:25'],
    ['smtp://relay?tls=yes'],
    ['smtp://relay?tls=none'],
    ['smtp://'],
    ['relay:25'],
    ['not a url'],
  ])('refuses %s', (url) => {
    expect(() => parseSmtpUrl(url)).toThrow(/SMTP_URL/);
  });

  it('never repeats the password in an error', () => {
    for (const url of ['smtp://user:hunter2@relay?tls=bogus', 'smtp://user:hunter2@[bad', 'smtp://user:%E0%A4%A@relay']) {
      expect(() => parseSmtpUrl(url)).toThrow();
      try {
        parseSmtpUrl(url);
      } catch (err) {
        expect(String((err as Error).message)).not.toContain('hunter2');
        expect(JSON.stringify(err)).not.toContain('hunter2');
      }
    }
  });
});

describe('smtpOptions', () => {
  it('maps each security mode onto nodemailer', () => {
    const base = { host: 'relay', port: 1 } as const;
    expect(smtpOptions({ ...base, security: 'tls' })).toMatchObject({ secure: true, requireTLS: false, ignoreTLS: false });
    expect(smtpOptions({ ...base, security: 'starttls' })).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false });
    expect(smtpOptions({ ...base, security: 'opportunistic' })).toMatchObject({ secure: false, requireTLS: false, ignoreTLS: false });
    expect(smtpOptions({ ...base, security: 'none' })).toMatchObject({ secure: false, requireTLS: false, ignoreTLS: true });
  });

  it('passes credentials and the EHLO name, and forbids file and URL access', () => {
    const options = smtpOptions(parseSmtpUrl('smtp://u:p@relay:2525/mail.example.eu?tls=required'));
    expect(options).toMatchObject({
      host: 'relay',
      port: 2525,
      auth: { user: 'u', pass: 'p' },
      name: 'mail.example.eu',
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    expect(smtpOptions(parseSmtpUrl('smtp://relay'))).not.toHaveProperty('auth');
  });
});

describe('message mapping', () => {
  it('maps every field onto nodemailer (JSON transport)', async () => {
    const transporter = createTransport({ jsonTransport: true });
    const info = await transporter.sendMail(smtpMessage(sample));
    const json = JSON.parse(info.message as unknown as string);

    expect(json.from).toEqual({ name: 'WeldCalendar', address: 'notifications@mail.weldsuite.org' });
    expect(json.to).toEqual([{ name: 'Guest', address: 'guest@example.com' }, { name: '', address: 'second@example.com' }]);
    expect(json.cc).toEqual([{ name: 'Copy', address: 'cc@example.com' }]);
    expect(json.bcc).toEqual([{ name: '', address: 'hidden@example.com' }]);
    // The display name loses what would break the header, as formatMailbox does.
    expect(json.replyTo).toEqual([{ name: 'Host The Boss x', address: 'host@acme.com' }]);
    expect(json.subject).toBe('Planning on Friday');
    expect(json.text).toBe('Hello Guest');
    expect(json.html).toBe('<p>Hello <strong>Guest</strong></p>');
    expect(json.headers).toEqual(sample.headers);
    expect(json.attachments).toHaveLength(2);
    expect(json.attachments[0]).toMatchObject({
      filename: 'invite.ics',
      contentType: 'text/calendar; method=REQUEST; charset=UTF-8',
    });
    expect(json.attachments[1]).toMatchObject({ filename: 'data.bin', contentType: 'application/octet-stream' });
    expect(Buffer.from(json.attachments[1].content, 'base64')).toEqual(Buffer.from([0, 1, 2, 253, 254, 255]));
    expect(info.envelope).toEqual({
      from: 'notifications@mail.weldsuite.org',
      to: ['guest@example.com', 'second@example.com', 'cc@example.com', 'hidden@example.com'],
    });
  });

  // The stream transport keeps the Bcc header (it hands messages to sendmail);
  // the SMTP transport drops it, which the relay tests below check.
  it('builds the MIME message: alternatives inside mixed, attachments intact (stream transport)', async () => {
    const transporter = createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const info = await transporter.sendMail(smtpMessage(sample));
    const raw = (info.message as Buffer).toString('utf8');
    const [head = ''] = raw.split('\n\n');

    expect(head).toMatch(/^From: WeldCalendar <notifications@mail\.weldsuite\.org>$/m);
    expect(head).toMatch(/^To: Guest <guest@example\.com>, second@example\.com$/m);
    expect(head).toMatch(/^Cc: Copy <cc@example\.com>$/m);
    expect(head).toMatch(/^Reply-To: Host The Boss x <host@acme\.com>$/m);
    expect(head).toMatch(/^Subject: Planning on Friday$/m);
    expect(head).toMatch(/^List-Unsubscribe: <https:\/\/app\.weldsuite\.org\/unsubscribe>$/m);
    expect(head).toMatch(/^X-Entity-Ref-ID: evt_1$/m);
    expect(head).toMatch(/^Message-ID: <.+@mail\.weldsuite\.org>$/m);
    expect(head).toMatch(/^Content-Type: multipart\/mixed;/m);

    expect(raw).toMatch(/^Content-Type: multipart\/alternative;/m);
    expect(raw.indexOf('Content-Type: text/plain')).toBeLessThan(raw.indexOf('Content-Type: text/html'));
    expect(raw).toMatch(/^Content-Type: text\/calendar; method=REQUEST; charset=UTF-8; name=invite\.ics$/m);
    expect(raw).toMatch(/^Content-Disposition: attachment; filename=invite\.ics$/m);
    const ics = /filename=invite\.ics\n\n([A-Za-z0-9+/=\n]+?)\n--/.exec(raw)?.[1];
    expect(Buffer.from(ics ?? '', 'base64').toString('utf8')).toBe(sample.attachments![0]!.content);
    expect(raw).toMatch(/^Content-Type: application\/octet-stream; name=data\.bin$/m);
    expect(raw).toContain(Buffer.from([0, 1, 2, 253, 254, 255]).toString('base64'));
  });

  it('encodes non-ASCII names and subjects', async () => {
    const transporter = createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const info = await transporter.sendMail(
      smtpMessage({ ...sample, from: { email: 'a@b.test', name: 'Zoë Ünal' }, subject: 'Vergadering ☕' }),
    );
    const raw = (info.message as Buffer).toString('utf8');
    expect(raw).toMatch(/^From: =\?UTF-8\?Q\?.+\?= <a@b\.test>$/m);
    expect(raw).toMatch(/^Subject: =\?UTF-8\?/m);
  });

  it('reports the message id and the refused recipients', async () => {
    const transport = nodemailerTransport({
      sendMail: async () => ({ messageId: '<abc@mail.weldsuite.org>', rejected: ['gone@example.com', { address: 'x@example.com' }] }),
    } as unknown as Transporter);
    expect(await transport.send(sample)).toEqual({
      messageId: '<abc@mail.weldsuite.org>',
      transport: 'smtp',
      rejected: ['gone@example.com', 'x@example.com'],
    });
  });
});

interface Session {
  /** Every command's verb, in order. */
  verbs: string[];
  ehlo?: string;
  auth?: string;
  mailFrom?: string;
  rcptTo: string[];
  data?: string;
}

/**
 * A minimal SMTP server on plain TCP with AUTH PLAIN. Refuses the addresses in
 * `reject` with 550 5.1.1. With `starttls` it advertises STARTTLS, but cannot
 * do it (454).
 */
async function fakeRelay({ reject = [], starttls = false }: { reject?: string[]; starttls?: boolean } = {}) {
  const sessions: Session[] = [];
  const server = createServer((socket) => {
    const session: Session = { verbs: [], rcptTo: [] };
    sessions.push(session);
    let buffer = '';
    let inData = false;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          session.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          reply('250 2.0.0 queued as fake');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.split(' ')[0]!.toUpperCase();
        session.verbs.push(verb);
        if (verb === 'EHLO') {
          session.ehlo = line.slice(5);
          reply('250-fake.relay');
          if (starttls) reply('250-STARTTLS');
          reply('250-AUTH PLAIN LOGIN');
          reply('250 8BITMIME');
        } else if (verb === 'AUTH') {
          session.auth = line.slice(5);
          reply('235 2.7.0 accepted');
        } else if (verb === 'MAIL') {
          session.mailFrom = /<([^>]*)>/.exec(line)?.[1];
          reply('250 2.1.0 OK');
        } else if (verb === 'RCPT') {
          const to = /<([^>]*)>/.exec(line)?.[1] ?? '';
          if (reject.includes(to)) reply('550 5.1.1 no such user');
          else {
            session.rcptTo.push(to);
            reply('250 2.1.5 OK');
          }
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 go ahead');
        } else if (verb === 'QUIT') {
          reply('221 2.0.0 bye');
          socket.end();
        } else if (verb === 'STARTTLS') {
          reply(starttls ? '454 4.7.0 TLS not available' : '502 5.5.1 not implemented');
        } else if (verb === 'RSET' || verb === 'NOOP') {
          reply('250 OK');
        } else {
          reply('502 5.5.1 not implemented');
        }
      }
    });
    reply('220 fake.relay ESMTP');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    sessions,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

describe('smtpTransport against a relay', () => {
  let relay: Awaited<ReturnType<typeof fakeRelay>> | undefined;
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it('logs in, names itself in EHLO and delivers to every envelope recipient', async () => {
    relay = await fakeRelay();
    const transport = smtpTransport({ url: `smtp://relay%40user:s%3Acret@127.0.0.1:${relay.port}/mail.example.eu` });
    const result = await transport.send(sample);

    expect(result).toMatchObject({ transport: 'smtp' });
    expect(result.messageId).toMatch(/^<.+@mail\.weldsuite\.org>$/);
    expect(result.rejected).toBeUndefined();
    const [session] = relay.sessions;
    expect(session?.ehlo).toBe('mail.example.eu');
    expect(session?.auth?.startsWith('PLAIN ')).toBe(true);
    expect(Buffer.from(session!.auth!.slice(6), 'base64').toString('utf8')).toBe('\0relay@user\0s:cret');
    expect(session?.mailFrom).toBe('notifications@mail.weldsuite.org');
    expect(session?.rcptTo).toEqual(['guest@example.com', 'second@example.com', 'cc@example.com', 'hidden@example.com']);
    expect(session?.data).toContain(`Message-ID: ${result.messageId}`);
    expect(session?.data).not.toContain('hidden@example.com');
  });

  it('delivers to the rest and reports the recipients the relay refused', async () => {
    relay = await fakeRelay({ reject: ['second@example.com'] });
    const result = await smtpTransport({ url: `smtp://127.0.0.1:${relay.port}` }).send(sample);
    expect(result.rejected).toEqual(['second@example.com']);
    expect(relay.sessions[0]?.auth).toBeUndefined();
    expect(relay.sessions[0]?.rcptTo).toEqual(['guest@example.com', 'cc@example.com', 'hidden@example.com']);
  });

  it('stays plain on smtp:// even when the relay offers STARTTLS, as lettre does', async () => {
    relay = await fakeRelay({ starttls: true });
    await smtpTransport({ url: `smtp://127.0.0.1:${relay.port}` }).send(sample);
    expect(relay.sessions[0]?.verbs).not.toContain('STARTTLS');
    expect(relay.sessions[0]?.data).toBeDefined();
  });

  it.each([false, true])(
    'with tls=required, tries STARTTLS and sends nothing in the clear when it fails (advertised: %s)',
    async (starttls) => {
      relay = await fakeRelay({ starttls });
      await expect(
        smtpTransport({ url: `smtp://u:p@127.0.0.1:${relay.port}?tls=required` }).send(sample),
      ).rejects.toThrow();
      expect(relay.sessions).toHaveLength(1);
      expect(relay.sessions[0]?.verbs.slice(0, 2)).toEqual(['EHLO', 'STARTTLS']);
      expect(relay.sessions[0]?.verbs).not.toContain('AUTH');
      expect(relay.sessions[0]?.verbs).not.toContain('MAIL');
    },
  );
});

describe('transportFromNodeEnv', () => {
  let relay: Awaited<ReturnType<typeof fakeRelay>> | undefined;
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  const cloudflare = { CF_ACCOUNT_ID: 'acc', CF_EMAIL_SEND_TOKEN: 'tok', RESEND_API_KEY: 're_x' };

  it('prefers SMTP_URL over Cloudflare and Resend', () => {
    expect(transportFromNodeEnv({ ...cloudflare, SMTP_URL: 'smtp://mailpit:1025' })?.name).toBe('smtp');
  });

  it('falls back to transportFromEnv without SMTP_URL', () => {
    expect(transportFromNodeEnv(cloudflare)?.name).toBe('cloudflare-rest');
    expect(transportFromNodeEnv({ ...cloudflare, SMTP_URL: '  ' })?.name).toBe('cloudflare-rest');
    expect(transportFromNodeEnv({ RESEND_API_KEY: 're_x' })?.name).toBe('resend');
    expect(transportFromNodeEnv({})).toBeUndefined();
  });

  it('throws on a malformed SMTP_URL instead of skipping mail', () => {
    expect(() => transportFromNodeEnv({ SMTP_URL: 'mailpit:1025' })).toThrow(/SMTP_URL/);
  });

  it('sends from SYSTEM_EMAIL_FROM when it is set', async () => {
    relay = await fakeRelay();
    const transport = transportFromNodeEnv({
      SMTP_URL: `smtp://127.0.0.1:${relay.port}`,
      SYSTEM_EMAIL_FROM: 'noreply@weldsuite.example.eu',
    });
    await transport!.send(sample);
    expect(relay.sessions[0]?.mailFrom).toBe('noreply@weldsuite.example.eu');
    expect(relay.sessions[0]?.data).toMatch(/^From: WeldCalendar <noreply@weldsuite\.example\.eu>$/m);
  });
});

/**
 * Workers import `./env` (and the package root, and `./binding`): none of them
 * may reach nodemailer or the SMTP modules. `./env` must not reach a Node
 * built-in either. Walks the package's own relative imports; type-only
 * imports are erased, so they do not count.
 */
describe('Worker-safe entries', () => {
  const src = resolve(__dirname, '..');

  function resolveLocal(from: string, spec: string): string | undefined {
    const base = resolve(dirname(from), spec);
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(
      (candidate) => existsSync(candidate) && /\.tsx?$/.test(candidate),
    );
  }

  function walk(entry: string): { files: Set<string>; packages: Set<string> } {
    const files = new Set<string>();
    const packages = new Set<string>();
    const pending = [entry];
    const pattern =
      /^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;
    while (pending.length) {
      const file = pending.pop()!;
      if (files.has(file)) continue;
      files.add(file);
      for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
        if (match[2]) continue; // `import type … from`: erased
        const spec = (match[3] ?? match[4])!;
        if (spec.startsWith('.')) {
          const local = resolveLocal(file, spec);
          if (local) pending.push(local);
        } else {
          packages.add(spec);
        }
      }
    }
    return { files, packages };
  }

  const isNodeOnly = (spec: string) =>
    spec.startsWith('node:') || builtinModules.includes(spec) || spec === 'nodemailer' || spec.startsWith('nodemailer/');
  const isSmtpModule = (file: string) => /[\\/]transports[\\/](smtp|node-env)\.ts$/.test(file);

  it('finds nodemailer from node-env.ts (the walk works)', () => {
    const { files, packages } = walk(resolve(src, 'transports/node-env.ts'));
    expect([...files].some(isSmtpModule)).toBe(true);
    expect(packages.has('nodemailer')).toBe(true);
  });

  it('transports/env.ts imports nothing Node-only', () => {
    const { files, packages } = walk(resolve(src, 'transports/env.ts'));
    expect([...files].filter(isSmtpModule)).toEqual([]);
    expect([...packages].filter(isNodeOnly)).toEqual([]);
  });

  it.each(['index.ts', 'transports/binding.ts'])('%s does not reach the SMTP transport', (entry) => {
    const { files, packages } = walk(resolve(src, entry));
    expect([...files].filter(isSmtpModule)).toEqual([]);
    expect([...packages].filter((p) => p === 'nodemailer' || p.startsWith('nodemailer/'))).toEqual([]);
  });
});
