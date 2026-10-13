import { describe, it, expect } from 'vitest';
import { computeNlRubrieken, normalizeVatRubrieken, recomputeRubriekTotals, emptyRubrieken } from './btw-return';
import { generateVatXml } from '../../accounting-vat-xml';
import { nlTaxonomyForPeriod, nlTaxonomyUris } from './taxonomy';
import { nlTaxCategories } from './tax-categories';

const line = (
  direction: 'sales' | 'purchase',
  btwRubriek: string,
  taxableAmount: number,
  taxAmount: number,
  selfAssessed = false,
  taxCategoryCode = 'standard',
) => ({
  taxRateId: 'txr',
  taxCategoryCode,
  direction,
  selfAssessed,
  taxableAmount,
  taxAmount,
  jurisdictionMetadata: { btwRubriek },
});

describe('computeNlRubrieken', () => {
  it('puts sales in the official box of their rate: 1a hoog, 1b laag, 1c overige, 3b EU', () => {
    const r = computeNlRubrieken([
      line('sales', '1a', 100, 21),
      line('sales', '1b', 50, 4.5, false, 'reduced'),
      line('sales', '1c', 200, 12),
      line('sales', '3b', 300, 0),
    ]);
    expect(r).toMatchObject({
      r1a: 100, r1aBtw: 21,
      r1b: 50, r1bBtw: 4.5,
      r1c: 200, r1cBtw: 12,
      r3b: 300,
      r5a: 37.5, r5c: 37.5, r5g: 37.5,
    });
  });

  it('reports domestic 0% supplies in 1e (omzet only), not in 1c', () => {
    const r = computeNlRubrieken([line('sales', '1e', 400, 0, false, 'zero')]);
    expect(r).toMatchObject({ r1e: 400, r1c: 0, r1cBtw: 0, r5a: 0 });
  });

  it('treats tax on a purchase as voorbelasting, even on a sales-and-purchase rate', () => {
    const r = computeNlRubrieken([line('sales', '1a', 100, 21), line('purchase', '1a', 40, 8.4)]);
    expect(r).toMatchObject({ r1a: 100, r1aBtw: 21, r5b: 8.4, r5c: 12.6 });
  });

  it('reports EU acquisitions under 4b with their BTW, owed in 5a and deducted again in 5b', () => {
    const r = computeNlRubrieken([line('purchase', '4b', 100, 21, true)]);
    expect(r).toMatchObject({ r4b: 100, r4bBtw: 21, r5a: 21, r5b: 21, r5c: 0 });
  });

  it('reports imports (4a) and domestic reverse charge (2a) with their BTW', () => {
    const r = computeNlRubrieken([
      line('purchase', '4a', 1000, 210, true),
      line('purchase', '2a', 500, 105, true),
    ]);
    expect(r).toMatchObject({ r4a: 1000, r4aBtw: 210, r2a: 500, r2aBtw: 105, r5a: 315, r5b: 315, r5c: 0 });
  });

  it('adds the voorbelasting of normal purchases on top of the deducted self-assessed BTW', () => {
    const r = computeNlRubrieken([
      line('sales', '1a', 100, 21),
      line('purchase', '4b', 100, 21, true),
      line('purchase', '5b', 50, 10.5),
    ]);
    expect(r).toMatchObject({ r5a: 42, r5b: 31.5, r5c: 10.5 });
  });

  it('nets credit notes against the period', () => {
    const r = computeNlRubrieken([line('sales', '1a', 100, 21), line('sales', '1a', -100, -21)]);
    expect(r).toMatchObject({ r1a: 0, r1aBtw: 0, r5c: 0 });
  });

  it('infers the direction of lines without one from the rubriek', () => {
    const r = computeNlRubrieken([
      { taxRateId: 'a', taxCategoryCode: 'standard', taxableAmount: 100, taxAmount: 21, jurisdictionMetadata: { btwRubriek: '1a' } },
      { taxRateId: 'b', taxCategoryCode: 'standard', taxableAmount: 100, taxAmount: 21, jurisdictionMetadata: { btwRubriek: '5b' } },
    ]);
    expect(r).toMatchObject({ r1aBtw: 21, r5b: 21, r5c: 0 });
  });

  it('reads rates seeded with the old numbering: reduced as 1c is 1b, a 1e line with BTW is 1c', () => {
    const r = computeNlRubrieken([
      line('sales', '1c', 100, 9, false, 'reduced'),
      line('sales', '1e', 200, 12, false, 'standard'),
      line('sales', '1e', 300, 0, false, 'zero'),
    ]);
    expect(r).toMatchObject({ r1b: 100, r1bBtw: 9, r1c: 200, r1cBtw: 12, r1e: 300 });
  });

  it('applies KOR reduction and the estimates to the total in 5g', () => {
    const r = recomputeRubriekTotals({ ...emptyRubrieken(), r1aBtw: 100, r5b: 20, r5d: 10, r5e: 5, r5f: 3 });
    expect(r).toMatchObject({ r5a: 100, r5c: 80, r5g: 68 });
  });
});

