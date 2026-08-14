/**
 * Contract tests for the Realtime Register client and markup helper.
 */

import { describe, it, expect } from 'vitest';
import {
  RealtimeRegistrar,
  RealtimeRegistrarError,
  parseDomainPricelist,
  missingDomainPricingFromPricelist,
  splitDomainPricingFromPricelist,
  centsToMajorUnits,
  toE164a,
  contactHandleFrom,
  isExactSldMatch,
  rankExactDomainSearchResults,
  resolvePlatformRegistrarContacts,
  MissingPlatformRegistrantError,
  WELDHOST_PRIVACY_PROTECT,
  type RegistrarFetch,
} from '@weldsuite/realtime-registrar';
import { applyMarkup, roleContactsFromEnv } from './domains';

type FetchCall = { url: string; init: RequestInit | undefined };

function withResponse(status: number, body: unknown, opts: { headers?: Record<string, string> } = {}) {
  const calls: FetchCall[] = [];
  const fetchStub: RegistrarFetch = async (input, init) => {
    calls.push({
      url: String(input instanceof Request ? input.url : input),
      init: init as RequestInit | undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    });
  };
  const rtr = new RealtimeRegistrar({
    apiKey: 'key_test',
    customer: 'weldsuite',
    fetch: fetchStub,
  });
  return { rtr, calls };
}

describe('exact domain search matching', () => {
  it('matches the typed SLD across TLDs but not similar names', () => {
    expect(isExactSldMatch('WeldSuite', 'weldsuite.com')).toBe(true);
    expect(isExactSldMatch('weldsuite.com', 'weldsuite.net')).toBe(true);
    expect(isExactSldMatch('weldsuite', 'getweldsuite.com')).toBe(false);
    expect(isExactSldMatch('weldsuite', 'weld-suite.com')).toBe(false);
  });

  it('pins the typed FQDN first', () => {
    const ranked = rankExactDomainSearchResults('weldsuite.com', [
      { name: 'weldsuite.net' },
      { name: 'weldsuite.com' },
    ]);
    expect(ranked.map((r) => r.name)).toEqual(['weldsuite.com', 'weldsuite.net']);
  });
});

describe('RealtimeRegistrar.checkDomain', () => {
  it('maps availability and premium price in cents', async () => {
    const { rtr, calls } = withResponse(200, {
      available: true,
      premium: true,
      currency: 'EUR',
      price: 12500,
      renewPrice: 9900,
    });
    const result = await rtr.checkDomain('example.com', { renewPrice: true });
    expect(calls[0]!.url).toContain('/domains/example.com/check');
    expect(calls[0]!.url).toContain('renewPrice=true');
    expect(result).toMatchObject({
      name: 'example.com',
      available: true,
      premium: true,
      priceCents: 12500,
      renewalPriceCents: 9900,
      currency: 'EUR',
    });
  });

  it('throws RealtimeRegistrarError on 401', async () => {
    const { rtr } = withResponse(401, { type: 'AuthenticationError', message: 'bad key' });
    await expect(rtr.checkDomain('x.com')).rejects.toBeInstanceOf(RealtimeRegistrarError);
  });
});

