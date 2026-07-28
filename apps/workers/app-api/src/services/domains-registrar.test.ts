/**
 * Contract tests for the Cloudflare Registrar client behind `/api/domains/search`
 * and `/api/domains/check`.
 *
 * The client used to hand-roll its request paths and decode `result` as a flat
 * array of `{ available, premium, price, currency }`. Cloudflare actually
 * returns `result.domains[]` of `{ name, registrable, pricing: { currency,
 * registration_cost, renewal_cost }, reason?, tier? }`, so every search came
 * back empty or threw. It now goes through the official `cloudflare` SDK, which
 * owns the routes and the response types — these tests pin the wire payloads
 * from the Registrar API beta reference and the translation into our own shape,
 * so an SDK upgrade that moves either one fails here rather than in prod.
 *
 * The stub is injected through the client's `fetch` option: the SDK captures
 * its own `fetch` reference, so stubbing `globalThis.fetch` does not intercept
 * it and the test would hit api.cloudflare.com for real.
 */

import { describe, it, expect } from 'vitest';
import {
  CloudflareApiError,
  CloudflareRegistrar,
  type RegistrarFetch,
} from '@weldsuite/cloudflare-registrar';
import { applyMarkup } from './domains';

type FetchCall = { url: string; init: RequestInit | undefined };

/**
 * Build a registrar wired to a canned response, plus the log of calls it made.
 */
function withResponse(status: number, body: unknown, opts: { raw?: string } = {}) {
  const calls: FetchCall[] = [];
  const fetchStub: RegistrarFetch = async (input, init) => {
    calls.push({
      url: String(input instanceof Request ? input.url : input),
      init: init as RequestInit | undefined,
    });
    return new Response(opts.raw ?? JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const cf = new CloudflareRegistrar({
    accountId: 'acct_test',
    apiToken: 'tok_test',
    fetch: fetchStub,
  });
  return { cf, calls };
}

/** Same, but serving a different response per call, in order. */
function withResponseSequence(bodies: unknown[]) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchStub: RegistrarFetch = async (input, init) => {
    calls.push({
      url: String(input instanceof Request ? input.url : input),
      init: init as RequestInit | undefined,
    });
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const cf = new CloudflareRegistrar({
    accountId: 'acct_test',
    apiToken: 'tok_test',
    fetch: fetchStub,
  });
  return { cf, calls };
}

const okSearch = (domains: unknown[]) => ({ success: true, errors: [], result: { domains } });

describe('CloudflareRegistrar.searchDomains', () => {
  it('calls the domain-search route and maps registrable/pricing/tier', async () => {
    const { cf, calls } = withResponse(
      200,
      okSearch([
        {
          name: 'testddsd.com',
          registrable: true,
          tier: 'standard',
          pricing: { currency: 'USD', registration_cost: '10.44', renewal_cost: '11.20' },
        },
        {
          name: 'testddsd.be',
          registrable: false,
          reason: 'extension_not_supported_via_api',
        },
      ]),
    );

    const results = await cf.searchDomains('testddsd', 20);

    expect(calls[0]!.url).toContain('/accounts/acct_test/registrar/domain-search');
    expect(calls[0]!.url).toContain('q=testddsd');
    expect(calls[0]!.url).toContain('limit=20');

    expect(results).toEqual([
      {
        name: 'testddsd.com',
        available: true,
        premium: false,
        price: 10.44,
        renewalPrice: 11.2,
        currency: 'USD',
        reason: undefined,
      },
      {
        name: 'testddsd.be',
        available: false,
        premium: false,
        price: undefined,
        renewalPrice: undefined,
        currency: undefined,
        reason: 'extension_not_supported_via_api',
      },
    ]);
  });

  it('flags premium tier and keeps the registry price', async () => {
    const { cf } = withResponse(
      200,
      okSearch([
        {
          name: 'gold.com',
          registrable: false,
          reason: 'domain_premium',
          tier: 'premium',
          pricing: { currency: 'USD', registration_cost: '2500.00', renewal_cost: '2500.00' },
        },
      ]),
    );

    const [result] = await cf.searchDomains('gold');
    expect(result).toMatchObject({ premium: true, price: 2500, reason: 'domain_premium' });
  });

  it('returns an empty list when Cloudflare has no suggestions', async () => {
    const { cf } = withResponse(200, okSearch([]));
    await expect(cf.searchDomains('x')).resolves.toEqual([]);
  });

  it('sends the token as a bearer credential', async () => {
    const { cf, calls } = withResponse(200, okSearch([]));
    await cf.searchDomains('x');
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer tok_test');
  });
});

describe('CloudflareRegistrar error reporting', () => {
  it('carries status, code and message on a 403', async () => {
    const { cf } = withResponse(403, {
      success: false,
      errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }],
      result: null,
    });

    const err = await cf.searchDomains('testddsd').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CloudflareApiError);
    const cfErr = err as CloudflareApiError;
    expect(cfErr.status).toBe(403);
    expect(cfErr.code).toBe('9109');
    expect(cfErr.endpoint).toBe('domain-search');
    expect(cfErr.message).toContain('Unauthorized to access requested resource');
    // The account ID must not ride along into a message we log or return.
    expect(cfErr.message).not.toContain('acct_test');
  });

  it('reports a non-JSON edge response as the status it was, not a SyntaxError', async () => {
    const { cf } = withResponse(400, null, { raw: '<html>Bad request</html>' });

    const err = (await cf.searchDomains('testddsd').catch((e: unknown) => e)) as CloudflareApiError;

    expect(err).toBeInstanceOf(CloudflareApiError);
    expect(err.status).toBe(400);
  });
});

