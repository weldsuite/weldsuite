/**
 * Contract tests for `@weldsuite/email`'s Cloudflare Email Routing + Email
 * Sending client, which app-api drives through `lib/cloudflare-email.ts` when
 * provisioning a customer domain for mail.
 *
 * The client moved from hand-written paths to the official `cloudflare` SDK.
 * These pin the two things that migration could plausibly break: the routes and
 * payloads that reach the wire, and the transient/permanent error split that
 * callers retry on. The `email` package has no test runner of its own, so the
 * tests live here — app-api already depends on the package and runs vitest.
 *
 * The stub is injected through the client's `fetch` option; the SDK captures
 * its own `fetch` reference, so stubbing `globalThis.fetch` would not intercept
 * it and the test would hit api.cloudflare.com for real.
 */

import { describe, it, expect } from 'vitest';
import {
  CloudflareApiClient,
  type CloudflareFetch,
} from '@weldsuite/email/providers/cloudflare';
import { PermanentProviderError, TransientProviderError } from '@weldsuite/email/core/errors';

type FetchCall = { url: string; method: string | undefined; body: unknown };

function withResponse(status: number, body: unknown) {
  const calls: FetchCall[] = [];
  const fetchStub: CloudflareFetch = async (input, init) => {
    const req = init as RequestInit | undefined;
    calls.push({
      url: String(input instanceof Request ? input.url : input),
      method: req?.method,
      body: req?.body ? JSON.parse(String(req.body)) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { client: new CloudflareApiClient('tok_test', fetchStub), calls };
}

const ok = (result: unknown) => ({ success: true, errors: [], messages: [], result });

const settings = {
  id: 'zone-tag',
  enabled: true,
  name: 'example.com',
  tag: 'zone-tag',
  status: 'ready',
  created: '2026-07-26T00:00:00Z',
  modified: '2026-07-26T00:00:00Z',
  skip_wizard: false,
};

describe('Email Routing settings', () => {
  it('enables routing on the zone', async () => {
    const { client, calls } = withResponse(200, ok(settings));

    const result = await client.enableRouting('zone_1');

    expect(calls[0]!.url).toContain('/zones/zone_1/email/routing/enable');
    expect(calls[0]!.method).toBe('POST');
    expect(result).toMatchObject({ enabled: true, name: 'example.com', status: 'ready' });
  });

  it('disables routing on the zone', async () => {
    const { client, calls } = withResponse(200, ok({ ...settings, enabled: false }));

    await client.disableRouting('zone_1');

    expect(calls[0]!.url).toContain('/zones/zone_1/email/routing/disable');
    expect(calls[0]!.method).toBe('POST');
  });

  it('reads the settings a domain verification checks', async () => {
    const { client, calls } = withResponse(200, ok(settings));

    const result = await client.getRoutingSettings('zone_1');

    expect(calls[0]!.url).toMatch(/\/zones\/zone_1\/email\/routing$/);
    expect(result.status).toBe('ready');
  });

  it('keeps a status Cloudflare reports that the old type did not model', async () => {
    const { client } = withResponse(200, ok({ ...settings, status: 'misconfigured/locked' }));
    await expect(client.getRoutingSettings('zone_1')).resolves.toMatchObject({
      status: 'misconfigured/locked',
    });
  });
});

describe('Email Routing DNS', () => {
  // The zone apex answers with a bare record array...
  it('normalizes the apex response shape', async () => {
    const { client, calls } = withResponse(
      200,
      ok([
        { type: 'MX', name: 'example.com', content: 'route1.mx.cloudflare.net', priority: 12, ttl: 1 },
        { type: 'TXT', name: 'example.com', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' },
      ]),
    );

    const records = await client.getRoutingDns('zone_1');

    expect(calls[0]!.url).toContain('/zones/zone_1/email/routing/dns');
    expect(records).toEqual([
      {
        type: 'MX',
        name: 'example.com',
        content: 'route1.mx.cloudflare.net',
        priority: 12,
        ttl: 1,
      },
      {
        type: 'TXT',
        name: 'example.com',
        content: 'v=spf1 include:_spf.mx.cloudflare.net ~all',
        priority: undefined,
        ttl: undefined,
      },
    ]);
  });

  // ...but a subdomain query answers with a nested `{ errors, record }` object,
  // where `errors` lists unpropagated records rather than failures.
  it('normalizes the subdomain query response shape', async () => {
    const { client, calls } = withResponse(200, {
      success: true,
      errors: [],
      messages: [],
      result: {
        errors: [{ code: 'missing', missing: {} }],
        record: [{ type: 'MX', name: 'sub.example.com', content: 'route1.mx.cloudflare.net' }],
      },
    });

    const records = await client.getRoutingDns('zone_1', 'sub.example.com');

    expect(calls[0]!.url).toContain('subdomain=sub.example.com');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: 'MX', name: 'sub.example.com' });
  });

  it('registers a subdomain for routing', async () => {
    const { client, calls } = withResponse(200, ok(settings));

    await client.configureRoutingDns('zone_1', 'sub.example.com');

    expect(calls[0]!.url).toContain('/zones/zone_1/email/routing/dns');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ name: 'sub.example.com' });
  });
});

