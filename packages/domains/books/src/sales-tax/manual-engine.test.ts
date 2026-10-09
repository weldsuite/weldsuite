import { describe, expect, it } from 'vitest';
import { createManualEngine } from './manual-engine';
import {
  CA_SELLER,
  REGISTRATIONS,
  TX_SELLER,
  WA_SELLER,
  addr,
  buildManualData,
  certificate,
  line,
  reg,
  request,
  rule,
} from './test-fixtures';

const FIXED_NOW = () => new Date('2026-03-15T12:00:00.000Z');

function engine(rules = buildManualData().rules) {
  return createManualEngine({ ...buildManualData(), rules }, { now: FIXED_NOW });
}

const codes = (r: Awaited<ReturnType<ReturnType<typeof engine>['calculate']>>, i = 0) =>
  r.lines[i].details.map((d) => `${d.jurisdictionCode}:${d.rate}:${d.tax}`);

describe('manual engine: golden scenarios', () => {
  it('1. origin state: a Texas sale is taxed at the seller location', async () => {
    const result = await engine().calculate(request({ shipTo: addr('TX', '78701') }));
    expect(result.sourcing).toBe('origin');
    expect(result.warnings).toEqual([]);
    expect(codes(result)).toEqual(['tx_state:5:5', 'tx_fixtown:1.5:1.5', 'tx_transit:0.75:0.75']);
    expect(result.lines[0].tax).toBe(7.25);
    expect(result.totalTax).toBe(7.25);
    expect(result.shipToState).toBe('TX');
    expect(result.shipToPostalCode).toBe('78701');
    expect(result.lines[0].details.every((d) => d.agencyId === 'ag_tx')).toBe(true);
    expect(result.lines[0].details[1].reportingCode).toBe('TX-1');
  });

  it('1b. origin state: a buyer in another Texas city still pays the seller location rate', async () => {
    const result = await engine().calculate(request({ shipTo: addr('TX', '78801', 'Otherville') }));
    expect(result.sourcing).toBe('origin');
    expect(result.lines[0].tax).toBe(7.25);
    expect(result.lines[0].details.map((d) => d.jurisdictionName)).toEqual(['Texas', 'Fixtown', 'Fixtown Transit']);
  });

  it('1c. a Texas seller shipping to a Washington buyer is destination sourced', async () => {
    const result = await engine().calculate(request({ shipTo: addr('WA', '98001') }));
    expect(result.sourcing).toBe('destination');
    expect(result.lines[0].tax).toBe(9);
  });

  it('2. registered only in Texas, ships to California: no tax and a nexus warning', async () => {
    const result = await engine().calculate(
      request({ shipTo: addr('CA', '95001'), registrations: [reg('ag_tx', 'TX')] }),
    );
    expect(result.sourcing).toBe('none');
    expect(result.warnings).toEqual(['not_registered_in_state']);
    expect(result.shipToState).toBe('CA');
    expect(result.totalTax).toBe(0);
    expect(result.lines[0]).toMatchObject({ grossAmount: 100, tax: 0, details: [] });
  });

  it('2b. a pending or closed registration does not collect', async () => {
    for (const status of ['pending', 'monitoring', 'closed'] as const) {
      const result = await engine().calculate(
        request({ shipTo: addr('WA', '98001'), registrations: [reg('ag_wa', 'WA', { status })] }),
      );
      expect(result.warnings).toContain('not_registered_in_state');
      expect(result.totalTax).toBe(0);
    }
  });

  it('2c. registration dates are checked on the document date', async () => {
    const registrations = [reg('ag_wa', 'WA', { registeredFrom: '2026-04-01' })];
    const before = await engine().calculate(request({ shipTo: addr('WA', '98001'), registrations }));
    expect(before.warnings).toContain('not_registered_in_state');
    const after = await engine().calculate(
      request({ shipTo: addr('WA', '98001'), registrations, documentDate: '2026-04-01' }),
    );
    expect(after.totalTax).toBe(9);
    const ended = await engine().calculate(
      request({
        shipTo: addr('WA', '98001'),
        registrations: [reg('ag_wa', 'WA', { registeredUntil: '2026-03-14' })],
      }),
    );
    expect(ended.warnings).toContain('not_registered_in_state');
  });

  it('2d. a state without any sales tax gets no warning', async () => {
    const result = await engine().calculate(request({ shipTo: addr('OR', '97201') }));
    expect(result.warnings).toEqual([]);
    expect(result.totalTax).toBe(0);
  });

  it('3. destination state: two Washington ZIPs in different zones', async () => {
    const e = engine();
    const alpha = await e.calculate(request({ shipFrom: WA_SELLER, shipTo: addr('WA', '98002') }));
    const beta = await e.calculate(request({ shipFrom: WA_SELLER, shipTo: addr('WA', '98105') }));
    expect(alpha.sourcing).toBe('destination');
    expect(alpha.lines[0].tax).toBe(9);
    expect(alpha.lines[0].details.map((d) => d.jurisdictionName)).toEqual(['Washington', 'Alpha', 'Regional Transit']);
    expect(beta.lines[0].tax).toBe(9.5);
    expect(beta.lines[0].details.map((d) => d.jurisdictionName)).toEqual(['Washington', 'Beta']);
  });

  it('3b. the lowest-priority zone wins when two cover the same ZIP', async () => {
    const data = buildManualData();
    data.zones.push({
      id: 'z_wa_special',
      agencyId: 'ag_wa',
      stateCode: 'WA',
      name: 'Special',
      jurisdictionIds: ['wa_state'],
      postalCodes: ['98105'],
      isOrigin: false,
      priority: 1,
    });
    const result = await createManualEngine(data, { now: FIXED_NOW }).calculate(
      request({ shipFrom: WA_SELLER, shipTo: addr('WA', '98105') }),
    );
    expect(result.lines[0].tax).toBe(6);
  });

  it('3c. a ZIP outside every zone falls back to the state rate and says so', async () => {
    const result = await engine().calculate(request({ shipFrom: WA_SELLER, shipTo: addr('WA', '99999') }));
    expect(result.lines[0].tax).toBe(6);
    expect(result.lines[0].details.map((d) => d.level)).toEqual(['state']);
    expect(result.warnings).toEqual(expect.arrayContaining(['zone_not_found', 'address_unverified']));
  });

  it('3d. a ZIP+4 matches its five-digit zone', async () => {
    const result = await engine().calculate(request({ shipFrom: WA_SELLER, shipTo: addr('WA', '98105-4321') }));
    expect(result.lines[0].tax).toBe(9.5);
    expect(result.shipToPostalCode).toBe('98105-4321');
  });

  it('4. a valid Florida resale certificate: no tax, reported as exempt resale', async () => {
    const result = await engine().calculate(
      request({
        shipTo: addr('FL', '33101'),
        customer: { partyId: 'p', certificates: [certificate()] },
        lines: [line('l1', 200)],
      }),
    );
    const l = result.lines[0];
    expect(result.warnings).toEqual([]);
    expect(l).toMatchObject({ grossAmount: 200, taxableAmount: 0, exemptAmount: 200, nonTaxableAmount: 0, tax: 0 });
    expect(l.details).toHaveLength(2);
    for (const d of l.details) {
      expect(d).toMatchObject({ exemptAmount: 200, taxableAmount: 0, tax: 0, exemptReason: 'resale', certificateId: 'cert_1' });
    }
  });

  it('5. the same customer after the certificate expired: taxed with a warning', async () => {
    const result = await engine().calculate(
      request({
        shipTo: addr('FL', '33101'),
        documentDate: '2027-01-15',
        customer: { partyId: 'p', certificates: [certificate()] },
        lines: [line('l1', 200)],
      }),
    );
    expect(result.warnings).toEqual(['certificate_expired']);
    expect(result.lines[0]).toMatchObject({ taxableAmount: 200, exemptAmount: 0, tax: 14 });
  });

  it('5b. an explicit expiry date beats the state rule, on the last day and the day after', async () => {
    const cert = certificate({ expiresOn: '2026-06-30' });
    const customer = { partyId: 'p', certificates: [cert] };
    const onLastDay = await engine().calculate(
      request({ shipTo: addr('FL', '33101'), documentDate: '2026-06-30', customer }),
    );
    expect(onLastDay.totalTax).toBe(0);
    const after = await engine().calculate(
      request({ shipTo: addr('FL', '33101'), documentDate: '2026-07-01', customer }),
    );
    expect(after.totalTax).toBe(7);
    expect(after.warnings).toEqual(['certificate_expired']);
  });

  it('5c. a certificate for another state does not exempt, and does not warn', async () => {
    const result = await engine().calculate(
      request({
        shipTo: addr('FL', '33101'),
        customer: { partyId: 'p', certificates: [certificate({ states: ['TX'] })] },
      }),
    );
    expect(result.totalTax).toBe(7);
    expect(result.warnings).toEqual([]);
  });

  it('5d. a pending certificate does not exempt and warns that it is missing', async () => {
    const result = await engine().calculate(
      request({
        shipTo: addr('FL', '33101'),
        customer: { partyId: 'p', certificates: [certificate({ status: 'pending' })] },
      }),
    );
    expect(result.totalTax).toBe(7);
    expect(result.warnings).toEqual(['certificate_missing']);
  });

  it('5e. a single-purchase certificate covers only its own invoice', async () => {
    const cert = certificate({ blanket: false, invoiceId: 'inv_9' });
    const customer = { partyId: 'p', certificates: [cert] };
    const other = await engine().calculate(request({ shipTo: addr('FL', '33101'), documentId: 'inv_1', customer }));
    expect(other.totalTax).toBe(7);
    const own = await engine().calculate(request({ shipTo: addr('FL', '33101'), documentId: 'inv_9', customer }));
    expect(own.totalTax).toBe(0);
  });

  it('6a. shipping is taxable in one agency and not in another', async () => {
    const rules = [rule('ag_wa', 'shipping', { taxable: false })];
    const e = engine(rules);
    const shipping = line('ship', 20, { taxCode: 'shipping' });
    const tx = await e.calculate(request({ shipTo: addr('TX', '78701'), lines: [shipping] }));
    const wa = await e.calculate(
      request({ shipFrom: WA_SELLER, shipTo: addr('WA', '98001'), lines: [shipping] }),
    );
    expect(tx.lines[0]).toMatchObject({ taxableAmount: 20, nonTaxableAmount: 0, tax: 1.45 });
    expect(wa.lines[0]).toMatchObject({ taxableAmount: 0, nonTaxableAmount: 20, tax: 0 });
    // Not taxed, but the sale is still reported with its jurisdictions.
    expect(wa.lines[0].details).toHaveLength(3);
    expect(wa.lines[0].details.every((d) => d.nonTaxableAmount === 20)).toBe(true);
  });

  it('6b. shipping taxed by the state agency and not by a self-administered city in one sale', async () => {
    const rules = [rule('ag_co_city', 'shipping', { taxable: false })];
    const result = await engine(rules).calculate(
      request({
        shipFrom: addr('CO', '80202'),
        shipTo: addr('CO', '80202'),
        lines: [line('ship', 100, { taxCode: 'shipping' }), line('goods', 100)],
      }),
    );
    const [ship, goods] = result.lines;
    expect(ship.details.map((d) => [d.agencyId, d.taxableAmount, d.nonTaxableAmount, d.tax])).toEqual([
      ['ag_co', 100, 0, 3],
      ['ag_co_city', 0, 100, 0],
    ]);
    expect(goods.tax).toBe(7);
    expect(ship.taxableAmount).toBe(100);
  });

  it('9a. taxable on 80% of the price (Texas SaaS)', async () => {
    const rules = [rule('ag_tx', 'saas', { taxablePercent: 80 })];
    const result = await engine(rules).calculate(
      request({ lines: [line('saas', 100, { taxCode: 'saas' })], shipTo: addr('TX', '78701') }),
    );
    expect(result.lines[0]).toMatchObject({ taxableAmount: 80, nonTaxableAmount: 20, tax: 5.8 });
  });

  it('9b. a code that turns taxable on an effective date (California SaaS, 1 January 2027)', async () => {
    const rules = [
      rule('ag_ca', 'saas', { taxable: false, effectiveFrom: '2020-01-01', effectiveTo: '2026-12-31' }),
      rule('ag_ca', 'saas', { taxable: true, effectiveFrom: '2027-01-01' }),
    ];
    const e = engine(rules);
    const base = { shipFrom: CA_SELLER, shipTo: addr('CA', '94001'), lines: [line('saas', 100, { taxCode: 'saas' })] };
    const before = await e.calculate(request({ ...base, documentDate: '2026-12-31' }));
    const after = await e.calculate(request({ ...base, documentDate: '2027-01-01' }));
    expect(before.totalTax).toBe(0);
    expect(before.lines[0].nonTaxableAmount).toBe(100);
    expect(after.totalTax).toBe(7.25);
  });

  it('9c. a rate override replaces the combined rate (Maryland business SaaS at 3%)', async () => {
    const rules = [rule('ag_md', 'saas', { appliesToUse: 'business', rateOverride: 3 })];
    const e = engine(rules);
    const business = await e.calculate(
      request({ shipTo: addr('MD', '21201'), lines: [line('saas', 100, { taxCode: 'saas', use: 'business' })] }),
    );
    const personal = await e.calculate(
      request({ shipTo: addr('MD', '21201'), lines: [line('saas', 100, { taxCode: 'saas', use: 'personal' })] }),
    );
    expect(business.lines[0].tax).toBe(3);
    expect(business.lines[0].details[0].rate).toBe(3);
    expect(personal.lines[0].tax).toBe(6);
  });
});

