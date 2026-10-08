import { describe, it, expect } from 'vitest';
import { computeNlRubrieken } from './btw-return';

const line = (
  direction: 'sales' | 'purchase',
  btwRubriek: string,
  taxableAmount: number,
  taxAmount: number,
  selfAssessed = false,
) => ({
  taxRateId: 'txr',
  taxCategoryCode: 'standard',
  direction,
  selfAssessed,
  taxableAmount,
  taxAmount,
  jurisdictionMetadata: { btwRubriek },
});

describe('computeNlRubrieken', () => {
  it('puts sales in the rubriek of their rate', () => {
    const r = computeNlRubrieken([line('sales', '1a', 100, 21), line('sales', '1c', 50, 4.5), line('sales', '3b', 300, 0)]);
    expect(r).toMatchObject({ r1a: 100, r1b: 21, r1c: 50, r1d: 4.5, r3b: 300, r5a: 25.5, r5c: 25.5 });
  });

  it('treats tax on a purchase as voorbelasting, even on a sales-and-purchase rate', () => {
    const r = computeNlRubrieken([line('sales', '1a', 100, 21), line('purchase', '1a', 40, 8.4)]);
    expect(r).toMatchObject({ r1a: 100, r1b: 21, r5b: 8.4, r5c: 12.6 });
  });

  it('reports EU acquisitions under 4b without counting their self-assessed tax', () => {
    const r = computeNlRubrieken([line('purchase', '4b', 100, 21, true)]);
    expect(r).toMatchObject({ r4b: 100, r5a: 0, r5b: 0, r5c: 0 });
  });

  it('nets credit notes against the period', () => {
    const r = computeNlRubrieken([line('sales', '1a', 100, 21), line('sales', '1a', -100, -21)]);
    expect(r).toMatchObject({ r1a: 0, r1b: 0, r5c: 0 });
  });

  it('infers the direction of lines without one from the rubriek', () => {
    const r = computeNlRubrieken([
      { taxRateId: 'a', taxCategoryCode: 'standard', taxableAmount: 100, taxAmount: 21, jurisdictionMetadata: { btwRubriek: '1a' } },
      { taxRateId: 'b', taxCategoryCode: 'standard', taxableAmount: 100, taxAmount: 21, jurisdictionMetadata: { btwRubriek: '5b' } },
    ]);
    expect(r).toMatchObject({ r1b: 21, r5b: 21, r5c: 0 });
  });
});
