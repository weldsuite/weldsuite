/**
 * A `fetch` stand-in for the third parties reach-api calls: Mailpool's REST
 * API, billing-worker (`/api/billing/reach/*`) and the DNS-over-HTTPS
 * resolver. It answers by method, URL and body only, never by call order,
 * so in conformance mode the same stub answers both backends (the Rust
 * server's calls reach it through the harness's outbound bridge). Every other
 * URL (the harness's own loopback calls) goes to the real fetch.
 *
 * A test shapes the world through `world` before its requests: Mailpool's
 * slots, a mailbox create's status, refusals by path, DNS answers by name.
 */

import { vi } from 'vitest';
import { BILLING_WORKER_TEST_URL } from '@weldsuite/worker-kit/billing-worker';
import { MAILPOOL_DEFAULT_BASE_URL } from '../lib/mailpool/client';
import { dohResponse } from '../lib/mailpool/testing-routes';

/** The worker env that turns Mailpool and the warmup network on. */
export const MAILPOOL_ENV = {
  ENVIRONMENT: 'test',
  MAILPOOL_API_KEY: 'mp-test-key',
  REACH_INBOUND_DOMAIN: 'reply-test.weldreach.com',
  DATABASE_ENCRYPTION_KEY: 'ab'.repeat(32),
};

export interface StubWorld {
  /** Mailpool `GET /subscriptions/slots`. */
  slots: { mailboxes: Record<string, number>; slots: Record<string, number> };
  /** The status a created mailbox comes back with, and whether it carries logins. */
  createStatus: 'active' | 'pending' | 'inactive';
  createWithLogins: boolean;
  /** Mailpool answers by `METHOD /path`: a status and a body instead of the default. */
  refusals: Record<string, { status: number; body: unknown }>;
  /** Domains Mailpool skips on a Cloudflare connect, with the reason. */
  skippedDomains: Record<string, string>;
  /** Mailpool `GET /domains/:id`'s status and `GET /domains/:id/dns`'s records. */
  remoteDomainStatus: 'active' | 'pending' | 'inactive';
  domainDns: Array<Record<string, unknown>>;
  /** billing-worker's answer by path (`/inboxes`, `/status`, `/setup`). */
  billing: Record<string, { status: number; body: unknown }>;
  /** DNS answers by `name TYPE`; anything else answers no records. `null` fails the lookup. */
  dns: Record<string, string[] | null>;
}