describe('manual engine: rates, sourcing and rules', () => {
  it('picks the rate by the tax point, not by today', async () => {
    const e = engine();
    const base = { shipFrom: addr('KY', '40202'), shipTo: addr('KY', '40202') };
    const before = await e.calculate(request({ ...base, documentDate: '2026-06-30' }));
    const after = await e.calculate(request({ ...base, documentDate: '2026-07-01' }));
    expect(before.totalTax).toBe(5);
    expect(after.totalTax).toBe(5.5);
  });

  it('modified origin (California): state, county and city at the seller, district at the buyer', async () => {
    const result = await engine().calculate(request({ shipFrom: CA_SELLER, shipTo: addr('CA', '95001') }));
    expect(result.sourcing).toBe('modified_origin');
    expect(result.lines[0].details.map((d) => `${d.level}:${d.jurisdictionName}`)).toEqual([
      'state:California',
      'county:Origin County',
      'city:Origin City',
      'district:Buyer District',
    ]);
    expect(result.lines[0].tax).toBe(8.75);
  });

  it('an interstate sale into California is destination sourced', async () => {
    const result = await engine().calculate(request({ shipFrom: TX_SELLER, shipTo: addr('CA', '95001') }));
    expect(result.sourcing).toBe('destination');
    expect(result.lines[0].tax).toBe(8.75);
  });

  it('no ship-to: no tax and a warning', async () => {
    const result = await engine().calculate(request({ shipTo: null }));
    expect(result.warnings).toEqual(['no_ship_to']);
    expect(result.sourcing).toBe('none');
    expect(result.totalTax).toBe(0);
  });

  it('marketplace-facilitated: no tax and a warning, the sale keeps its amount', async () => {
    const result = await engine().calculate(request({ marketplaceFacilitated: true }));
    expect(result.warnings).toEqual(['marketplace_facilitated']);
    expect(result.totalTax).toBe(0);
    expect(result.lines[0].grossAmount).toBe(100);
  });

  it('the non_taxable code is never taxed', async () => {
    const result = await engine().calculate(request({ lines: [line('l1', 100, { taxCode: 'non_taxable' })] }));
    expect(result.lines[0]).toMatchObject({ taxableAmount: 0, nonTaxableAmount: 100, tax: 0 });
  });

  it('a non-taxable line is not exempted by a certificate (it was never taxable)', async () => {
    const result = await engine().calculate(
      request({
        shipTo: addr('FL', '33101'),
        customer: { partyId: 'p', certificates: [certificate()] },
        lines: [line('l1', 100, { taxCode: 'non_taxable' })],
      }),
    );
    expect(result.lines[0]).toMatchObject({ exemptAmount: 0, nonTaxableAmount: 100 });
  });

  it('a rule for a personal use beats the rule for any use', async () => {
    const rules = [
      rule('ag_tx', 'saas', { taxable: false }),
      rule('ag_tx', 'saas', { appliesToUse: 'personal', taxable: true }),
    ];
    const e = engine(rules);
    const biz = await e.calculate(request({ lines: [line('a', 100, { taxCode: 'saas', use: 'business' })] }));
    const personal = await e.calculate(request({ lines: [line('a', 100, { taxCode: 'saas', use: 'personal' })] }));
    expect(biz.totalTax).toBe(0);
    expect(personal.totalTax).toBe(7.25);
  });

  it('warns when a registered state has no rates configured', async () => {
    const data = buildManualData();
    data.jurisdictions = [];
    const result = await createManualEngine(data, { now: FIXED_NOW }).calculate(request());
    expect(result.warnings).toContain('rates_not_configured');
    expect(result.totalTax).toBe(0);
  });
});

