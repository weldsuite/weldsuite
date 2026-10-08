import { describe, expect, it } from 'vitest';
import { AVALARA_ENTITY_USE_CODE, createAvalaraEngine } from './avalara';
import { fakeFetch, jsonBody } from './test-http';
import { WA_SELLER, addr, certificate, emptyResult, line, reg, request } from './test-fixtures';

const NOW = () => new Date('2026-03-15T12:00:00.000Z');

function engine(fetchImpl: typeof fetch, extra = {}) {
  return createAvalaraEngine({
    accountId: '1100000000',
    licenseKey: 'license-key-secret',
    companyCode: 'WELD',
    environment: 'sandbox',
    fetch: fetchImpl,
    now: NOW,
    ...extra,
  });
}

const waRequest = (extra = {}) =>
  request({ shipFrom: WA_SELLER, shipTo: addr('WA', '98001', 'Alpha'), ...extra });

function detail(
  jurisType: string,
  jurisCode: string,
  jurisName: string,
  rate: number,
  tax: number,
  extra: Record<string, unknown> = {},
) {
  return {
    jurisType,
    jurisCode,
    jurisName,
    region: 'WA',
    country: 'US',
    rate,
    tax,
    taxableAmount: 100,
    exemptAmount: 0,
    nonTaxableAmount: 0,
    stateAssignedNo: null,
    ...extra,
  };
}

/** A recorded transaction: invented rates, real shape (AvaTax rates are fractions). */
function transaction(lines: unknown[], extra: Record<string, unknown> = {}) {
  return { id: 99, code: 'tx-guid-1', date: '2026-03-15', status: 'Temporary', lines, ...extra };
}

const standardLine = (lineNumber = 'l1') => ({
  lineNumber,
  lineAmount: 100,
  taxIncluded: false,
  tax: 9.25,
  details: [
    detail('STA', '53', 'WASHINGTON', 0.06, 6, { stateAssignedNo: '0000' }),
    detail('CIT', '5300001', 'ALPHA', 0.02, 2, { stateAssignedNo: '1001' }),
    detail('STJ', '5300002', 'REGIONAL TRANSIT', 0.01, 1, { stateAssignedNo: '1002' }),
    detail('STJ', '5300003', 'ALPHA BENEFIT DISTRICT', 0.0025, 0.25),
  ],
});

