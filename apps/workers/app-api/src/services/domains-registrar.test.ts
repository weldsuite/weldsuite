/**
 * Contract tests for the Realtime Register client and markup helper.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  RealtimeRegistrar,
  RealtimeRegistrarError,
  toE164a,
  contactHandleFrom,
  type RegistrarFetch,
} from '@weldsuite/realtime-registrar';
import { applyMarkup } from './domains';

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

  it('trims trailing whitespace from the API key', async () => {
    const calls: FetchCall[] = [];
    const fetchStub: RegistrarFetch = async (input, init) => {
      calls.push({
        url: String(input instanceof Request ? input.url : input),
        init: init as RequestInit | undefined,
      });
      return new Response(JSON.stringify({ available: true, premium: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const padded = new RealtimeRegistrar({
      apiKey: 'key_test\n',
      customer: ' weldsuite ',
      fetch: fetchStub,
    });
    await padded.checkDomain('example.com');
    const auth = new Headers(calls[calls.length - 1]!.init?.headers).get('Authorization');
    expect(auth).toBe('ApiKey key_test');
  });
});

describe('RealtimeRegistrar.searchDomains', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fans out checks across TLDs', async () => {
    const calls: FetchCall[] = [];
    const fetchStub: RegistrarFetch = async (input, init) => {
      calls.push({
        url: String(input instanceof Request ? input.url : input),
        init: init as RequestInit | undefined,
      });
      const url = String(input instanceof Request ? input.url : input);
      const available = url.includes('acme.com');
      return new Response(
        JSON.stringify({ available, premium: false, currency: 'EUR' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const rtr = new RealtimeRegistrar({
      apiKey: 'key_test',
      customer: 'weldsuite',
      fetch: fetchStub,
    });
    const results = await rtr.searchDomains('acme', ['com', 'nl'], 10);
    expect(calls.length).toBe(2);
    expect(results.some((r) => r.name === 'acme.com' && r.available)).toBe(true);
  });

  it('marks a mixed failure as check_failed, not unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchStub: RegistrarFetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('acme.nl')) throw new Error('network down');
      return new Response(
        JSON.stringify({ available: true, premium: false, currency: 'EUR' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const rtr = new RealtimeRegistrar({
      apiKey: 'key_test',
      customer: 'weldsuite',
      fetch: fetchStub,
    });
    const results = await rtr.searchDomains('acme', ['com', 'nl'], 10);
    expect(results.find((r) => r.name === 'acme.com')).toMatchObject({ available: true });
    expect(results.find((r) => r.name === 'acme.nl')).toMatchObject({
      available: false,
      reason: 'check_failed',
    });
  });

  it('maps an uncontracted TLD to extension_not_supported without failing the search', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchStub: RegistrarFetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('acme.nl')) {
        return new Response(
          JSON.stringify({ type: 'NoContractException', message: 'No contract active for product' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ available: true, premium: false, currency: 'EUR' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const rtr = new RealtimeRegistrar({
      apiKey: 'key_test',
      customer: 'weldsuite',
      fetch: fetchStub,
    });
    const results = await rtr.searchDomains('acme', ['com', 'nl'], 10);
    expect(results.find((r) => r.name === 'acme.com')).toMatchObject({ available: true });
    expect(results.find((r) => r.name === 'acme.nl')).toMatchObject({
      available: false,
      reason: 'extension_not_supported',
    });
  });

  it('rethrows when every check fails so the route can surface the RTR error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchStub: RegistrarFetch = async () =>
      new Response(JSON.stringify({ type: 'AuthenticationError', message: 'bad key' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    const rtr = new RealtimeRegistrar({
      apiKey: 'key_test',
      customer: 'weldsuite',
      fetch: fetchStub,
    });
    await expect(rtr.searchDomains('acme', ['com'], 10)).rejects.toMatchObject({
      name: 'RealtimeRegistrarError',
      status: 401,
      code: 'AuthenticationError',
    });
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
      currency: 'EUR',
    } as never;
    // 999 USD wholesale must not be mixed into EUR pricing.
    expect(applyMarkup(999, pricing, 'USD')).toBe(1500);
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
});