describe('manual engine: rounding', () => {
  it('rounds half-up at the half cent', async () => {
    // 6.25% of 0.08 is 0.005; 5% of 0.10 is 0.005.
    const e = engine();
    const up = await e.calculate(
      request({ shipFrom: addr('KY', '40202'), shipTo: addr('KY', '40202'), lines: [line('a', 0.1)], documentDate: '2026-03-01' }),
    );
    expect(up.totalTax).toBe(0.01);
    const down = await e.calculate(
      request({ shipFrom: addr('KY', '40202'), shipTo: addr('KY', '40202'), lines: [line('a', 0.09)], documentDate: '2026-03-01' }),
    );
    expect(down.totalTax).toBe(0);
  });

  it('rounds each jurisdiction once per invoice, the difference on the last line', async () => {
    // Three lines of 0.10 at 5%: 0.005 each, 0.015 in total -> 0.02 (one rounding), not 0.03 (three).
    const result = await engine().calculate(
      request({
        shipFrom: addr('KY', '40202'),
        shipTo: addr('KY', '40202'),
        documentDate: '2026-03-01',
        lines: [line('a', 0.1), line('b', 0.1), line('c', 0.1)],
      }),
    );
    expect(result.totalTax).toBe(0.02);
    expect(result.lines.map((l) => l.tax)).toEqual([0.01, 0.01, 0]);
    expect(result.lines[0].details[0].unroundedTax).toBe(0.005);
  });

  it('keeps the unrounded tax with at least three decimals', async () => {
    const result = await engine().calculate(request({ lines: [line('a', 33.33)] }));
    const d = result.lines[0].details;
    expect(d.map((x) => x.unroundedTax)).toEqual([1.6665, 0.49995, 0.249975]);
    expect(d.map((x) => x.tax)).toEqual([1.67, 0.5, 0.25]);
  });

  it('keeps the invoice total when per-jurisdiction rounding would differ per line', async () => {
    // Two lines of 10.10 at 7.25% in three jurisdictions: the document total is rounded per jurisdiction.
    const result = await engine().calculate(request({ lines: [line('a', 10.1), line('b', 10.1)] }));
    const sums = new Map<string, number>();
    for (const l of result.lines) for (const d of l.details) sums.set(d.jurisdictionCode, (sums.get(d.jurisdictionCode) ?? 0) + d.tax);
    // 20.20 x 5% = 1.01; x 1.5% = 0.303 -> 0.30; x 0.75% = 0.1515 -> 0.15
    expect([...sums.values()].map((x) => Math.round(x * 100) / 100)).toEqual([1.01, 0.3, 0.15]);
    expect(result.totalTax).toBe(1.46);
  });
});