describe('CloudflareRegistrar.checkDomains', () => {
  it('posts the domain list to domain-check and decodes result.domains', async () => {
    const { cf, calls } = withResponse(
      200,
      okSearch([
        {
          name: 'weldsuite.dev',
          registrable: true,
          tier: 'standard',
          pricing: { currency: 'USD', registration_cost: '12.00', renewal_cost: '12.00' },
        },
      ]),
    );

    const results = await cf.checkDomains(['weldsuite.dev']);

    expect(calls[0]!.url).toContain('/accounts/acct_test/registrar/domain-check');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ domains: ['weldsuite.dev'] });
    expect(results[0]).toMatchObject({ available: true, price: 12, currency: 'USD' });
  });
});

describe('CloudflareRegistrar.register', () => {
  const workflow = (over: Record<string, unknown>) => ({
    success: true,
    errors: [],
    result: {
      completed: false,
      created_at: '2026-07-26T00:00:00Z',
      updated_at: '2026-07-26T00:00:00Z',
      links: { self: 'https://api.cloudflare.com/.../status' },
      ...over,
    },
  });

  it('posts domain_name and a nested registrant contact', async () => {
    const { cf, calls } = withResponse(200, workflow({ state: 'in_progress' }));

    await cf.register({
      name: 'weldsuite.dev',
      autoRenew: true,
      years: 1,
      contact: {
        firstName: 'Gert',
        lastName: 'van den Berg',
        organization: 'Weld Corporation',
        email: 'info@weldhost.com',
        phone: '+31612345678',
        address1: 'Voorbeeldstraat 1',
        city: 'Amsterdam',
        state: 'NH',
        postalCode: '1011AB',
        country: 'NL',
      },
    });

    expect(calls[0]!.url).toContain('/accounts/acct_test/registrar/registrations');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      domain_name: 'weldsuite.dev',
      auto_renew: true,
      years: 1,
      contacts: {
        registrant: {
          email: 'info@weldhost.com',
          phone: '+31612345678',
          postal_info: {
            name: 'Gert van den Berg',
            organization: 'Weld Corporation',
            address: {
              street: 'Voorbeeldstraat 1',
              city: 'Amsterdam',
              state: 'NH',
              postal_code: '1011AB',
              country_code: 'NL',
            },
          },
        },
      },
    });
  });

  it('omits an incomplete contact so Cloudflare falls back to the account default', async () => {
    const { cf, calls } = withResponse(200, workflow({ state: 'pending' }));
    await cf.register({ name: 'weldsuite.dev', contact: { email: 'info@weldhost.com' } });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ domain_name: 'weldsuite.dev' });
  });

  it('reports a non-terminal workflow as pending', async () => {
    const { cf } = withResponse(200, workflow({ state: 'in_progress' }));
    await expect(cf.register({ name: 'weldsuite.dev' })).resolves.toEqual({
      status: 'pending',
      workflowUrl: 'https://api.cloudflare.com/.../status',
      pollAfter: 5000,
      actionRequired: false,
    });
  });

  it('marks action_required so a polling loop knows to stop', async () => {
    const { cf } = withResponse(200, workflow({ state: 'action_required' }));
    const result = await cf.register({ name: 'weldsuite.dev' });
    expect(result).toMatchObject({ status: 'pending', actionRequired: true });
  });

  it('surfaces the registry error on a failed workflow', async () => {
    const { cf } = withResponse(
      200,
      workflow({
        state: 'failed',
        completed: true,
        error: { code: 'registry_rejected', message: 'Registry rejected the request' },
      }),
    );
    await expect(cf.register({ name: 'weldsuite.dev' })).resolves.toEqual({
      status: 'failed',
      code: 'registry_rejected',
      message: 'Registry rejected the request',
    });
  });

  it('returns the registration once the workflow succeeds', async () => {
    const { cf } = withResponse(
      200,
      workflow({
        state: 'succeeded',
        completed: true,
        context: {
          domain_name: 'weldsuite.dev',
          registration: {
            domain_name: 'weldsuite.dev',
            status: 'active',
            auto_renew: true,
            locked: false,
            privacy_mode: 'redaction',
            created_at: '2026-07-26T00:00:00Z',
            expires_at: '2027-07-26T00:00:00Z',
          },
        },
      }),
    );

    await expect(cf.register({ name: 'weldsuite.dev' })).resolves.toEqual({
      status: 'completed',
      domain: {
        id: 'weldsuite.dev',
        name: 'weldsuite.dev',
        status: 'active',
        expiresAt: '2027-07-26T00:00:00Z',
        autoRenew: true,
        locked: false,
        privacyMode: 'redaction',
      },
    });
  });
});