export function defaultWorld(): StubWorld {
  return {
    slots: { mailboxes: { google: 3 }, slots: { google: 3 } },
    createStatus: 'active',
    createWithLogins: true,
    refusals: {},
    skippedDomains: {},
    remoteDomainStatus: 'active',
    domainDns: [],
    billing: {
      '/inboxes': { status: 200, body: { data: { quantity: 1 } } },
      '/status': {
        status: 200,
        body: {
          data: { status: 'active', hasPaymentMethod: true, inboxCount: 1, unitAmountCents: 500, currency: 'usd', currentPeriodEnd: null },
        },
      },
      '/setup': { status: 200, body: { data: { url: 'https://checkout.stripe.test/s/1' } } },
    },
    dns: {},
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A stable number for a text: Mailpool's ids are numbers. */
function idOf(text: string): number {
  let hash = 7;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 900_000;
  return 100_000 + hash;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function mailpool(world: StubWorld, method: string, url: URL, body: unknown): Response {
  const path = url.pathname.replace(/^\/v1\/api/, '');
  const refusal = world.refusals[`${method} ${path}`];
  if (refusal) return json(refusal.body, refusal.status);
  if (method === 'GET' && path === '/subscriptions/slots') return json(world.slots);
  if (method === 'POST' && (path === '/subscriptions/increase' || path === '/subscriptions/decrease')) return json({ ok: true });
  if (method === 'POST' && path === '/domains/cloudflare/connect') {
    const domains = ((body as { domains?: string[] }).domains ?? []).map((d) => d.toLowerCase());
    return json({
      connected: domains.filter((d) => !world.skippedDomains[d]).map((d) => ({ id: idOf(d), domain: d, status: 'Active' })),
      skipped: domains.filter((d) => world.skippedDomains[d]).map((d) => ({ domain: d, reason: world.skippedDomains[d] })),
    });
  }
  const domain = /^\/domains\/([^/]+)(\/dns)?$/.exec(path);
  if (domain) {
    if (method === 'DELETE') return json({ id: domain[1], domain: 'example.test', status: 'inactive' });
    if (domain[2]) return json(world.domainDns);
    return json({
      id: domain[1],
      domain: 'example.test',
      status: world.remoteDomainStatus,
      ...(world.remoteDomainStatus === 'inactive' ? { error: { code: 1, message: 'Domain suspended' } } : {}),
    });
  }
  if (method === 'POST' && path === '/mailboxes') {
    const input = ((body as unknown[]) ?? [])[0] as { email: string; firstName: string; lastName: string; type: string };
    const logins = world.createWithLogins
      ? {
          smtpHost: 'smtp.mailpool.test',
          smtpPort: input.type === 'google' ? 465 : '587',
          smtpTLS: true,
          smtpUsername: input.email,
          smtpPassword: 'smtp-secret-password',
          imapHost: 'imap.mailpool.test',
          imapPort: 993,
          imapTLS: true,
          imapUsername: input.email,
          imapPassword: 'imap-secret-password',
        }
      : {};
    return json({
      emails: [
        {
          id: idOf(input.email),
          type: input.type,
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          status: world.createStatus,
          ...(world.createStatus === 'inactive' ? { error: { code: 1, message: 'Mailbox could not be activated' } } : {}),
          ...logins,
        },
      ],
    });
  }
  if (method === 'GET' && path === '/mailboxes') return json({ data: [], total: 0 });
  const mailbox = /^\/mailboxes\/([^/]+)$/.exec(path);
  if (mailbox) return json({ id: mailbox[1], type: 'google', email: 'x@example.test', status: method === 'DELETE' ? 'inactive' : 'active' });
  return json({ message: 'Not found' }, 404);
}

function billing(world: StubWorld, path: string): Response {
  const answer = world.billing[path.replace('/api/billing/reach', '')];
  return answer ? json(answer.body, answer.status) : json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
}

function dns(world: StubWorld, url: URL): Response {
  const name = url.searchParams.get('name') ?? '';
  const type = url.searchParams.get('type') ?? '';
  const values = world.dns[`${name} ${type}`];
  if (values === null) return new Response('resolver down', { status: 503 });
  return dohResponse(name, type, values ?? []);
}

/** The stub and its world; install it with `vi.stubGlobal('fetch', stub.fetch)`. */
export function createHttpStubs() {
  const realFetch = globalThis.fetch;
  const world = defaultWorld();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = urlOf(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const text = typeof init?.body === 'string' ? init.body : '';
    const body: unknown = text ? JSON.parse(text) : undefined;
    if (href.startsWith(`${MAILPOOL_DEFAULT_BASE_URL}/`)) return mailpool(world, method, new URL(href), body);
    if (href.startsWith(`${BILLING_WORKER_TEST_URL}/`)) return billing(world, new URL(href).pathname);
    if (href.startsWith('https://cloudflare-dns.com/dns-query')) return dns(world, new URL(href));
    return realFetch(input, init);
  });
  /** The calls that reached `prefix` (Mailpool, billing-worker), as `METHOD path`. */
  const calls = (prefix: string) =>
    fetch.mock.calls
      .map(([input, init]) => [urlOf(input as RequestInfo), ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase()] as const)
      .filter(([href]) => href.startsWith(prefix))
      .map(([href, method]) => `${method} ${new URL(href).pathname}`);
  return { fetch, world, calls };
}