describe('manual engine: tax-inclusive lines', () => {
  it('backs the tax out of the price', async () => {
    // 107.25 at a combined 7.25% -> net 100.00, tax 7.25
    const result = await engine().calculate(request({ lines: [line('a', 107.25, { taxIncluded: true })] }));
    const l = result.lines[0];
    expect(l.grossAmount).toBe(100);
    expect(l.taxableAmount).toBe(100);
    expect(l.tax).toBe(7.25);
    expect(l.grossAmount + l.tax).toBe(107.25);
    expect(l.details.map((d) => d.tax)).toEqual([5, 1.5, 0.75]);
  });

  it('keeps net + tax equal to the price when the division does not come out even', async () => {
    const result = await engine().calculate(request({ lines: [line('a', 50, { taxIncluded: true })] }));
    const l = result.lines[0];
    expect(l.grossAmount).toBe(46.62);
    expect(Math.round((l.grossAmount + l.tax) * 100) / 100).toBe(50);
    expect(l.details.reduce((s, d) => s + d.tax, 0)).toBeCloseTo(l.tax, 10);
  });

  it('an exempt customer pays the whole inclusive price as net', async () => {
    const result = await engine().calculate(
      request({
        shipTo: addr('FL', '33101'),
        customer: { partyId: 'p', certificates: [certificate()] },
        lines: [line('a', 100, { taxIncluded: true })],
      }),
    );
    expect(result.lines[0]).toMatchObject({ grossAmount: 100, exemptAmount: 100, tax: 0 });
  });
});

