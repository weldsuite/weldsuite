import { describe, expect, it, vi } from 'vitest';
import { icsAttachment } from './ics';
import { SYSTEM_FROM_ADDRESS, sendSystemEmail } from './send';
import { bindingTransport, workerTransport } from './transports/binding';
import { memoryTransport } from './transports/memory';
import { resendTransport } from './transports/resend';
import { restTransport } from './transports/rest';
import type { OutgoingEmail } from './transport';

const invite = {
  template: 'calendar.event' as const,
  props: { kind: 'invite' as const, organizerName: 'Sanne', title: 'Planning' },
};

const ics = icsAttachment({ uid: 'evt_1@weldsuite.org', title: 'Planning', attendees: [] });

const sample: OutgoingEmail = {
  from: { email: SYSTEM_FROM_ADDRESS, name: 'WeldCalendar' },
  to: [{ email: 'guest@example.com', name: 'Guest' }],
  replyTo: { email: 'host@acme.com', name: 'Host' },
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
  attachments: [ics],
};

describe('sendSystemEmail', () => {
  it('always sends from the system address, named after the module by default', async () => {
    const transport = memoryTransport();
    await sendSystemEmail(transport, { ...invite, to: 'guest@example.com' });
    expect(transport.sent[0].from).toEqual({ email: SYSTEM_FROM_ADDRESS, name: 'WeldCalendar' });
  });

  it('names the sender after the workspace for a workspace brand, or after fromName', async () => {
    const transport = memoryTransport();
    await sendSystemEmail(transport, {
      ...invite,
      to: 'guest@example.com',
      brand: { kind: 'workspace', name: 'Acme' },
    });
    await sendSystemEmail(transport, { ...invite, to: 'guest@example.com', fromName: 'Mark via Acme' });
    expect(transport.sent.map((e) => e.from.name)).toEqual(['Acme', 'Mark via Acme']);
  });

  it('renders the template in the locale and passes reply-to, attachments and headers', async () => {
    const transport = memoryTransport();
    await sendSystemEmail(transport, {
      ...invite,
      to: [{ email: ' guest@example.com ', name: 'Guest' }],
      locale: 'nl',
      replyTo: 'host@acme.com',
      attachments: [ics],
      headers: { 'X-Entity-Ref-ID': 'evt_1' },
    });
    const sent = transport.sent[0];
    expect(sent.to).toEqual([{ email: 'guest@example.com', name: 'Guest' }]);
    expect(sent.subject).toBe('Uitnodiging: Planning');
    expect(sent.html).toContain('heeft je uitgenodigd');
    expect(sent.text).toContain('heeft je uitgenodigd');
    expect(sent.replyTo).toEqual({ email: 'host@acme.com' });
    expect(sent.attachments).toEqual([ics]);
    expect(sent.headers).toEqual({ 'X-Entity-Ref-ID': 'evt_1' });
  });

  it('refuses to send without recipients', async () => {
    await expect(sendSystemEmail(memoryTransport(), { ...invite, to: ['  '] })).rejects.toThrow(/no recipients/);
  });
});

describe('bindingTransport', () => {
  it('sends one raw MIME message per recipient through the binding', async () => {
    const send = vi.fn(async () => {});
    const result = await bindingTransport({ send } as never).send({
      ...sample,
      cc: [{ email: 'cc@example.com' }],
    });
    expect(send).toHaveBeenCalledTimes(2);
    const message = (send.mock.calls[0] as unknown as [{ from: string; to: string; raw: string }])[0];
    expect(message.to).toBe('guest@example.com');
    // mimetext writes the display name as an RFC 2047 encoded word.
    expect(message.raw).toMatch(/^Reply-To: \S+ <host@acme\.com>/m);
    expect(message.raw).toContain('text/calendar');
    expect(result.transport).toBe('cloudflare-binding');
    expect(result.messageId).toMatch(/@mail\.weldsuite\.org>$/);
  });

  it('reports recipients Cloudflare does not allow instead of failing the rest', async () => {
    const send = vi.fn(async (message: { to: string }) => {
      if (message.to === 'guest@example.com') throw Object.assign(new Error('nope'), { code: 'E_RECIPIENT_NOT_ALLOWED' });
    });
    const result = await bindingTransport({ send } as never).send({
      ...sample,
      cc: [{ email: 'cc@example.com' }],
    });
    expect(result.rejected).toEqual(['guest@example.com']);
  });
});

describe('workerTransport', () => {
  const binding = { send: async () => {} } as never;

  it('uses the binding by default and Resend only when switched to it', () => {
    expect(workerTransport({ SEND_EMAIL: binding })?.name).toBe('cloudflare-binding');
    expect(workerTransport({ SEND_EMAIL: binding, EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'k' })?.name).toBe('resend');
    expect(workerTransport({ SEND_EMAIL: binding, EMAIL_TRANSPORT: 'resend' })?.name).toBe('cloudflare-binding');
    expect(workerTransport({})).toBeUndefined();
  });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('restTransport', () => {
  it('posts to the Email Sending API with base64 attachments', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: { delivered: ['guest@example.com'], permanent_bounces: [], queued: [], message_id: 'msg_1' },
      }),
    );
    const result = await restTransport({ accountId: 'acc_1', apiToken: 'tok', fetch: fetch as never }).send(sample);

    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://api.cloudflare.com/client/v4/accounts/acc_1/email/sending/send');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');
    const body = JSON.parse(String(init?.body));
    expect(body.from).toEqual({ address: SYSTEM_FROM_ADDRESS, name: 'WeldCalendar' });
    expect(body.to).toEqual(['guest@example.com']);
    expect(body.reply_to).toEqual({ address: 'host@acme.com', name: 'Host' });
    expect(body.attachments[0]).toMatchObject({ filename: 'invite.ics', type: 'text/calendar', disposition: 'attachment' });
    expect(atob(body.attachments[0].content)).toContain('BEGIN:VCALENDAR');
    expect(result).toEqual({ messageId: 'msg_1', transport: 'cloudflare-rest' });
  });

  it('reports permanent bounces', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: { delivered: [], permanent_bounces: ['guest@example.com'], queued: [], message_id: 'msg_2' },
      }),
    );
    const result = await restTransport({ accountId: 'acc_1', apiToken: 'tok', fetch: fetch as never }).send(sample);
    expect(result.rejected).toEqual(['guest@example.com']);
  });
});

describe('resendTransport', () => {
  it('posts the Resend payload and throws on an error status', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ id: 're_1' }));
    const result = await resendTransport({ apiKey: 'key', fetch: fetch as never }).send(sample);
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body.from).toBe(`"WeldCalendar" <${SYSTEM_FROM_ADDRESS}>`);
    expect(body.reply_to).toBe('"Host" <host@acme.com>');
    expect(atob(body.attachments[0].content)).toContain('BEGIN:VCALENDAR');
    expect(result).toEqual({ messageId: 're_1', transport: 'resend' });

    const failing = vi.fn(async () => new Response('bad', { status: 422 }));
    await expect(resendTransport({ apiKey: 'key', fetch: failing as never }).send(sample)).rejects.toThrow(/422/);
  });
});