describe('Email Routing catch-all', () => {
  it('points the catch-all at the inbound worker', async () => {
    const { client, calls } = withResponse(
      200,
      ok({
        id: 'rule_1',
        enabled: true,
        matchers: [{ type: 'all' }],
        actions: [{ type: 'worker', value: ['weldsuite-mail-inbound'] }],
      }),
    );

    const rule = await client.putCatchAll('zone_1', {
      enabled: true,
      matchers: [{ type: 'all' }],
      actions: [{ type: 'worker', value: ['weldsuite-mail-inbound'] }],
    });

    expect(calls[0]!.url).toContain('/zones/zone_1/email/routing/rules/catch_all');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.body).toEqual({
      matchers: [{ type: 'all' }],
      actions: [{ type: 'worker', value: ['weldsuite-mail-inbound'] }],
      enabled: true,
    });
    expect(rule.id).toBe('rule_1');
  });
});

describe('Email Sending subdomains', () => {
  it('lists the authorised sending subdomains', async () => {
    const { client, calls } = withResponse(
      200,
      ok([
        { tag: 'tag_1', name: 'example.com', enabled: true, dkim_selector: 'cf2024-1' },
        { tag: 'tag_2', name: 'send.example.com', enabled: false },
      ]),
    );

    const subdomains = await client.listSendingSubdomains('zone_1');

    expect(calls[0]!.url).toContain('/zones/zone_1/email/sending/subdomains');
    expect(subdomains.map((s) => s.name)).toEqual(['example.com', 'send.example.com']);
    expect(subdomains[0]).toMatchObject({ tag: 'tag_1', enabled: true, dkim_selector: 'cf2024-1' });
  });

  it('authorises a domain for outbound sending', async () => {
    const { client, calls } = withResponse(
      200,
      ok({ tag: 'tag_1', name: 'example.com', enabled: true }),
    );

    await client.createSendingSubdomain('zone_1', 'example.com');

    expect(calls[0]!.url).toContain('/zones/zone_1/email/sending/subdomains');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ name: 'example.com' });
  });

  it('deletes by tag, not by name', async () => {
    const { client, calls } = withResponse(200, ok({}));

    await client.deleteSendingSubdomain('zone_1', 'tag_1');

    expect(calls[0]!.url).toContain('/zones/zone_1/email/sending/subdomains/tag_1');
    expect(calls[0]!.method).toBe('DELETE');
  });
});

describe('error classification', () => {
  it('treats a 4xx as permanent so callers stop retrying', async () => {
    const { client } = withResponse(403, {
      success: false,
      errors: [{ code: 10000, message: 'Authentication error' }],
      result: null,
    });

    const err = await client.getRoutingSettings('zone_1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PermanentProviderError);
    expect((err as Error).message).toContain('10000:Authentication error');
  });

  it('treats a 5xx as transient', async () => {
    const { client } = withResponse(503, {
      success: false,
      errors: [{ code: 1, message: 'Service unavailable' }],
      result: null,
    });

    // maxRetries exhausts first, then the final failure surfaces as transient.
    const err = await client.getRoutingSettings('zone_1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransientProviderError);
  });

  it('treats a 429 as transient', async () => {
    const { client } = withResponse(429, {
      success: false,
      errors: [{ code: 971, message: 'Rate limited' }],
      result: null,
    });

    await expect(client.getRoutingSettings('zone_1')).rejects.toBeInstanceOf(
      TransientProviderError,
    );
  });
});