describe('manual engine: overrides', () => {
  it('keeps the user tax, spread pro rata over the jurisdictions, and flags it', async () => {
    const result = await engine().calculate(
      request({ lines: [line('a', 100, { override: { amount: 10, reason: 'agreed with the buyer' } })] }),
    );
    const l = result.lines[0];
    expect(l.tax).toBe(10);
    expect(l.overridden).toBe(true);
    expect(l.overrideReason).toBe('agreed with the buyer');
    expect(l.details.map((d) => d.tax)).toEqual([6.9, 2.07, 1.03]);
    expect(l.details.reduce((s, d) => Math.round((s + d.tax) * 100) / 100, 0)).toBe(10);
    // The bases are still computed.
    expect(l.taxableAmount).toBe(100);
    expect(result.totalTax).toBe(10);
  });

  it('an overridden line stays out of the rounding of the other lines', async () => {
    const result = await engine().calculate(
      request({
        shipFrom: addr('KY', '40202'),
        shipTo: addr('KY', '40202'),
        documentDate: '2026-03-01',
        lines: [line('a', 0.1), line('b', 0.1, { override: { amount: 0.5, reason: 'x' } }), line('c', 0.1)],
      }),
    );
    expect(result.lines.map((l) => l.tax)).toEqual([0.01, 0.5, 0]);
    expect(result.lines[1].overridden).toBe(true);
    expect(result.lines[0].overridden).toBeUndefined();
  });

  it('an override of zero removes the tax', async () => {
    const result = await engine().calculate(
      request({ lines: [line('a', 100, { override: { amount: 0, reason: 'goodwill' } })] }),
    );
    expect(result.lines[0].tax).toBe(0);
    expect(result.lines[0].overridden).toBe(true);
  });
});