describe('normalizeVatRubrieken', () => {
  it('converts a return stored in the old numbering', () => {
    const legacy = {
      r1a: 1000, r1b: 210, r1c: 500, r1d: 45, r1e: 0, r1f: 0,
      r2a: 0, r3a: 0, r3b: 300, r3c: 0, r4a: 0, r4b: 100,
      r5a: 255, r5b: 60, r5c: 195, r5d: 0, r5e: 0, r5f: 195,
    };
    expect(normalizeVatRubrieken(legacy)).toMatchObject({
      r1a: 1000, r1aBtw: 210,
      r1b: 500, r1bBtw: 45,
      r1c: 0, r1cBtw: 0, r1e: 0,
      r3b: 300, r4b: 100,
      r5a: 255, r5b: 60, r5c: 195, r5g: 195, r5f: 0,
    });
  });

  it('moves an old "other rates" box with BTW to 1c and one without BTW to 1e', () => {
    const base = { r1a: 0, r1b: 0, r1c: 0, r1d: 0, r5f: 0 };
    expect(normalizeVatRubrieken({ ...base, r1e: 80, r1f: 16 })).toMatchObject({ r1c: 80, r1cBtw: 16, r1e: 0 });
    expect(normalizeVatRubrieken({ ...base, r1e: 80, r1f: 0 })).toMatchObject({ r1c: 0, r1cBtw: 0, r1e: 80 });
  });

  it('leaves a current-layout return as it is and fills missing keys', () => {
    const current = { ...emptyRubrieken(), r1a: 10, r1aBtw: 2.1, r5g: 2.1 };
    expect(normalizeVatRubrieken(current)).toEqual(current);
    expect(normalizeVatRubrieken({ r1aBtw: 1, r5g: 1 })).toMatchObject({ r1aBtw: 1, r1b: 0, r5g: 1 });
  });

  it('returns null for nothing', () => {
    expect(normalizeVatRubrieken(null)).toBeNull();
  });
});