describe('Avalara: calculate', () => {
  it('creates a temporary SalesOrder with Basic auth against the sandbox', async () => {
    const http = fakeFetch([{ json: transaction([standardLine()]) }]);
    await engine(http.fetch).calculate(
      waRequest({ lines: [line('l1', 100, { quantity: 3 })], shipTo: { ...addr('WA', '98001', 'Alpha'), line1: '5 Fixture Way' } }),
    );

    const call = http.calls[0];
    expect(call.url).toBe('https://sandbox-rest.avatax.com/api/v2/transactions/create');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from('1100000000:license-key-secret').toString('base64')}`);
    expect(call.headers['x-avalara-client']).toContain('WeldBooks');
    expect(call.headers['content-type']).toBe('application/json');

    const body = jsonBody(call);
    expect(body).toMatchObject({
      type: 'SalesOrder',
      companyCode: 'WELD',
      date: '2026-03-15',
      customerCode: 'party_1',
      currencyCode: 'USD',
      commit: false,
      addresses: {
        shipFrom: { line1: '3 Pike', city: 'Alpha', region: 'WA', postalCode: '98001', country: 'US' },
        shipTo: { line1: '5 Fixture Way', city: 'Alpha', region: 'WA', postalCode: '98001', country: 'US' },
      },
      lines: [{ number: 'l1', quantity: 3, amount: 100, taxCode: 'P0000000', taxIncluded: false }],
    });
    expect(body.exemptionNo).toBeUndefined();
    expect(body.code).toBeUndefined();
  });

  it('uses the production host for a production account', async () => {
    const http = fakeFetch([{ json: transaction([standardLine()]) }]);
    await engine(http.fetch, { environment: 'production' }).calculate(waRequest());
    expect(http.calls[0].url).toBe('https://rest.avatax.com/api/v2/transactions/create');
  });

  it('maps jurisdictions: state, city and special districts, rates as percent', async () => {
    const http = fakeFetch([{ json: transaction([standardLine()]) }]);
    const result = await engine(http.fetch).calculate(waRequest());

    expect(result.engine).toBe('avalara');
    expect(result.engineRef).toBe('tx-guid-1');
    expect(result.sourcing).toBe('destination');
    expect(result.totalTax).toBe(9.25);
    expect(result.warnings).toEqual([]);

    const l = result.lines[0];
    expect(l).toMatchObject({ grossAmount: 100, taxableAmount: 100, exemptAmount: 0, nonTaxableAmount: 0, tax: 9.25 });
    expect(l.details.map((d) => [d.level, d.jurisdictionName, d.jurisdictionCode, d.rate, d.tax])).toEqual([
      ['state', 'WASHINGTON', '53', 6, 6],
      ['city', 'ALPHA', '5300001', 2, 2],
      ['district', 'REGIONAL TRANSIT', '5300002', 1, 1],
      ['district', 'ALPHA BENEFIT DISTRICT', '5300003', 0.25, 0.25],
    ]);
    expect(l.details[0]).toMatchObject({ stateCode: 'WA', agencyId: 'ag_wa', reportingCode: '0000', unroundedTax: 6 });
    expect(l.details[3].reportingCode).toBeUndefined();
  });

  it('maps the county level and ignores the country level', async () => {
    const lineItem = {
      ...standardLine(),
      details: [
        detail('CNT', 'US', 'UNITED STATES', 0, 0),
        detail('STA', '53', 'WASHINGTON', 0.06, 6),
        detail('CTY', '53033', 'FIXTURE COUNTY', 0.005, 0.5),
      ],
    };
    const http = fakeFetch([{ json: transaction([lineItem]) }]);
    const result = await engine(http.fetch).calculate(waRequest());
    expect(result.lines[0].details.map((d) => d.level)).toEqual(['state', 'county']);
  });

  it('sends the exemption number and entity use code for an exempt customer', async () => {
    const exemptLine = {
      ...standardLine(),
      tax: 0,
      details: [
        detail('STA', '53', 'WASHINGTON', 0.06, 0, { taxableAmount: 0, exemptAmount: 100 }),
        detail('CIT', '5300001', 'ALPHA', 0.02, 0, { taxableAmount: 0, exemptAmount: 100 }),
      ],
    };
    const http = fakeFetch([{ json: transaction([exemptLine]) }]);
    const result = await engine(http.fetch).calculate(
      waRequest({
        customer: {
          partyId: 'p',
          certificates: [certificate({ states: ['WA'], reason: 'government', certificateNumber: 'GOV-77' })],
        },
      }),
    );
    const body = jsonBody(http.calls[0]);
    expect(body.exemptionNo).toBe('GOV-77');
    expect(body.entityUseCode).toBe('B');
    expect(result.totalTax).toBe(0);
    for (const d of result.lines[0].details) {
      expect(d).toMatchObject({ exemptAmount: 100, taxableAmount: 0, exemptReason: 'government', certificateId: 'cert_1' });
    }
  });

  it('maps every certificate reason to an entity use code', () => {
    expect(AVALARA_ENTITY_USE_CODE).toEqual({
      resale: 'G',
      nonprofit: 'E',
      government: 'B',
      manufacturing: 'I',
      agricultural: 'H',
      other: 'L',
    });
  });

  it('backs out tax-inclusive lines', async () => {
    const lineItem = { ...standardLine(), lineAmount: 109.25, taxIncluded: true };
    const http = fakeFetch([{ json: transaction([lineItem]) }]);
    const result = await engine(http.fetch).calculate(waRequest({ lines: [line('l1', 109.25, { taxIncluded: true })] }));
    expect(jsonBody<{ lines: Array<{ taxIncluded: boolean }> }>(http.calls[0]).lines[0].taxIncluded).toBe(true);
    expect(result.lines[0]).toMatchObject({ grossAmount: 100, tax: 9.25 });
  });

  it('a non-taxable part comes through per jurisdiction', async () => {
    const lineItem = {
      ...standardLine(),
      tax: 0,
      details: [detail('STA', '53', 'WASHINGTON', 0.06, 0, { taxableAmount: 0, nonTaxableAmount: 100 })],
    };
    const http = fakeFetch([{ json: transaction([lineItem]) }]);
    const result = await engine(http.fetch).calculate(waRequest());
    expect(result.lines[0]).toMatchObject({ taxableAmount: 0, nonTaxableAmount: 100, tax: 0 });
  });

  it('sends nothing for a state the entity is not registered in', async () => {
    const http = fakeFetch([{ json: transaction([]) }]);
    const result = await engine(http.fetch).calculate(waRequest({ registrations: [reg('ag_tx', 'TX')] }));
    expect(http.calls).toHaveLength(0);
    expect(result.warnings).toEqual(['not_registered_in_state']);
    expect(result.totalTax).toBe(0);
  });

  it('keeps the sale on the ledger when Avalara has no nexus there', async () => {
    const http = fakeFetch([{ json: transaction([{ lineNumber: 'l1', lineAmount: 100, tax: 0, details: [] }]) }]);
    const result = await engine(http.fetch).calculate(waRequest());
    expect(result.warnings).toContain('provider_nexus_missing');
    expect(result.lines[0].details).toEqual([
      expect.objectContaining({ level: 'state', stateCode: 'WA', rate: 0, tax: 0, nonTaxableAmount: 100 }),
    ]);
  });

  it('computes use tax as a PurchaseOrder at the delivery address, without a registration', async () => {
    const http = fakeFetch([{ json: transaction([standardLine()]) }]);
    const result = await engine(http.fetch).calculate(
      waRequest({
        documentType: 'bill',
        direction: 'use',
        shipFrom: addr('NY', '10001'),
        registrations: [reg('ag_tx', 'TX')],
        customer: { partyId: 'v1', certificates: [certificate({ states: ['WA'] })] },
      }),
    );
    const body = jsonBody(http.calls[0]);
    expect(body.type).toBe('PurchaseOrder');
    expect(body.exemptionNo).toBeUndefined();
    expect(result.warnings).toEqual(['no_use_tax_registration']);
    expect(result.totalTax).toBe(9.25);
    expect(result.lines[0].details[0].agencyId).toBeUndefined();
  });

  it('keeps an override, spread over the jurisdictions', async () => {
    const http = fakeFetch([{ json: transaction([standardLine()]) }]);
    const result = await engine(http.fetch).calculate(
      waRequest({ lines: [line('l1', 100, { override: { amount: 7, reason: 'rounded for the customer' } })] }),
    );
    expect(result.lines[0]).toMatchObject({ tax: 7, overridden: true, overrideReason: 'rounded for the customer' });
    expect(Math.round(result.lines[0].details.reduce((s, d) => s + d.tax, 0) * 100)).toBe(700);
  });

  it('uses the injected tax code mapper', async () => {
    const http = fakeFetch([{ json: transaction([standardLine()]) }]);
    await engine(http.fetch, { mapTaxCode: () => 'PC040100' }).calculate(waRequest());
    expect(jsonBody<{ lines: Array<{ taxCode: string }> }>(http.calls[0]).lines[0].taxCode).toBe('PC040100');
  });

  it('maps WeldBooks tax codes by default', async () => {
    const http = fakeFetch([{ json: transaction([standardLine('a'), standardLine('b')]) }]);
    await engine(http.fetch).calculate(
      waRequest({ lines: [line('a', 100, { taxCode: 'shipping' }), line('b', 100, { taxCode: 'non_taxable' })] }),
    );
    const sent = jsonBody<{ lines: Array<{ taxCode: string }> }>(http.calls[0]).lines.map((l) => l.taxCode);
    expect(sent).toEqual(['FR020100', 'NT']);
  });
});

describe('Avalara: failures never post zero tax', () => {
  const failing = (status: number, json: unknown) =>
    engine(fakeFetch([{ status, json }]).fetch).calculate(waRequest());

  it('401 is an auth error', async () => {
    await expect(
      failing(401, { error: { code: 'AuthenticationException', message: 'Invalid credentials' } }),
    ).rejects.toMatchObject({ code: 'auth', retryable: false });
  });

  it('429 is rate limited and retryable', async () => {
    await expect(failing(429, {})).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('5xx is unreachable and retryable', async () => {
    await expect(failing(500, { error: { message: 'internal' } })).rejects.toMatchObject({ code: 'unreachable', retryable: true });
    await expect(failing(502, undefined)).rejects.toMatchObject({ code: 'unreachable', retryable: true });
  });

  it('400 is an invalid request with the detail Avalara gave', async () => {
    const error = await failing(400, {
      error: {
        code: 'GetTaxError',
        message: 'Address validation failed',
        details: [{ message: 'The address is not deliverable', severity: 'Error' }],
      },
    }).catch((e: Error) => e);
    expect(error).toMatchObject({ code: 'invalid_request', retryable: false });
    expect((error as Error).message).toContain('The address is not deliverable');
  });

  it('a network failure is unreachable and retryable', async () => {
    const http = fakeFetch([{ throws: new TypeError('fetch failed') }]);
    await expect(engine(http.fetch).calculate(waRequest())).rejects.toMatchObject({ code: 'unreachable', retryable: true });
  });

  it('never puts the license key in an error message', async () => {
    const error = await failing(401, { error: { message: 'bad key' } }).catch((e: Error) => e);
    expect((error as Error).message).not.toContain('license-key-secret');
  });
});

describe('Avalara: commit, reverse, void', () => {
  it('commit records a SalesInvoice under the document number', async () => {
    const http = fakeFetch([{ json: transaction([standardLine()], { code: 'INV-0001', status: 'Committed' }) }]);
    const out = await engine(http.fetch).commit!(waRequest(), emptyResult());
    expect(out).toEqual({ ref: 'INV-0001' });
    expect(jsonBody(http.calls[0])).toMatchObject({ type: 'SalesInvoice', commit: true, code: 'INV-0001' });
  });

  it('commit sends a hand-set tax as a tax override on its line', async () => {
    const http = fakeFetch([{ json: transaction([standardLine()], { code: 'INV-0001' }) }]);
    await engine(http.fetch).commit!(
      waRequest({ lines: [line('l1', 100, { override: { amount: 5, reason: 'agreed' } })] }),
      emptyResult(),
    );
    const body = jsonBody<{ lines: Array<{ taxOverride?: Record<string, unknown> }> }>(http.calls[0]);
    expect(body.lines[0].taxOverride).toEqual({ type: 'taxAmount', taxAmount: 5, reason: 'agreed' });
  });

  it('commit of a use tax document is a PurchaseInvoice and the ref says so', async () => {
    const http = fakeFetch([{ json: transaction([standardLine()], { code: 'BILL-9' }) }]);
    const out = await engine(http.fetch).commit!(
      waRequest({ direction: 'use', documentNumber: 'BILL-9', shipFrom: addr('NY', '10001') }),
      emptyResult(),
    );
    expect(jsonBody(http.calls[0]).type).toBe('PurchaseInvoice');
    expect(out.ref).toBe('PurchaseInvoice:BILL-9');
  });

  it('commit needs a document number', async () => {
    const http = fakeFetch([{ json: {} }]);
    await expect(
      engine(http.fetch).commit!(waRequest({ documentNumber: undefined, documentId: undefined }), emptyResult()),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  const original = {
    code: 'INV-0001',
    date: '2026-03-01',
    lines: [
      { lineNumber: '1', lineAmount: 100, taxIncluded: false, tax: 9.25 },
      { lineNumber: '2', lineAmount: 50, taxIncluded: false, tax: 4.63 },
    ],
  };

  it('reverse of every line in full is a full refund at the original tax date', async () => {
    const http = fakeFetch([{ json: original }, { json: { code: 'CM-0001' } }]);
    const out = await engine(http.fetch).reverse!(
      'INV-0001',
      [
        { lineId: '1', amount: 100, tax: 9.25 },
        { lineId: '2', amount: 50, tax: 4.63 },
      ],
      { documentNumber: 'CM-0001', date: '2026-03-20' },
    );
    expect(out).toEqual({ ref: 'CM-0001' });
    expect(http.calls[0].method).toBe('GET');
    expect(http.calls[0].url).toContain('/api/v2/companies/WELD/transactions/INV-0001');
    expect(http.calls[0].url).toContain('documentType=SalesInvoice');
    expect(http.calls[1].url).toBe(
      'https://sandbox-rest.avatax.com/api/v2/companies/WELD/transactions/INV-0001/refund?documentType=SalesInvoice',
    );
    expect(jsonBody(http.calls[1])).toEqual({
      refundTransactionCode: 'CM-0001',
      refundDate: '2026-03-20',
      refundTaxDate: '2026-03-01',
      referenceCode: 'INV-0001',
      refundType: 'Full',
    });
  });

  it('reverse of whole lines refunds those lines', async () => {
    const http = fakeFetch([{ json: original }, { json: { code: 'CM-0002' } }]);
    await engine(http.fetch).reverse!('INV-0001', [{ lineId: '2', amount: 50, tax: 4.63 }], {
      documentNumber: 'CM-0002',
      date: '2026-03-20',
    });
    expect(jsonBody(http.calls[1])).toMatchObject({ refundType: 'Partial', refundLines: ['2'] });
  });

  it('reverse of the same share of every line is a percentage refund', async () => {
    const http = fakeFetch([{ json: original }, { json: { code: 'CM-0003' } }]);
    await engine(http.fetch).reverse!(
      'INV-0001',
      [
        { lineId: '1', amount: 25, tax: 2.31 },
        { lineId: '2', amount: 12.5, tax: 1.16 },
      ],
      { documentNumber: 'CM-0003', date: '2026-03-20' },
    );
    expect(jsonBody(http.calls[1])).toMatchObject({ refundType: 'Percentage', refundPercentage: 25 });
  });

  it('reverse refuses a partial amount Avalara cannot express, before calling it', async () => {
    const http = fakeFetch([{ json: original }, { json: { code: 'x' } }]);
    await expect(
      engine(http.fetch).reverse!('INV-0001', [{ lineId: '1', amount: 40, tax: 3.7 }], {
        documentNumber: 'CM-0004',
        date: '2026-03-20',
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(http.calls).toHaveLength(1);
  });

  it('reverse refuses a line that is not on the transaction', async () => {
    const http = fakeFetch([{ json: original }]);
    await expect(
      engine(http.fetch).reverse!('INV-0001', [{ lineId: '9', amount: 1, tax: 0 }], { documentNumber: 'CM', date: '2026-03-20' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('void sends DocVoided', async () => {
    const http = fakeFetch([{ json: { code: 'INV-0001', status: 'Cancelled' } }]);
    await engine(http.fetch).void!('INV-0001');
    expect(http.calls[0].url).toBe(
      'https://sandbox-rest.avatax.com/api/v2/companies/WELD/transactions/INV-0001/void?documentType=SalesInvoice',
    );
    expect(http.calls[0].method).toBe('POST');
    expect(jsonBody(http.calls[0])).toEqual({ code: 'DocVoided' });
  });

  it('void of a use tax document names its type', async () => {
    const http = fakeFetch([{ json: {} }]);
    await engine(http.fetch).void!('PurchaseInvoice:BILL-9');
    expect(http.calls[0].url).toContain('/transactions/BILL-9/void?documentType=PurchaseInvoice');
  });
});

describe('Avalara: addresses and registrations', () => {
  it('validates an address', async () => {
    const http = fakeFetch([
      {
        json: {
          validatedAddresses: [
            { line1: '5 FIXTURE WAY', city: 'ALPHA', region: 'WA', country: 'US', postalCode: '98001-1234' },
          ],
          messages: [],
        },
      },
    ]);
    const out = await engine(http.fetch).validateAddress!({ line1: '5 fixture way', city: 'alpha', state: 'WA', postalCode: '98001' });
    expect(http.calls[0].url).toBe('https://sandbox-rest.avatax.com/api/v2/addresses/resolve');
    expect(jsonBody(http.calls[0])).toMatchObject({ line1: '5 fixture way', region: 'WA', postalCode: '98001', country: 'US' });
    expect(out).toEqual({
      valid: true,
      normalized: { line1: '5 FIXTURE WAY', city: 'ALPHA', state: 'WA', postalCode: '98001-1234', country: 'US' },
    });
  });

  it('an address Avalara cannot match is invalid, with its message', async () => {
    const http = fakeFetch([
      {
        json: {
          validatedAddresses: [],
          messages: [{ summary: 'The address number is out of range', severity: 'Error' }],
        },
      },
    ]);
    const out = await engine(http.fetch).validateAddress!({ line1: '99999 Nowhere', state: 'WA', postalCode: '98001' });
    expect(out).toEqual({ valid: false, messages: ['The address number is out of range'] });
  });

  it('lists the US state nexus of the company', async () => {
    const http = fakeFetch([
      { json: { value: [{ id: 4242, companyCode: 'WELD' }] } },
      {
        json: {
          value: [
            { id: 1, country: 'US', region: 'WA', jurisTypeId: 'STA', nexusTypeId: 'SalesOrSellersUseTax', effectiveDate: '2020-01-01T00:00:00', endDate: null },
            { id: 2, country: 'US', region: 'TX', jurisTypeId: 'STA', nexusTypeId: 'SalesOrSellersUseTax', effectiveDate: '2020-01-01', endDate: '2025-12-31' },
            { id: 3, country: 'US', region: 'CA', jurisTypeId: 'STA', nexusTypeId: 'None' },
            { id: 4, country: 'US', region: 'WA', jurisTypeId: 'CTY', nexusTypeId: 'SalesOrSellersUseTax' },
            { id: 5, country: 'CA', region: 'ON', jurisTypeId: 'STA', nexusTypeId: 'SalesOrSellersUseTax' },
            { id: 6, country: 'US', region: 'NY', jurisTypeId: 'STA', nexusTypeId: 'SalesOrSellersUseTax', effectiveDate: '2027-01-01' },
          ],
        },
      },
    ]);
    const list = await engine(http.fetch).listRegistrations!();
    expect(http.calls[0].url).toContain('/api/v2/companies?');
    expect(decodeURIComponent(http.calls[0].url)).toContain("$filter=companyCode eq 'WELD'");
    expect(http.calls[1].url).toContain('/api/v2/companies/4242/nexus');
    expect(list).toEqual([
      { stateCode: 'WA', ref: '1', active: true },
      { stateCode: 'TX', ref: '2', active: false },
      { stateCode: 'NY', ref: '6', active: false },
    ]);
  });

  it('remembers the company id between calls', async () => {
    const http = fakeFetch([
      { json: { value: [{ id: 7 }] } },
      { json: { value: [] } },
      { json: { value: [] } },
    ]);
    const e = engine(http.fetch);
    await e.listRegistrations!();
    await e.listRegistrations!();
    expect(http.calls.map((c) => c.url.includes('/nexus'))).toEqual([false, true, true]);
  });

  it('an unknown company code is an invalid request', async () => {
    const http = fakeFetch([{ json: { value: [] } }]);
    await expect(engine(http.fetch).listRegistrations!()).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
