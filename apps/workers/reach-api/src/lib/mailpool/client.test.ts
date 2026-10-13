import { describe, expect, it, vi } from 'vitest';
import {
  createMailpoolClient,
  MAILPOOL_CLOUDFLARE_CONNECT_PATH,
  MAILPOOL_CLOUDFLARE_ZONES_PATH,
  MAILPOOL_DEFAULT_BASE_URL,
} from './client';
import { MailpoolError, MailpoolNotConfiguredError } from './errors';
import { imapCredentialsOf, smtpCredentialsOf } from './index';
import type { MailpoolMailbox } from './types';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function setup(responses: Array<Response | Error>, env: Record<string, string> = { MAILPOOL_API_KEY: 'mp_key' }) {
  const queue = [...responses];
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra request');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async () => {});
  const client = createMailpoolClient(env, { fetch: fetchMock as unknown as typeof fetch, sleep });
  return { client, fetchMock, sleep };
}

describe('createMailpoolClient', () => {
  it('refuses to start without an API key', () => {
    expect(() => createMailpoolClient({})).toThrow(MailpoolNotConfiguredError);
  });

  it('sends the API key header, JSON and the default base URL', async () => {
    const { client, fetchMock } = setup([json({ id: 12, domain: 'getacme.com', status: 'active' })]);
    const domain = await client.getDomain(12);

    expect(domain.domain).toBe('getacme.com');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${MAILPOOL_DEFAULT_BASE_URL}/domains/12`);
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>)['X-Api-Authorization']).toBe('mp_key');
  });

  it('honours MAILPOOL_API_URL and trims a trailing slash', async () => {
    const { client, fetchMock } = setup([json({ slots: {}, mailboxes: {} })], {
      MAILPOOL_API_KEY: 'k',
      MAILPOOL_API_URL: 'https://mock.example.test/v1/',
    });
    await client.getSlots();
    expect(fetchMock.mock.calls[0]![0]).toBe('https://mock.example.test/v1/subscriptions/slots');
  });

  it('url-encodes ids and sends bodies as JSON', async () => {
    const { client, fetchMock } = setup([json({ id: 1 })]);
    await client.updateMailbox('a/b', { firstName: 'Jane', signature: 'Best, Jane' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${MAILPOOL_DEFAULT_BASE_URL}/mailboxes/a%2Fb`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({ firstName: 'Jane', signature: 'Best, Jane' });
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  describe('retries', () => {
    it('retries a GET on 429 and 5xx with backoff, then succeeds', async () => {
      const { client, fetchMock, sleep } = setup([json({}, 429), json({}, 503), json({ id: 3, domain: 'x.com', status: 'active' })]);
      const domain = await client.getDomain(3);

      expect(domain.id).toBe(3);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('stops after 3 retries and throws a typed error', async () => {
      const { client, fetchMock } = setup([json({}, 500), json({}, 500), json({}, 500), json({ message: 'down' }, 500)]);
      const err = await client.getDomain(1).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MailpoolError);
      expect((err as MailpoolError).status).toBe(500);
      expect((err as MailpoolError).retryable).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('does not retry a 4xx', async () => {
      const { client, fetchMock } = setup([json({ message: 'nope' }, 404)]);
      const err = (await client.getMailbox('9').catch((e: unknown) => e)) as MailpoolError;

      expect(err.isNotFound).toBe(true);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('nope');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('honours Retry-After', async () => {
      const { client, sleep } = setup([json({}, 429, { 'Retry-After': '2' }), json({ id: 1, domain: 'x.com', status: 'active' })]);
      await client.getDomain(1);
      expect(sleep).toHaveBeenCalledWith(2000);
    });

    it('does not repeat a POST after a 500 (it may have created a mailbox) or after a network error', async () => {
      const input = { email: 'a@getacme.com', firstName: 'A', lastName: 'B', type: 'google' as const };

      const afterServerError = setup([json({ message: 'boom' }, 500)]);
      await expect(afterServerError.client.createMailbox(input)).rejects.toBeInstanceOf(MailpoolError);
      expect(afterServerError.fetchMock).toHaveBeenCalledTimes(1);

      const afterNetworkError = setup([new TypeError('fetch failed')]);
      const err = (await afterNetworkError.client.createMailbox(input).catch((e: unknown) => e)) as MailpoolError;
      expect(err.status).toBe(0);
      expect(afterNetworkError.fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does repeat a POST that was rate limited (429) or answered 503', async () => {
      const mailbox = { id: '5', type: 'google', email: 'a@getacme.com', status: 'active' };
      const { client, fetchMock } = setup([json({}, 429), json({}, 503), json({ emails: [mailbox] })]);
      const created = await client.createMailbox({ email: 'a@getacme.com', firstName: 'A', lastName: 'B', type: 'google' });

      expect(created.id).toBe('5');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('retries a GET after a network error', async () => {
      const { client, fetchMock } = setup([new TypeError('fetch failed'), json({ slots: { google: 3 }, mailboxes: { google: 1 } })]);
      const slots = await client.getSlots();
      expect(slots.slots.google).toBe(3);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('mailboxes', () => {
    it('posts an array and unwraps the first created mailbox', async () => {
      const { client, fetchMock } = setup([json({ emails: [{ id: '77', type: 'shared', email: 'j@getacme.com', status: 'pending' }] })]);
      const created = await client.createMailbox({
        email: 'j@getacme.com',
        firstName: 'Jane',
        lastName: 'Doe',
        type: 'shared',
        forwardTo: 'abc@reply.weldsuite.org',
      });

      expect(created.id).toBe('77');
      const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as unknown[];
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ email: 'j@getacme.com', forwardTo: 'abc@reply.weldsuite.org', type: 'shared' });
    });

    it('fails clearly when Mailpool returns no mailbox', async () => {
      const { client } = setup([json({ emails: [] })]);
      await expect(client.createMailbox({ email: 'a@b.com', firstName: 'A', lastName: 'B', type: 'google' })).rejects.toMatchObject({
        status: 502,
      });
    });

    it('turns Mailpool logins into stored credentials (string ports for shared mailboxes)', () => {
      const mailbox = {
        id: '1',
        type: 'shared',
        email: 'j@getacme.com',
        status: 'active',
        smtpHost: 'smtp.x.test',
        smtpPort: '587',
        smtpTLS: true,
        smtpUsername: 'j',
        smtpPassword: 'pw',
        imapHost: 'imap.x.test',
        imapPort: '993',
        imapTLS: true,
        imapUsername: 'j',
        imapPassword: 'pw2',
      } satisfies MailpoolMailbox;

      expect(smtpCredentialsOf(mailbox)).toEqual({ host: 'smtp.x.test', port: 587, tls: true, username: 'j', password: 'pw' });
      expect(imapCredentialsOf(mailbox)).toMatchObject({ port: 993, password: 'pw2' });
      expect(smtpCredentialsOf({ ...mailbox, smtpPassword: undefined })).toBeNull();
      expect(smtpCredentialsOf({ ...mailbox, smtpPort: 'abc' })).toBeNull();
    });
  });

  describe('Cloudflare connect', () => {
    it('lists zones and connects domains on the public API base', async () => {
      const zone = { id: 'z1', name: 'getacme.com', status: 'active', nameServers: ['a.ns.cloudflare.com'], alreadyConnected: false, unavailable: false };
      const { client, fetchMock } = setup([
        json({ zones: [zone] }),
        json({
          connected: [{ id: 321, domain: 'getacme.com', status: 'Active', dnsType: 'CloudflareToken' }],
          skipped: [{ domain: 'other.com', reason: 'unavailable' }],
        }),
      ]);

      expect(await client.listCloudflareZones()).toEqual([zone]);
      const result = await client.connectCloudflareDomains(['getacme.com', 'other.com']);

      expect(result.connected[0]).toMatchObject({ id: 321, domain: 'getacme.com' });
      expect(result.skipped).toHaveLength(1);
      expect(fetchMock.mock.calls[0]![0]).toBe(`${MAILPOOL_DEFAULT_BASE_URL}${MAILPOOL_CLOUDFLARE_ZONES_PATH}`);
      expect(fetchMock.mock.calls[1]![0]).toBe(`${MAILPOOL_DEFAULT_BASE_URL}${MAILPOOL_CLOUDFLARE_CONNECT_PATH}`);
      expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ domains: ['getacme.com', 'other.com'] });
    });

    it('never targets the Mailpool web app host', () => {
      expect(MAILPOOL_DEFAULT_BASE_URL).not.toContain('mailpool.ai');
    });
  });

  describe('slots', () => {
    it('reads, increases and decreases subscription slots', async () => {
      const { client, fetchMock } = setup([json({ slots: { google: 5 }, mailboxes: { google: 4 } }), new Response(null, { status: 200 }), new Response(null, { status: 200 })]);

      expect((await client.getSlots()).slots.google).toBe(5);
      await client.increaseSlots('google', 1);
      await client.decreaseSlots('google', 3);

      expect(fetchMock.mock.calls[1]![0]).toBe(`${MAILPOOL_DEFAULT_BASE_URL}/subscriptions/increase`);
      expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ type: 'google', increaseBy: 1 });
      expect(JSON.parse(fetchMock.mock.calls[2]![1]!.body as string)).toEqual({ type: 'google', decreaseBy: 3 });
    });
  });
});
