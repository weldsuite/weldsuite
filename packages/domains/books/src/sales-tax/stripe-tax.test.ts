import { describe, expect, it } from 'vitest';
import { createStripeTaxEngine, STRIPE_TAX_API_VERSION } from './stripe-tax';
import { fakeFetch, formBody } from './test-http';
import { SalesTaxEngineError } from './types';
import { REGISTRATIONS, WA_SELLER, addr, certificate, emptyResult, line, reg, request } from './test-fixtures';

const API_KEY = 'rk_test_secret_value';
const NOW = () => new Date('2026-03-15T12:00:00.000Z');

function engine(fetchImpl: typeof fetch, extra = {}) {
  return createStripeTaxEngine({ apiKey: API_KEY, fetch: fetchImpl, now: NOW, ...extra });
}

const waRequest = (extra = {}) =>
  request({ shipFrom: WA_SELLER, shipTo: addr('WA', '98001', 'Alpha'), ...extra });

/** A recorded calculation response: invented rates, real shape. */
function calculation(lineItems: unknown[], id = 'taxcalc_1Fixture') {
  return { id, object: 'tax.calculation', currency: 'usd', line_items: { object: 'list', data: lineItems } };
}

function breakdownItem(
  level: string,
  name: string,
  percentage: string,
  amount: number,
  taxable: number,
  reason = 'standard_rated',
  state = 'WA',
) {
  return {
    amount,
    jurisdiction: { country: 'US', display_name: name, level, state },
    sourcing: 'destination',
    tax_rate_details: { display_name: 'Sales and Use Tax', percentage_decimal: percentage, tax_type: 'sales_tax' },
    taxability_reason: reason,
    taxable_amount: taxable,
  };
}

const standardLine = (reference = 'l1', amount = 10000) => ({
  id: `tax_li_${reference}`,
  amount,
  amount_tax: 925,
  quantity: 1,
  reference,
  tax_behavior: 'exclusive',
  tax_code: 'txcd_99999999',
  tax_breakdown: [
    breakdownItem('state', 'Washington', '6.0', 600, amount),
    breakdownItem('county', 'Fixture County', '0', 0, amount),
    breakdownItem('city', 'Alpha', '2.0', 200, amount),
    breakdownItem('district', 'Regional Transit', '1.0', 100, amount),
    breakdownItem('district', 'Alpha Benefit District', '0.25', 25, amount),
  ],
});