describe('CloudflareRegistrar.getRegistrationStatus', () => {
  const registration = {
    domain_name: 'weldsuite.dev',
    status: 'active',
    auto_renew: true,
    locked: false,
    privacy_mode: 'redaction',
    created_at: '2026-07-26T00:00:00Z',
    expires_at: '2027-07-26T00:00:00Z',
  };

  /** What `registration` above must map to. */
  const mappedDomain = {
    id: 'weldsuite.dev',
    name: 'weldsuite.dev',
    status: 'active',
    expiresAt: '2027-07-26T00:00:00Z',
    autoRenew: true,
    locked: false,
    privacyMode: 'redaction',
  };

  /**
   * A terminal `succeeded` with no registration attached would otherwise map to
   * `pending` on every poll, leaving a paid domain in `pending_workflow`
   * forever. The client re-reads the registration instead.
   */
  it('re-reads the registration when a succeeded workflow carries none', async () => {
    const { cf, calls } = withResponseSequence([
      {
        success: true,
        errors: [],
        result: {
          state: 'succeeded',
          completed: true,
          created_at: '2026-07-26T00:00:00Z',
          updated_at: '2026-07-26T00:00:00Z',
          links: { self: 'https://api.cloudflare.com/.../status' },
        },
      },
      { success: true, errors: [], result: registration },
    ]);

    const result = await cf.getRegistrationStatus('weldsuite.dev');

    // Status poll, then the follow-up read of the registration itself. The stub
    // answers any URL, so both requests are pinned — otherwise a regression
    // that sent the first one to the wrong resource would still pass.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain('/registrar/registrations/weldsuite.dev/registration-status');
    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[1]!.url).toMatch(/\/registrar\/registrations\/weldsuite\.dev$/);
    expect(calls[1]!.init?.method).toBe('GET');
    expect(result).toEqual({ status: 'completed', domain: mappedDomain });
  });

  it('uses the attached registration without a second call', async () => {
    const { cf, calls } = withResponse(200, {
      success: true,
      errors: [],
      result: {
        state: 'succeeded',
        completed: true,
        created_at: '2026-07-26T00:00:00Z',
        updated_at: '2026-07-26T00:00:00Z',
        links: { self: 'https://api.cloudflare.com/.../status' },
        context: { registration },
      },
    });

    const result = await cf.getRegistrationStatus('weldsuite.dev');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/registrar/registrations/weldsuite.dev/registration-status');
    // Assert the full mapping, not just the status: a version that dropped
    // `context.registration` and re-read it would also produce 'completed'.
    expect(result).toEqual({ status: 'completed', domain: mappedDomain });
  });
});

describe('CloudflareRegistrar.updateDomain', () => {
  it('routes auto_renew through the registrations workflow', async () => {
    const { cf, calls } = withResponse(200, {
      success: true,
      errors: [],
      result: {
        completed: true,
        state: 'succeeded',
        created_at: '2026-07-26T00:00:00Z',
        updated_at: '2026-07-26T00:00:00Z',
        links: { self: 'https://api.cloudflare.com/.../status' },
      },
    });

    await cf.updateDomain('weldsuite.dev', { autoRenew: false });

    expect(calls[0]!.url).toContain('/registrar/registrations/weldsuite.dev');
    expect(calls[0]!.init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ auto_renew: false });
  });

  it('routes locked through the older domains route, the only one that has it', async () => {
    const { cf, calls } = withResponse(200, { success: true, errors: [], result: {} });

    await cf.updateDomain('weldsuite.dev', { locked: true });

    expect(calls[0]!.url).toContain('/registrar/domains/weldsuite.dev');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ locked: true });
  });
});

describe('applyMarkup', () => {
  it('converts the Cloudflare decimal price to cents at cost', () => {
    expect(applyMarkup(10.44, undefined)).toBe(1044);
  });

  it('returns null when Cloudflare gave no price', () => {
    expect(applyMarkup(undefined, undefined)).toBeNull();
  });
});