describe('manual engine: use tax direction', () => {
  const bill = (extra = {}) =>
    request({
      documentType: 'bill',
      direction: 'use',
      shipFrom: addr('NY', '10001'),
      shipTo: addr('WA', '98001'),
      ...extra,
    });

  it('computes at the delivery address under the registered agency', async () => {
    const result = await engine().calculate(bill());
    expect(result.sourcing).toBe('destination');
    expect(result.lines[0].tax).toBe(9);
    expect(result.warnings).toEqual([]);
    expect(result.lines[0].details[0].agencyId).toBe('ag_wa');
  });

  it('needs no registration: still computes, without an agency, and warns', async () => {
    const result = await engine().calculate(bill({ registrations: [reg('ag_tx', 'TX')] }));
    expect(result.lines[0].tax).toBe(9);
    expect(result.lines[0].details.every((d) => d.agencyId === undefined)).toBe(true);
    expect(result.warnings).toContain('no_use_tax_registration');
  });

  it('a state with no configured rates: nothing to compute, with a warning', async () => {
    const result = await engine().calculate(bill({ shipTo: addr('NJ', '07001'), registrations: [] }));
    expect(result.totalTax).toBe(0);
    expect(result.warnings).toEqual(expect.arrayContaining(['no_use_tax_registration', 'rates_not_configured']));
  });

  it('is always destination sourced, even for an in-state purchase from an origin state', async () => {
    const result = await engine().calculate(
      bill({ shipFrom: TX_SELLER, shipTo: addr('TX', '78801', 'Otherville') }),
    );
    expect(result.sourcing).toBe('destination');
    expect(result.lines[0].tax).toBe(6);
  });

  it('ignores the buyer exemption certificates (they are for sales)', async () => {
    const result = await engine().calculate(
      bill({
        shipTo: addr('FL', '33101'),
        customer: { partyId: 'p', certificates: [certificate()] },
      }),
    );
    expect(result.totalTax).toBe(7);
  });
});