describe('RealtimeRegistrar.searchDomains', () => {
  function adacClient(body: unknown, opts?: { tldSetToken?: string; status?: number }) {
    const calls: FetchCall[] = [];
    const fetchStub: RegistrarFetch = async (input, init) => {
      calls.push({
        url: String(input instanceof Request ? input.url : input),
        init: init as RequestInit | undefined,
      });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status: opts?.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const rtr = new RealtimeRegistrar({
      apiKey: 'key_test',
      customer: 'weldsuite',
      adacApiKey: 'adac_test_key',
      adacTldSetToken: opts?.tldSetToken,
      fetch: fetchStub,
    });
    return { rtr, calls };
  }

  it('posts the ADAC input action once instead of fanning out REST checks', async () => {
    const { rtr, calls } = adacClient([
      { action: 'domain_status', data: { domain_name: 'acme.com', suffix: 'com', status: 1 } },
      { action: 'domain_status', data: { domain_name: 'acme.nl', suffix: 'nl', status: 2 } },
      { action: 'suggestion', data: { source: 'rns', domain_name: 'acme.live', suffix: 'live', status: 1 } },
    ]);
    const results = await rtr.searchDomains('acme', [], 20);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://adac.api.yoursrs.com/action');
    const posted = JSON.parse(String(calls[0]!.init?.body)) as {
      action: string;
      api_key: string;
      data: { input: string; hints?: Record<string, unknown> };
    };
    expect(results.find((r) => r.name === 'acme.com')).toMatchObject({ available: true });
    expect(results.find((r) => r.name === 'acme.nl')).toMatchObject({
      available: false,
      reason: 'domain_unavailable',
    });
    expect(results.some((r) => r.name === 'acme.live')).toBe(false);
    expect(posted).toMatchObject({
      action: 'input',
      api_key: 'adac_test_key',
      data: { input: 'acme' },
    });
    expect(posted.data.hints).toMatchObject({
      domainsbot: false,
      rns: false,
      namesuggestion: false,
    });
  });

  it('includes the TLD-set token when configured', async () => {
    const { rtr, calls } = adacClient([], { tldSetToken: 'tldset_abc' });
    await rtr.searchDomains('acme');
    const posted = JSON.parse(String(calls[0]!.init?.body)) as { data: { tld_set_token?: string } };
    expect(posted.data.tld_set_token).toBe('tldset_abc');
  });

  it('maps premium ADAC rows to price cents', async () => {
    const { rtr } = adacClient([
      {
        action: 'domain_status',
        data: {
          domain_name: 'hot.shop',
          suffix: 'shop',
          status: 1,
          type: 'premium',
          currency: 'EUR',
          price: 12500,
        },
      },
    ]);
    await expect(rtr.searchDomains('hot')).resolves.toEqual([
      expect.objectContaining({
        name: 'hot.shop',
        available: true,
        premium: true,
        priceCents: 12500,
        currency: 'EUR',
      }),
    ]);
  });

  it('throws when ADAC is not configured', async () => {
    const { rtr } = withResponse(200, { available: true });
    await expect(rtr.searchDomains('acme')).rejects.toMatchObject({
      name: 'RealtimeRegistrarError',
      code: 'ADAC_NOT_CONFIGURED',
    });
  });

  it('throws the ADAC error payload', async () => {
    const { rtr } = adacClient({ action: 'error', data: 'Invalid domain' });
    await expect(rtr.searchDomains('acme')).rejects.toMatchObject({
      name: 'RealtimeRegistrarError',
      code: 'ADAC_ERROR',
      message: 'Invalid domain',
    });
  });

  it('keeps only the typed SLD and does not hide taken exact matches', async () => {
    const { rtr } = adacClient([
      { action: 'domain_status', data: { domain_name: 'weldsuite.com', suffix: 'com', status: 2 } },
      { action: 'domain_status', data: { domain_name: 'weldsuite.net', suffix: 'net', status: 1 } },
      { action: 'domain_status', data: { domain_name: 'getweldsuite.com', suffix: 'com', status: 1 } },
      { action: 'suggestion', data: { source: 'rns', domain_name: 'weld-suite.com', suffix: 'com', status: 1 } },
    ]);
    const results = await rtr.searchDomains('WeldSuite', [], 20);
    expect(results.map((r) => r.name)).toEqual(['weldsuite.com', 'weldsuite.net']);
    expect(results[0]).toMatchObject({
      name: 'weldsuite.com',
      available: false,
      reason: 'domain_unavailable',
    });
  });

  it('pins a typed FQDN first without dropping it when the TLD set is large', async () => {
    const extras = Array.from({ length: 25 }, (_, i) => ({
      action: 'domain_status' as const,
      data: { domain_name: `weldsuite.t${i}`, suffix: `t${i}`, status: 1 },
    }));
    const { rtr } = adacClient([
      ...extras,
      { action: 'domain_status', data: { domain_name: 'weldsuite.com', suffix: 'com', status: 2 } },
    ]);
    const results = await rtr.searchDomains('weldsuite.com', [], 20);
    expect(results[0]).toMatchObject({
      name: 'weldsuite.com',
      available: false,
      reason: 'domain_unavailable',
    });
    expect(results).toHaveLength(20);
  });
});

describe('RealtimeRegistrar.checkDomains', () => {
  it('uses the ADAC check action when an ADAC key is set', async () => {
    const calls: FetchCall[] = [];
    const fetchStub: RegistrarFetch = async (input, init) => {
      calls.push({
        url: String(input instanceof Request ? input.url : input),
        init: init as RequestInit | undefined,
      });
      return new Response(
        JSON.stringify([
          { action: 'domain_status', data: { domain_name: 'acme.com', suffix: 'com', status: 1 } },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const rtr = new RealtimeRegistrar({
      apiKey: 'key_test',
      customer: 'weldsuite',
      adacApiKey: 'adac_test_key',
      fetch: fetchStub,
    });
    const results = await rtr.checkDomains(['acme.com']);
    expect(calls[0]!.url).toBe('https://adac.api.yoursrs.com/action');
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({
      action: 'check',
      api_key: 'adac_test_key',
      data: { input: 'acme.com' },
    });
    expect(results).toEqual([expect.objectContaining({ name: 'acme.com', available: true })]);
  });

  it('falls back to registrar REST checks without an ADAC key', async () => {
    const { rtr, calls } = withResponse(200, { available: true, premium: false });
    const results = await rtr.checkDomains(['acme.com']);
    expect(calls[0]!.url).toContain('/domains/acme.com/check');
    expect(results[0]).toMatchObject({ name: 'acme.com', available: true });
  });

  it('marks a rejected ADAC check as check_failed, not unavailable', async () => {
    const fetchStub: RegistrarFetch = async () => {
      throw new Error('network down');
    };
    const rtr = new RealtimeRegistrar({
      apiKey: 'key_test',
      customer: 'weldsuite',
      adacApiKey: 'adac_test_key',
      fetch: fetchStub,
    });
    const results = await rtr.checkDomains(['acme.com']);
    expect(results).toEqual([
      expect.objectContaining({
        name: 'acme.com',
        available: false,
        reason: 'check_failed',
      }),
    ]);
  });
});

describe('RealtimeRegistrar.pollProcess', () => {
  it('maps documented terminal and in-flight statuses', async () => {
    for (const [status, expected] of [
      ['COMPLETED', 'completed'],
      ['FAILED', 'failed'],
      ['INVALID', 'failed'],
      ['CANCELLED', 'failed'],
      ['IN_DOUBT', 'failed'],
      ['NEW', 'pending'],
      ['RUNNING', 'pending'],
      ['SCHEDULED', 'pending'],
    ] as const) {
      const { rtr } = withResponse(200, { id: 1, status });
      await expect(rtr.pollProcess(1)).resolves.toBe(expected);
    }
  });
});

describe('RealtimeRegistrar.register', () => {
  it('returns completed on 201', async () => {
    const { rtr } = withResponse(201, {
      domainName: 'new.example',
      expiryDate: '2027-01-01T00:00:00Z',
      status: ['OK'],
    });
    const result = await rtr.register({
      name: 'new.example',
      registrant: 'ws-reg',
      periodMonths: 12,
    });
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.domain.name).toBe('new.example');
      expect(result.domain.locked).toBe(false);
    }
  });

  it('returns pending when X-Process-Id is present', async () => {
    const { rtr } = withResponse(
      202,
      { domainName: 'async.example', status: ['PENDING_VALIDATION'] },
      { headers: { 'X-Process-Id': '42' } },
    );
    const result = await rtr.register({
      name: 'async.example',
      registrant: 'ws-reg',
    });
    expect(result).toMatchObject({ status: 'pending', processId: 42 });
  });

  it('fails when async response has no process id', async () => {
    const { rtr } = withResponse(202, {
      domainName: 'async.example',
      status: ['PENDING_VALIDATION'],
    });
    const result = await rtr.register({
      name: 'async.example',
      registrant: 'ws-reg',
    });
    expect(result).toMatchObject({ status: 'failed', code: 'MISSING_PROCESS_ID' });
  });
});

describe('RealtimeRegistrar.transfer', () => {
  it('returns process id and status', async () => {
    const { rtr, calls } = withResponse(202, {
      domainName: 'move.example',
      status: 'pending',
      processId: 99,
      type: 'IN',
      requestedDate: '2026-01-01T00:00:00Z',
    });
    const result = await rtr.transfer({
      name: 'move.example',
      registrant: 'ws-reg',
      authCode: 'EPP-CODE',
    });
    expect(calls[0]!.url).toContain('/domains/move.example/transfer');
    expect(result.processId).toBe(99);
    expect(result.status).toBe('pending');
  });

  it('throws when process id is missing', async () => {
    const { rtr } = withResponse(202, {
      domainName: 'move.example',
      status: 'pending',
      type: 'IN',
    });
    await expect(
      rtr.transfer({ name: 'move.example', registrant: 'ws-reg', authCode: 'EPP' }),
    ).rejects.toMatchObject({ code: 'MISSING_PROCESS_ID' });
  });
});

describe('contact helpers', () => {
  it('formats E164a phones using country calling codes', () => {
    expect(toE164a('+31.384530759')).toBe('+31.384530759');
    expect(toE164a('+1.2025551234')).toBe('+1.2025551234');
    expect(toE164a('+31384530759', 'NL')).toBe('+31.384530759');
    expect(toE164a('+31 38 453 0759', 'NL')).toBe('+31.384530759');
    expect(toE164a('0612345678', 'NL')).toBe('+31.612345678');
    expect(toE164a('+12025551234', 'US')).toBe('+1.2025551234');
    expect(toE164a('+1 (202) 555-1234', 'US')).toBe('+1.2025551234');
    expect(toE164a('0384530759')).toBeNull(); // no country → refuse to guess
    expect(toE164a('bad', 'NL')).toBeNull();
  });

  it('builds stable handles that diverge for distinct contacts', () => {
    const a = contactHandleFrom({
      email: 'Ada.Lovelace@example.com',
      lastName: 'Lovelace',
      country: 'NL',
      address1: 'Street 1',
    });
    const b = contactHandleFrom({
      email: 'Ada.Lovelace@example.com',
      lastName: 'Lovelace',
      country: 'NL',
      address1: 'Street 2',
    });
    expect(a.length).toBeGreaterThanOrEqual(3);
    expect(a.length).toBeLessThanOrEqual(40);
    expect(a).toMatch(/^[a-z0-9\-_.@]+$/);
    expect(a).not.toBe(b);
    expect(contactHandleFrom({
      email: 'Ada.Lovelace@example.com',
      lastName: 'Lovelace',
      country: 'NL',
      address1: 'Street 1',
    })).toBe(a);
  });
});

describe('applyMarkup', () => {
  it('uses wholesale cents directly and adds flat markup', () => {
    const pricing = {
      markupAmount: 200,
      markupPercent: null,
      registrationPrice: '10.00',
      currency: 'EUR',
    } as never;
    expect(applyMarkup(1000, pricing, 'EUR')).toBe(1200);
  });

  it('applies markupPercent when flat markup is absent', () => {
    const pricing = {
      markupAmount: null,
      markupPercent: '20',
      registrationPrice: '10.00',
      currency: 'EUR',
    } as never;
    expect(applyMarkup(1000, pricing, 'EUR')).toBe(1200);
  });

  it('falls back to pricing.registrationPrice major units', () => {
    const pricing = {
      markupAmount: null,
      markupPercent: null,
      registrationPrice: '12.50',
      currency: 'EUR',
    } as never;
    expect(applyMarkup(null, pricing)).toBe(1250);
  });

  it('ignores wholesale cents when currency disagrees with pricing', () => {
    const pricing = {
      markupAmount: null,
      markupPercent: null,
      registrationPrice: '15.00',
      currency: 'USD',
    } as never;
    // 890 EUR wholesale must not be mixed into USD pricing.
    expect(applyMarkup(890, pricing, 'EUR')).toBe(1500);
  });

  it('converts major units via applyMarkup(cents)', () => {
    const pricing = {
      markupAmount: 100,
      markupPercent: null,
      registrationPrice: '10.00',
      currency: 'EUR',
    } as never;
    // 10.00 EUR → 1000 cents + 100 markup
    expect(applyMarkup(Math.round(10 * 100), pricing, 'EUR')).toBe(1100);
  });

  it('returns wholesale cents when no catalog row exists', () => {
    expect(applyMarkup(890, undefined, 'EUR')).toBe(890);
  });
});

describe('parseDomainPricelist', () => {
  it('maps domain_com CREATE rows to TLD wholesale cents', () => {
    const map = parseDomainPricelist([
      { product: 'domain_com', action: 'CREATE', currency: 'USD', price: 890 },
      { product: 'domain_com', action: 'RENEW', currency: 'USD', price: 1090 },
      { product: 'domain_nl', action: 'CREATE', currency: 'USD', price: 650 },
      { product: 'ssl_comodo', action: 'CREATE', currency: 'USD', price: 5000 },
    ]);
    expect(map.get('com')).toEqual({
      createCents: 890,
      renewCents: 1090,
      currency: 'USD',
    });
    expect(map.get('nl')?.createCents).toBe(650);
    expect(map.has('comodo')).toBe(false);
  });

  it('drops TLDs that have no CREATE price', () => {
    const map = parseDomainPricelist([
      { product: 'domain_xyz', action: 'RENEW', currency: 'USD', price: 100 },
    ]);
    expect(map.size).toBe(0);
  });
});

describe('RealtimeRegistrar.getPricelist', () => {
  it('GETs the customer pricelist in USD and parses domain CREATE prices', async () => {
    const { rtr, calls } = withResponse(200, {
      prices: [
        { product: 'domain_com', action: 'CREATE', currency: 'USD', price: 890 },
      ],
    });
    const map = await rtr.getPricelist();
    expect(calls[0]!.url).toContain('/customers/weldsuite/pricelist');
    expect(calls[0]!.url).toContain('currency=USD');
    expect(map.get('com')?.createCents).toBe(890);
    expect(map.get('com')?.currency).toBe('USD');
  });
});

describe('missingDomainPricingFromPricelist', () => {
  it('converts cents to major units and skips existing TLDs', () => {
    expect(centsToMajorUnits(890)).toBe('8.90');
    const wholesale = parseDomainPricelist([
      { product: 'domain_com', action: 'CREATE', currency: 'USD', price: 890 },
      { product: 'domain_com', action: 'RENEW', currency: 'USD', price: 1090 },
      { product: 'domain_com', action: 'TRANSFER', currency: 'USD', price: 890 },
      { product: 'domain_nl', action: 'CREATE', currency: 'USD', price: 650 },
      { product: 'domain_xyz', action: 'CREATE', currency: 'USD', price: 1200 },
    ]);
    const rows = missingDomainPricingFromPricelist(wholesale, ['.com', 'NL']);
    expect(rows.map((r) => r.tld)).toEqual(['xyz']);
    expect(rows[0]).toMatchObject({
      tld: 'xyz',
      registrationPrice: '12.00',
      renewalPrice: '12.00',
      transferPrice: '12.00',
      currency: 'USD',
      isPopular: false,
      registrar: 'realtimeregister',
    });
  });

  it('falls back renew/transfer to CREATE and flags popular TLDs', () => {
    const wholesale = parseDomainPricelist([
      { product: 'domain_io', action: 'CREATE', currency: 'USD', price: 2500 },
    ]);
    const [row] = missingDomainPricingFromPricelist(wholesale, []);
    expect(row).toMatchObject({
      tld: 'io',
      registrationPrice: '25.00',
      renewalPrice: '25.00',
      transferPrice: '25.00',
      isPopular: true,
    });
  });
});

describe('splitDomainPricingFromPricelist', () => {
  it('splits missing inserts from existing wholesale updates', () => {
    const wholesale = parseDomainPricelist([
      { product: 'domain_com', action: 'CREATE', currency: 'USD', price: 990 },
      { product: 'domain_com', action: 'RENEW', currency: 'USD', price: 1190 },
      { product: 'domain_xyz', action: 'CREATE', currency: 'USD', price: 1200 },
    ]);
    const { missing, existing } = splitDomainPricingFromPricelist(wholesale, ['com']);
    expect(missing.map((r) => r.tld)).toEqual(['xyz']);
    expect(existing).toEqual([
      expect.objectContaining({
        tld: 'com',
        registrationPrice: '9.90',
        renewalPrice: '11.90',
        transferPrice: '9.90',
        currency: 'USD',
      }),
    ]);
  });
});

describe('resolvePlatformRegistrarContacts', () => {
  it('uses the admin handle as registrant and fills missing tech/billing from admin', () => {
    const resolved = resolvePlatformRegistrarContacts({ admin: 'ws-admin' });
    expect(resolved.registrant).toBe('ws-admin');
    expect(resolved.contacts).toEqual([
      { role: 'ADMIN', handle: 'ws-admin' },
      { role: 'TECH', handle: 'ws-admin' },
      { role: 'BILLING', handle: 'ws-admin' },
    ]);
  });

  it('keeps distinct tech and billing handles when provided', () => {
    const resolved = resolvePlatformRegistrarContacts({
      admin: ' ws-admin ',
      tech: 'ws-tech',
      billing: 'ws-billing',
    });
    expect(resolved).toEqual({
      registrant: 'ws-admin',
      contacts: [
        { role: 'ADMIN', handle: 'ws-admin' },
        { role: 'TECH', handle: 'ws-tech' },
        { role: 'BILLING', handle: 'ws-billing' },
      ],
    });
  });

  it('throws when the platform admin handle is missing', () => {
    expect(() => resolvePlatformRegistrarContacts({})).toThrow(MissingPlatformRegistrantError);
    expect(() => resolvePlatformRegistrarContacts({ admin: '  ' })).toThrow(
      MissingPlatformRegistrantError,
    );
  });

  it('never takes a customer handle as a fallback', () => {
    expect(WELDHOST_PRIVACY_PROTECT).toBe(true);
    expect(roleContactsFromEnv({ REALTIME_REGISTER_CONTACT_ADMIN: 'ws-admin' })).toEqual([
      { role: 'ADMIN', handle: 'ws-admin' },
      { role: 'TECH', handle: 'ws-admin' },
      { role: 'BILLING', handle: 'ws-admin' },
    ]);
  });
});