describe('generateVatXml', () => {
  const rubrieken = computeNlRubrieken([
    line('sales', '1a', 1000, 210),
    line('sales', '1b', 500, 45, false, 'reduced'),
    line('sales', '1e', 250, 0, false, 'zero'),
    line('sales', '3b', 300, 0),
    line('purchase', '4b', 100, 21, true),
    line('purchase', '5b', 50, 10.5),
  ]);
  const xml = generateVatXml({
    btwNumber: 'NL123456789B01',
    companyName: 'Acme BV',
    contactName: 'Acme BV',
    contactPhone: '+31 20 123 4567',
    periodStart: '2026-01-01',
    periodEnd: '2026-03-31',
    rubrieken,
  });
  const fact = (element: string) => new RegExp(`<bd-i:${element}[^>]*>(-?\\d+)</bd-i:${element}>`).exec(xml)?.[1];

  it('maps every box to its taxonomy element', () => {
    expect(fact('TaxedTurnoverSuppliesServicesGeneralTariff')).toBe('1000');
    expect(fact('ValueAddedTaxSuppliesServicesGeneralTariff')).toBe('210');
    expect(fact('TaxedTurnoverSuppliesServicesReducedTariff')).toBe('500');
    expect(fact('ValueAddedTaxSuppliesServicesReducedTariff')).toBe('45');
    expect(fact('TaxedTurnoverSuppliesServicesOtherRates')).toBe('0');
    expect(fact('SuppliesServicesNotTaxed')).toBe('250');
    expect(fact('SuppliesToCountriesWithinTheEC')).toBe('300');
    expect(fact('TurnoverFromTaxedSuppliesFromCountriesWithinTheEC')).toBe('100');
    expect(fact('ValueAddedTaxOnSuppliesFromCountriesWithinTheEC')).toBe('21');
    expect(fact('ValueAddedTaxOwed')).toBe('276');
    expect(fact('ValueAddedTaxOnInput')).toBe('32');
    expect(fact('ValueAddedTaxOwedToBePaidBack')).toBe('244');
  });

  it('uses the NT20 entrypoint and namespace for a 2026 period', () => {
    expect(xml).toContain('xlink:href="http://www.nltaxonomie.nl/nt20/bd/20251210/entrypoints/bd-rpt-ob-aangifte-2026.xsd"');
    expect(xml).toContain('xmlns:bd-i="http://www.nltaxonomie.nl/nt20/bd/20251210/dictionary/bd-data"');
    expect(xml).not.toContain('nt17');
  });

  it('writes the mandatory contact data and a message reference', () => {
    expect(xml).toContain('<bd-i:ContactType contextRef="Msg">BPL</bd-i:ContactType>');
    expect(xml).toContain('<bd-i:ContactTelephoneNumber contextRef="Msg">+31201234567</bd-i:ContactTelephoneNumber>');
    expect(xml).toContain('<bd-i:MessageReferenceSupplierVAT contextRef="Msg">OB-2026-01-01-2026-03-31</bd-i:MessageReferenceSupplierVAT>');
  });
});

describe('taxonomy versions', () => {
  it('selects the NT version by the period year', () => {
    expect(nlTaxonomyForPeriod('2026-04-01')).toMatchObject({ nt: 'nt20', release: '20251210' });
    expect(nlTaxonomyForPeriod(new Date('2027-01-01T00:00:00Z'))).toMatchObject({ nt: 'nt21', provisional: true });
    expect(nlTaxonomyUris('2026-01-01').icpEntrypoint).toBe(
      'http://www.nltaxonomie.nl/nt20/bd/20251210/entrypoints/bd-rpt-icp-opgaaf-2026.xsd',
    );
  });
});

describe('NL seed tax rates', () => {
  const byName = (name: string) => nlTaxCategories.find((t) => t.name === name);

  it('uses the official box numbers', () => {
    expect(byName('BTW Hoog 21%')?.jurisdictionMetadata).toEqual({ btwRubriek: '1a' });
    expect(byName('BTW Laag 9%')?.jurisdictionMetadata).toEqual({ btwRubriek: '1b' });
    expect(byName('BTW Nul 0%')?.jurisdictionMetadata).toEqual({ btwRubriek: '1e' });
  });

  it('has separate EU rates for goods and services, both on box 3b', () => {
    expect(byName('BTW ICL goederen')).toMatchObject({ taxCategoryCode: 'eu_b2b_goods', type: 'sales', jurisdictionMetadata: { btwRubriek: '3b' } });
    expect(byName('BTW Intracommunautair diensten')).toMatchObject({ taxCategoryCode: 'eu_b2b_service', type: 'sales', jurisdictionMetadata: { btwRubriek: '3b' } });
  });

  it('charges the domestic reverse-charge rate its BTW so box 2a has an amount', () => {
    expect(byName('BTW Verlegd')).toMatchObject({ rate: '21.00', taxCategoryCode: 'reverse_charge' });
  });
});
