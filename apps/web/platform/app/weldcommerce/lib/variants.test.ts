import { describe, expect, it } from 'vitest';
import type { CommerceVariant } from '@/hooks/queries/use-commerce-queries';
import {
  cleanOptions,
  combinationCount,
  deriveOptions,
  hasDuplicateNames,
  parsePriceInput,
  variantTitle,
} from './variants';
import { errorMessage, fill } from './text';

function variant(position: number, optionValues: Record<string, string>): CommerceVariant {
  return {
    id: `var_${position}`,
    productId: 'prod_1',
    sku: null,
    barcode: null,
    optionValues,
    price: null,
    currency: 'EUR',
    status: 'active',
    position,
    inventoryQuantity: 0,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
  };
}

describe('deriveOptions', () => {
  it('reads the options back from the variants, in position order', () => {
    const options = deriveOptions([
      variant(2, { Size: 'L', Colour: 'Blue' }),
      variant(0, { Size: 'M', Colour: 'Red' }),
      variant(1, { Size: 'L', Colour: 'Red' }),
    ]);
    expect(options).toEqual([
      { name: 'Size', values: ['M', 'L'] },
      { name: 'Colour', values: ['Red', 'Blue'] },
    ]);
  });

  it('is empty without variants', () => {
    expect(deriveOptions([])).toEqual([]);
  });

  it("keeps the product's option order, then adds what only the variants use", () => {
    const options = deriveOptions(
      [variant(0, { Colour: 'Red', Size: 'M' }), variant(1, { Colour: 'Green', Material: 'Wool', Size: 'S' })],
      [
        { name: 'Size', values: ['S', 'M'] },
        { name: 'Colour', values: ['Red'] },
      ],
    );
    expect(options).toEqual([
      { name: 'Size', values: ['S', 'M'] },
      { name: 'Colour', values: ['Red', 'Green'] },
      { name: 'Material', values: ['Wool'] },
    ]);
  });
});

describe('cleanOptions and combinationCount', () => {
  it('trims, drops blanks and repeats, and leaves out incomplete options', () => {
    expect(
      cleanOptions([
        { name: ' Size ', values: ['S', ' M ', 'M', ''] },
        { name: '', values: ['x'] },
        { name: 'Colour', values: [] },
      ]),
    ).toEqual([{ name: 'Size', values: ['S', 'M'] }]);
  });

  it('multiplies the value counts', () => {
    expect(combinationCount([])).toBe(0);
    expect(
      combinationCount([
        { name: 'Size', values: ['S', 'M', 'L'] },
        { name: 'Colour', values: ['Red', 'Blue'] },
      ]),
    ).toBe(6);
  });

  it('spots two options with the same name', () => {
    expect(hasDuplicateNames([{ name: 'Size', values: [] }, { name: 'size ', values: [] }])).toBe(true);
    expect(hasDuplicateNames([{ name: 'Size', values: [] }, { name: 'Colour', values: [] }])).toBe(false);
  });
});

describe('variantTitle', () => {
  it('joins the option values, or is null without any', () => {
    expect(variantTitle({ optionValues: { Size: 'L', Colour: 'Red' } })).toBe('L / Red');
    expect(variantTitle({ optionValues: {} })).toBeNull();
  });

  it("prefers the server's name, which follows the product's option order", () => {
    expect(variantTitle({ name: 'M / Red', optionValues: { Colour: 'Red', Size: 'M' } })).toBe('M / Red');
    expect(variantTitle({ name: ' ', optionValues: { Size: 'L' } })).toBe('L');
  });
});

describe('parsePriceInput', () => {
  it('takes a point or a comma and at most two decimals', () => {
    expect(parsePriceInput('19.99')).toBe('19.99');
    expect(parsePriceInput(' 19,5 ')).toBe('19.5');
    expect(parsePriceInput('20')).toBe('20');
  });

  it('reads blank as "use the product price" and refuses what is not a price', () => {
    expect(parsePriceInput('  ')).toBeNull();
    expect(parsePriceInput('abc')).toBeUndefined();
    expect(parsePriceInput('1.999')).toBeUndefined();
    expect(parsePriceInput('-5')).toBeUndefined();
  });
});

describe('text helpers', () => {
  it('fills placeholders and leaves unknown ones', () => {
    expect(fill('{a} and {b}', { a: 1 })).toBe('1 and {b}');
  });

  it('takes an error’s message or the fallback', () => {
    expect(errorMessage(new Error('Taken'), 'Failed')).toBe('Taken');
    expect(errorMessage(new Error(''), 'Failed')).toBe('Failed');
    expect(errorMessage('nope', 'Failed')).toBe('Failed');
  });
});
