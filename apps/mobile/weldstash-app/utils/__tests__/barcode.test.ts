import {
  buildAdjustPayload,
  buildCreateProductPayload,
  normalizeBarcode,
  pickDefaultWarehouse,
  pickExactProduct,
} from '../barcode';

describe('normalizeBarcode', () => {
  it('trims whitespace', () => {
    expect(normalizeBarcode('  0123456789012  ')).toBe('0123456789012');
  });

  it('strips CR/LF from keyboard-wedge scanners', () => {
    expect(normalizeBarcode('ABC-99\r\n')).toBe('ABC-99');
  });

  it('strips GS1 FNC1 (ASCII 29) and other control characters', () => {
    expect(normalizeBarcode('\u001d0101234567890128')).toBe('0101234567890128');
  });

  it('returns an empty string for nullish input', () => {
    expect(normalizeBarcode(null)).toBe('');
    expect(normalizeBarcode(undefined)).toBe('');
    expect(normalizeBarcode('   ')).toBe('');
  });
});

describe('pickExactProduct', () => {
  const products = [
    { id: 'p1', sku: 'WID-1', barcode: '111' },
    { id: 'p2', sku: 'WID-2', barcode: '222' },
  ];

  it('matches barcode case-insensitively', () => {
    expect(pickExactProduct(products, ' 111 ')).toEqual(products[0]);
  });

  it('falls back to an exact SKU match', () => {
    expect(pickExactProduct(products, 'wid-2')).toEqual(products[1]);
  });

  it('prefers barcode over SKU when both could match different rows', () => {
    const mixed = [
      { id: 'sku', sku: '111', barcode: 'aaa' },
      { id: 'bar', sku: 'zzz', barcode: '111' },
    ];
    expect(pickExactProduct(mixed, '111')?.id).toBe('bar');
  });

  it('returns null when nothing matches exactly', () => {
    expect(pickExactProduct(products, '11')).toBeNull();
  });
});

describe('pickDefaultWarehouse', () => {
  it('prefers the default active warehouse', () => {
    const warehouses = [
      { id: 'a', isDefault: false, isActive: true },
      { id: 'b', isDefault: true, isActive: true },
    ];
    expect(pickDefaultWarehouse(warehouses)?.id).toBe('b');
  });

  it('skips inactive warehouses when an active one exists', () => {
    const warehouses = [
      { id: 'old', isDefault: true, isActive: false },
      { id: 'live', isDefault: false, isActive: true },
    ];
    expect(pickDefaultWarehouse(warehouses)?.id).toBe('live');
  });

  it('returns null when the list is empty', () => {
    expect(pickDefaultWarehouse([])).toBeNull();
  });
});

describe('buildCreateProductPayload', () => {
  it('uppercases SKU, keeps barcode, and marks the product active', () => {
    const payload = buildCreateProductPayload({
      name: ' Widget ',
      sku: 'wid-1',
      barcode: ' 999 \n',
    });
    expect(payload).toMatchObject({
      name: 'Widget',
      sku: 'WID-1',
      barcode: '999',
      status: 'active',
      trackInventory: true,
      price: 0,
    });
    expect(payload.slug).toMatch(/^widget-[a-z0-9]+$/);
  });

  it('omits empty optional identifiers', () => {
    const payload = buildCreateProductPayload({ name: 'Solo' });
    expect(payload.sku).toBeUndefined();
    expect(payload.barcode).toBeUndefined();
  });
});

describe('buildAdjustPayload', () => {
  it('fills a default reason and tags the source as mobile', () => {
    expect(buildAdjustPayload({ productId: 'prod_1', warehouseId: 'wh_1', delta: -2 })).toEqual({
      productId: 'prod_1',
      warehouseId: 'wh_1',
      delta: -2,
      reason: 'Adjusted from WeldStash',
      sourceType: 'mobile',
    });
  });

  it('keeps a custom reason', () => {
    expect(
      buildAdjustPayload({
        productId: 'prod_1',
        warehouseId: 'wh_1',
        delta: 4,
        reason: 'Cycle count',
      }).reason,
    ).toBe('Cycle count');
  });
});