describe('manual engine: registrations constant', () => {
  it('the fixture registers every state it tests', () => {
    expect(REGISTRATIONS.map((r) => r.stateCode)).toContain('TX');
    expect(TX_SELLER.state).toBe('TX');
  });
});

describe('manual engine: locations and credits', () => {
  it('a business with several locations is taxed at the one the sale ships from', async () => {
    const data = buildManualData();
    data.jurisdictions.push({
      id: 'tx_other_district',
      agencyId: 'ag_tx',
      stateCode: 'TX',
      level: 'district',
      name: 'Otherville District',
      code: 'tx_other_district',
      reportingCode: null,
      rates: [{ rate: 2, effectiveFrom: '2020-01-01', effectiveTo: null }],
    });
    data.zones.push({
      id: 'z_tx_warehouse',
      agencyId: 'ag_tx',
      stateCode: 'TX',
      name: 'Otherville warehouse',
      jurisdictionIds: ['tx_state', 'tx_other_district'],
      postalCodes: ['78801'],
      isOrigin: true,
      priority: 100,
    });
    const e = createManualEngine(data, { now: FIXED_NOW });
    const buyer = addr('TX', '78701');
    const fromHq = await e.calculate(request({ shipFrom: TX_SELLER, shipTo: buyer }));
    const fromWarehouse = await e.calculate(
      request({ shipFrom: addr('TX', '78801', 'Otherville'), shipTo: buyer }),
    );
    expect(fromHq.lines[0].tax).toBe(7.25);
    expect(fromWarehouse.lines[0].tax).toBe(7);
    expect(fromWarehouse.lines[0].details.map((d) => d.jurisdictionName)).toEqual(['Texas', 'Otherville District']);
  });

  it('a negative amount is taxed symmetrically', async () => {
    const result = await engine().calculate(request({ lines: [line('a', -100)] }));
    expect(result.lines[0].tax).toBe(-7.25);
    expect(result.lines[0].details.map((d) => d.tax)).toEqual([-5, -1.5, -0.75]);
    expect(result.totalTax).toBe(-7.25);
  });

  it('a zero-amount line is carried with zero tax', async () => {
    const result = await engine().calculate(request({ lines: [line('a', 0), line('b', 10)] }));
    expect(result.lines[0]).toMatchObject({ grossAmount: 0, tax: 0 });
    expect(result.lines[1].tax).toBe(0.73);
  });

  it('stamps the calculation time and the engine', async () => {
    const result = await engine().calculate(request());
    expect(result.engine).toBe('manual');
    expect(result.calculatedAt).toBe('2026-03-15T12:00:00.000Z');
  });
});