describe('Stripe Tax: calculate', () => {
  it('sends a form-encoded calculation with the pinned API version', async () => {
    const http = fakeFetch([{ json: calculation([standardLine()]) }]);
    await engine(http.fetch).calculate(
      waRequest({ lines: [line('l1', 100, { quantity: 2 })], shipTo: { ...addr('WA', '98001', 'Alpha'), line1: '5 Fixture Way' } }),
    );

    expect(http.calls).toHaveLength(1);
    const call = http.calls[0];
    expect(call.url).toBe('https://api.stripe.com/v1/tax/calculations');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(call.headers['stripe-version']).toBe(STRIPE_TAX_API_VERSION);
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');

    expect(formBody(call)).toMatchObject({
      currency: 'usd',
      'line_items[0][amount]': '10000',
      'line_items[0][reference]': 'l1',
      'line_items[0][tax_code]': 'txcd_99999999',
      'line_items[0][tax_behavior]': 'exclusive',
      'line_items[0][quantity]': '2',
      'customer_details[address][line1]': '5 Fixture Way',
      'customer_details[address][city]': 'Alpha',
      'customer_details[address][state]': 'WA',
      'customer_details[address][postal_code]': '98001',
      'customer_details[address][country]': 'US',
      'customer_details[address_source]': 'shipping',
      'ship_from_details[address][state]': 'WA',
      'ship_from_details[address][postal_code]': '98001',
      'expand[0]': 'line_items.data.tax_breakdown',
    });
    expect(formBody(call)['customer_details[taxability_override]']).toBeUndefined();
  });

  it('maps the per-jurisdiction breakdown', async () => {
    const http = fakeFetch([{ json: calculation([standardLine()]) }]);
    const result = await engine(http.fetch).calculate(waRequest());

    expect(result.engine).toBe('stripe_tax');
    expect(result.engineRef).toBe('taxcalc_1Fixture');
    expect(result.sourcing).toBe('destination');
    expect(result.shipToState).toBe('WA');
    expect(result.warnings).toEqual([]);
    expect(result.totalTax).toBe(9.25);

    const l = result.lines[0];
    expect(l).toMatchObject({ lineId: 'l1', grossAmount: 100, taxableAmount: 100, exemptAmount: 0, nonTaxableAmount: 0, tax: 9.25 });
    // The 0% county says nothing the others don't: it is left out.
    expect(l.details.map((d) => [d.level, d.jurisdictionName, d.rate, d.tax])).toEqual([
      ['state', 'Washington', 6, 6],
      ['city', 'Alpha', 2, 2],
      ['district', 'Regional Transit', 1, 1],
      ['district', 'Alpha Benefit District', 0.25, 0.25],
    ]);
    expect(l.details[0]).toMatchObject({
      stateCode: 'WA',
      agencyId: 'ag_wa',
      taxableAmount: 100,
      unroundedTax: 6,
    });
    expect(l.details[0].jurisdictionCode).toBe('WA-ST-washington');
    expect(l.details.every((d) => d.jurisdictionCode.length <= 30)).toBe(true);
    expect(new Set(l.details.map((d) => d.jurisdictionCode)).size).toBe(l.details.length);
  });

  it('keeps a long jurisdiction name within the ledger column', async () => {
    const item = standardLine();
    item.tax_breakdown[3] = breakdownItem('district', 'Alpha Transportation Benefit District Number One', '1.0', 100, 10000);
    const http = fakeFetch([{ json: calculation([item]) }]);
    const result = await engine(http.fetch).calculate(waRequest());
    for (const d of result.lines[0].details) expect(d.jurisdictionCode.length).toBeLessThanOrEqual(30);
  });

  it('a product exempt in the state keeps its jurisdictions and the non-taxable amount', async () => {
    const item = {
      ...standardLine(),
      amount_tax: 0,
      tax_breakdown: [breakdownItem('state', 'Washington', '6.0', 0, 0, 'product_exempt')],
    };
    const http = fakeFetch([{ json: calculation([item]) }]);
    const result = await engine(http.fetch).calculate(waRequest());
    expect(result.lines[0]).toMatchObject({ grossAmount: 100, taxableAmount: 0, nonTaxableAmount: 100, exemptAmount: 0, tax: 0 });
    expect(result.lines[0].details).toHaveLength(1);
  });

  it('not_collecting (no registration at Stripe) becomes not_registered_in_state', async () => {
    const item = {
      ...standardLine(),
      amount_tax: 0,
      tax_breakdown: [breakdownItem('state', 'Washington', '0', 0, 0, 'not_collecting')],
    };
    const http = fakeFetch([{ json: calculation([item]) }]);
    const result = await engine(http.fetch).calculate(waRequest());
    expect(result.warnings).toContain('not_registered_in_state');
    expect(result.totalTax).toBe(0);
    expect(result.lines[0]).toMatchObject({ grossAmount: 100, tax: 0, details: [] });
  });

  it('a line with no breakdown stays on the ledger as a sale in the state', async () => {
    const item = { ...standardLine(), amount_tax: 0, tax_breakdown: [] };
    const http = fakeFetch([{ json: calculation([item]) }]);
    const result = await engine(http.fetch).calculate(waRequest());
    expect(result.lines[0].details).toHaveLength(1);
    expect(result.lines[0].details[0]).toMatchObject({ level: 'state', stateCode: 'WA', rate: 0, nonTaxableAmount: 100 });
  });

  it('sends tax_behavior inclusive and backs the tax out of the amount', async () => {
    const item = {
      ...standardLine(),
      amount: 10925,
      amount_tax: 925,
      tax_behavior: 'inclusive',
      tax_breakdown: standardLine().tax_breakdown.map((b) => ({ ...b, taxable_amount: 10000 })),
    };
    const http = fakeFetch([{ json: calculation([item]) }]);
    const result = await engine(http.fetch).calculate(waRequest({ lines: [line('l1', 109.25, { taxIncluded: true })] }));
    expect(formBody(http.calls[0])['line_items[0][tax_behavior]']).toBe('inclusive');
    expect(formBody(http.calls[0])['line_items[0][amount]']).toBe('10925');
    expect(result.lines[0]).toMatchObject({ grossAmount: 100, taxableAmount: 100, tax: 9.25 });
  });

  it('marks the customer exempt when a valid certificate covers the state', async () => {
    const exemptItem = {
      ...standardLine(),
      amount_tax: 0,
      tax_breakdown: [
        breakdownItem('state', 'Washington', '6.0', 0, 0, 'customer_exempt'),
        breakdownItem('city', 'Alpha', '2.0', 0, 0, 'customer_exempt'),
      ],
    };
    const http = fakeFetch([{ json: calculation([exemptItem]) }]);
    const result = await engine(http.fetch).calculate(
      waRequest({
        customer: { partyId: 'p', certificates: [certificate({ states: ['WA'], issuedOn: '2026-01-05' })] },
      }),
    );
    expect(formBody(http.calls[0])['customer_details[taxability_override]']).toBe('customer_exempt');
    expect(result.totalTax).toBe(0);
    for (const d of result.lines[0].details) {
      expect(d).toMatchObject({ exemptAmount: 100, taxableAmount: 0, exemptReason: 'resale', certificateId: 'cert_1' });
    }
  });

  it('an expired certificate is not sent as an exemption and warns', async () => {
    const http = fakeFetch([{ json: calculation([standardLine()]) }]);
    const result = await engine(http.fetch).calculate(
      waRequest({
        customer: { partyId: 'p', certificates: [certificate({ states: ['WA'], expiresOn: '2025-12-31' })] },
      }),
    );
    expect(formBody(http.calls[0])['customer_details[taxability_override]']).toBeUndefined();
    expect(result.warnings).toEqual(['certificate_expired']);
  });

  it('sends nothing for a state the entity is not registered in', async () => {
    const http = fakeFetch([{ json: calculation([]) }]);
    const result = await engine(http.fetch).calculate(waRequest({ registrations: [reg('ag_tx', 'TX')] }));
    expect(http.calls).toHaveLength(0);
    expect(result.warnings).toEqual(['not_registered_in_state']);
    expect(result.sourcing).toBe('none');
    expect(result.lines[0]).toMatchObject({ grossAmount: 100, tax: 0 });
  });

  it('sends nothing without a ship-to or for a marketplace sale', async () => {
    const http = fakeFetch([{ json: calculation([]) }]);
    expect((await engine(http.fetch).calculate(waRequest({ shipTo: null }))).warnings).toEqual(['no_ship_to']);
    expect((await engine(http.fetch).calculate(waRequest({ marketplaceFacilitated: true }))).warnings).toEqual([
      'marketplace_facilitated',
    ]);
    expect(http.calls).toHaveLength(0);
  });

  it('leaves zero-amount lines out of the request', async () => {
    const http = fakeFetch([{ json: calculation([standardLine('l2')]) }]);
    const result = await engine(http.fetch).calculate(waRequest({ lines: [line('l1', 0), line('l2', 100)] }));
    expect(formBody(http.calls[0])['line_items[0][reference]']).toBe('l2');
    expect(formBody(http.calls[0])['line_items[1][reference]']).toBeUndefined();
    expect(result.lines.map((l) => l.lineId)).toEqual(['l1', 'l2']);
    expect(result.lines[0].tax).toBe(0);
    expect(result.lines[1].tax).toBe(9.25);
  });

  it('refuses negative amounts: a credit memo reuses the original tax', async () => {
    const http = fakeFetch([{ json: calculation([]) }]);
    await expect(engine(http.fetch).calculate(waRequest({ lines: [line('l1', -5)] }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(http.calls).toHaveLength(0);
  });

  it('refuses use tax', async () => {
    const http = fakeFetch([{ json: calculation([]) }]);
    await expect(engine(http.fetch).calculate(waRequest({ direction: 'use' }))).rejects.toBeInstanceOf(SalesTaxEngineError);
    expect(http.calls).toHaveLength(0);
  });

  it('keeps an override, spread over the jurisdictions, and flags it', async () => {
    const http = fakeFetch([{ json: calculation([standardLine()]) }]);
    const result = await engine(http.fetch).calculate(
      waRequest({ lines: [line('l1', 100, { override: { amount: 5, reason: 'negotiated' } })] }),
    );
    const l = result.lines[0];
    expect(l.tax).toBe(5);
    expect(l.overridden).toBe(true);
    expect(l.overrideReason).toBe('negotiated');
    expect(Math.round(l.details.reduce((s, d) => s + d.tax, 0) * 100)).toBe(500);
    expect(result.totalTax).toBe(5);
  });

  it('passes tax_date for a document inside the two-day window, and says when it cannot', async () => {
    const recent = fakeFetch([{ json: calculation([standardLine()]) }]);
    const a = await engine(recent.fetch).calculate(waRequest({ documentDate: '2026-03-15' }));
    expect(formBody(recent.calls[0]).tax_date).toBe(String(Date.parse('2026-03-15T12:00:00Z') / 1000));
    expect(a.warnings).toEqual([]);

    const old = fakeFetch([{ json: calculation([standardLine()]) }]);
    const b = await engine(old.fetch).calculate(waRequest({ documentDate: '2025-11-01' }));
    expect(formBody(old.calls[0]).tax_date).toBeUndefined();
    expect(b.warnings).toContain('provider_rate_date_ignored');
  });

  it('uses the injected tax code mapper', async () => {
    const http = fakeFetch([{ json: calculation([standardLine()]) }]);
    await engine(http.fetch, { mapTaxCode: () => 'txcd_12345678' }).calculate(waRequest());
    expect(formBody(http.calls[0])['line_items[0][tax_code]']).toBe('txcd_12345678');
  });

  it('maps WeldBooks tax codes by default, SaaS by the use of the buyer', async () => {
    const http = fakeFetch([{ json: calculation([standardLine('a'), standardLine('b')]) }]);
    await engine(http.fetch).calculate(
      waRequest({
        lines: [line('a', 100, { taxCode: 'saas', use: 'business' }), line('b', 100, { taxCode: 'saas', use: 'personal' })],
      }),
    );
    const body = formBody(http.calls[0]);
    expect(body['line_items[0][tax_code]']).toBe('txcd_10103001');
    expect(body['line_items[1][tax_code]']).toBe('txcd_10103000');
  });

  it('an unmapped tax code is an error, not a taxable default', async () => {
    const http = fakeFetch([{ json: calculation([]) }]);
    await expect(
      engine(http.fetch).calculate(waRequest({ lines: [line('a', 100, { taxCode: 'mystery_box' })] })),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('Stripe Tax: failures never post zero tax', () => {
  const failing = (status: number, json: unknown = { error: { type: 'api_error', message: 'boom' } }) =>
    engine(fakeFetch([{ status, json }]).fetch).calculate(waRequest());

  it('401 is an auth error', async () => {
    await expect(failing(401, { error: { message: 'Invalid API Key provided' } })).rejects.toMatchObject({
      name: 'SalesTaxEngineError',
      code: 'auth',
      retryable: false,
    });
  });

  it('429 is rate limited and retryable', async () => {
    await expect(failing(429)).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('500 is unreachable and retryable', async () => {
    await expect(failing(500)).rejects.toMatchObject({ code: 'unreachable', retryable: true });
    await expect(failing(503, {})).rejects.toMatchObject({ code: 'unreachable', retryable: true });
  });

  it('400 is an invalid request with Stripe\'s message', async () => {
    const error = await failing(400, { error: { type: 'invalid_request_error', message: 'Could not resolve the address' } }).catch(
      (e: SalesTaxEngineError) => e,
    );
    expect(error).toMatchObject({ code: 'invalid_request', retryable: false });
    expect((error as Error).message).toContain('Could not resolve the address');
  });

  it('a network failure is unreachable and retryable', async () => {
    const http = fakeFetch([{ throws: new TypeError('fetch failed') }]);
    await expect(engine(http.fetch).calculate(waRequest())).rejects.toMatchObject({ code: 'unreachable', retryable: true });
  });

  it('never puts the API key in an error message', async () => {
    const error = await failing(401).catch((e: Error) => e);
    expect((error as Error).message).not.toContain(API_KEY);
  });
});

describe('Stripe Tax: commit, reverse, void', () => {
  it('commit records the calculation under the document number', async () => {
    const http = fakeFetch([{ json: { id: 'tax_txn_1Fixture', object: 'tax.transaction' } }]);
    const e = engine(http.fetch);
    const req = waRequest();
    const out = await e.commit!(req, emptyResult({ engine: 'stripe_tax', engineRef: 'taxcalc_1Fixture' }));
    expect(out).toEqual({ ref: 'tax_txn_1Fixture' });
    const call = http.calls[0];
    expect(call.url).toBe('https://api.stripe.com/v1/tax/transactions/create_from_calculation');
    expect(call.method).toBe('POST');
    expect(formBody(call)).toEqual({ calculation: 'taxcalc_1Fixture', reference: 'INV-0001' });
    expect(call.headers['idempotency-key']).toBeTruthy();
  });

  it('commit needs a Stripe calculation and a document number', async () => {
    const http = fakeFetch([{ json: {} }]);
    const e = engine(http.fetch);
    const base = emptyResult();
    await expect(e.commit!(waRequest(), base)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      e.commit!(waRequest({ documentNumber: undefined, documentId: undefined }), { ...base, engineRef: 'taxcalc_x' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(http.calls).toHaveLength(0);
  });

  it('reverse sends a partial reversal with negative amounts against the original line items', async () => {
    const http = fakeFetch([
      {
        json: {
          object: 'list',
          has_more: false,
          data: [
            { id: 'tax_li_a', reference: 'a', amount: 10000, amount_tax: 925, tax_behavior: 'exclusive' },
            { id: 'tax_li_b', reference: 'b', amount: 5000, amount_tax: 0, tax_behavior: 'exclusive' },
          ],
        },
      },
      { json: { id: 'tax_txn_rev', object: 'tax.transaction' } },
    ]);
    const out = await engine(http.fetch).reverse!('tax_txn_1Fixture', [{ lineId: 'a', amount: 40, tax: 3.7 }], {
      documentNumber: 'CM-0001',
      date: '2026-03-20',
    });
    expect(out).toEqual({ ref: 'tax_txn_rev' });

    expect(http.calls[0].method).toBe('GET');
    expect(http.calls[0].url).toContain('/v1/tax/transactions/tax_txn_1Fixture/line_items');
    const call = http.calls[1];
    expect(call.url).toBe('https://api.stripe.com/v1/tax/transactions/create_reversal');
    expect(formBody(call)).toMatchObject({
      mode: 'partial',
      original_transaction: 'tax_txn_1Fixture',
      reference: 'CM-0001',
      'line_items[0][amount]': '-4000',
      'line_items[0][amount_tax]': '-370',
      'line_items[0][original_line_item]': 'tax_li_a',
      'line_items[0][reference]': 'CM-0001:a',
      'metadata[document_date]': '2026-03-20',
    });
  });

  it('reverse of an inclusive line puts the tax in the amount', async () => {
    const http = fakeFetch([
      { json: { has_more: false, data: [{ id: 'tax_li_a', reference: 'a', amount: 10925, amount_tax: 925, tax_behavior: 'inclusive' }] } },
      { json: { id: 'tax_txn_rev' } },
    ]);
    await engine(http.fetch).reverse!('tax_txn_1', [{ lineId: 'a', amount: 100, tax: 9.25 }], {
      documentNumber: 'CM-2',
      date: '2026-03-20',
    });
    expect(formBody(http.calls[1])['line_items[0][amount]']).toBe('-10925');
    expect(formBody(http.calls[1])['line_items[0][amount_tax]']).toBe('-925');
  });

  it('reverse refuses a line that is not on the original transaction', async () => {
    const http = fakeFetch([{ json: { has_more: false, data: [{ id: 'tax_li_a', reference: 'a' }] } }]);
    await expect(
      engine(http.fetch).reverse!('tax_txn_1', [{ lineId: 'zzz', amount: 1, tax: 0 }], { documentNumber: 'CM', date: '2026-03-20' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('void is a full reversal', async () => {
    const http = fakeFetch([{ json: { id: 'tax_txn_void' } }]);
    await engine(http.fetch).void!('tax_txn_1Fixture');
    const call = http.calls[0];
    expect(call.url).toBe('https://api.stripe.com/v1/tax/transactions/create_reversal');
    expect(formBody(call)).toEqual({
      mode: 'full',
      original_transaction: 'tax_txn_1Fixture',
      reference: 'void-tax_txn_1Fixture',
    });
  });
});

describe('Stripe Tax: registrations', () => {
  it('lists the active US state registrations, following pagination', async () => {
    const http = fakeFetch([
      {
        json: {
          has_more: true,
          data: [
            { id: 'taxreg_1', country: 'US', status: 'active', country_options: { us: { state: 'WA', type: 'state_sales_tax' } } },
            { id: 'taxreg_2', country: 'US', status: 'active', country_options: { us: { state: 'CA', type: 'local_amusement_tax' } } },
            { id: 'taxreg_3', country: 'NL', status: 'active', country_options: { nl: { type: 'standard' } } },
          ],
        },
      },
      {
        json: {
          has_more: false,
          data: [{ id: 'taxreg_4', country: 'US', status: 'active', country_options: { us: { state: 'tx', type: 'state_sales_tax' } } }],
        },
      },
    ]);
    const list = await engine(http.fetch).listRegistrations!();
    expect(list).toEqual([
      { stateCode: 'WA', ref: 'taxreg_1', active: true },
      { stateCode: 'TX', ref: 'taxreg_4', active: true },
    ]);
    expect(http.calls[0].url).toBe('https://api.stripe.com/v1/tax/registrations?status=active&limit=100');
    expect(http.calls[1].url).toContain('starting_after=taxreg_3');
  });
});

describe('Stripe Tax: fixture sanity', () => {
  it('the shared registrations cover Washington', () => {
    expect(REGISTRATIONS.some((r) => r.stateCode === 'WA')).toBe(true);
  });
});
