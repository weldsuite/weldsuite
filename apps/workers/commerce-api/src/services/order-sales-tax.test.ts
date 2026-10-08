/**
 * Order sales tax: calculation through the WeldBooks engine (pglite), and the
 * pure parts that turn an order into a tax request and a result into the
 * columns it writes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import {
  OrderSalesTaxError,
  buildOrderTaxApplication,
  calculateOrderSalesTax,
  orderTaxLockReason,
  resolveLineTaxCode,
  resolveOrderTaxEntity,
  taxInputFromOrder,
  toTaxResponse,
  type OrderSalesTaxCalculated,
} from './order-sales-tax';
import { CA_ADDRESS, ENCRYPTION_KEY, ENTITIES, TX_ADDRESS, seedTaxWorkspace } from './order-sales-tax-fixtures';

const env = { DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY };

let db: Database;
let close: () => Promise<void>;

async function setDefaultEntity(entityId: string | null) {
  await db.update(schema.settings).set({ defaultEntityId: entityId });
}

async function calculate(input: Partial<Parameters<typeof calculateOrderSalesTax>[2]> = {}) {
  const result = await calculateOrderSalesTax(db, env, {
    lines: [{ lineId: 'l1', productId: 'prod_general', amount: 100, quantity: 1 }],
    shipTo: TX_ADDRESS,
    currency: 'USD',
    date: '2026-03-15',
    ...input,
  });
  if (!result.supported) throw new Error(`expected a calculation, got ${result.reason}`);
  return result;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  close = handle.close;
  await seedTaxWorkspace(db);
}, 120_000);

afterAll(async () => {
  await close?.();
});

describe('resolveLineTaxCode', () => {
  it('uses the line code first, then the product, then general goods', () => {
    expect(resolveLineTaxCode('saas', { taxable: true, taxClass: 'clothing' })).toBe('saas');
    expect(resolveLineTaxCode(null, { taxable: true, taxClass: 'clothing' })).toBe('clothing');
    expect(resolveLineTaxCode(undefined, null)).toBe('general');
    expect(resolveLineTaxCode('  ', { taxable: true, taxClass: null })).toBe('general');
  });

  it('treats a product that is not taxable as non_taxable whatever its class', () => {
    expect(resolveLineTaxCode(null, { taxable: false, taxClass: 'general' })).toBe('non_taxable');
  });

  it('falls back to general for a legacy tax class but keeps a provider code', () => {
    expect(resolveLineTaxCode(null, { taxable: true, taxClass: 'standard' })).toBe('general');
    expect(resolveLineTaxCode(null, { taxable: true, taxClass: 'txcd_20030000' })).toBe('txcd_20030000');
    expect(resolveLineTaxCode('PC040100', null)).toBe('PC040100');
  });

  it('refuses a code typed on the line that no engine knows', () => {
    expect(() => resolveLineTaxCode('standard', null)).toThrow(OrderSalesTaxError);
  });
});

describe('calculateOrderSalesTax', () => {
  it('taxes an order shipped within Texas with state and local tax', async () => {
    const result = await calculate();

    expect(result).toMatchObject({ engine: 'manual', entityId: ENTITIES.us, totalTax: 8.25, shippingTax: 0, warnings: [] });
    expect(result.jurisdictions).toEqual([
      expect.objectContaining({ name: 'Texas', level: 'state', stateCode: 'TX', rate: 6.25, taxableAmount: 100, tax: 6.25 }),
      expect.objectContaining({ name: 'Austin', level: 'city', stateCode: 'TX', rate: 2, taxableAmount: 100, tax: 2 }),
    ]);
    expect(result.lines).toEqual([
      expect.objectContaining({ lineId: 'l1', taxCode: 'general', tax: 8.25, rate: 8.25, taxableAmount: 100 }),
    ]);
  });

  it('charges no tax on a non_taxable product and taxes shipping as its own line', async () => {
    const result = await calculate({
      lines: [
        { lineId: 'goods', productId: 'prod_general', amount: 100, quantity: 2 },
        { lineId: 'gift', productId: 'prod_exempt', amount: 50, quantity: 1 },
        { lineId: 'wrap', productId: 'prod_untaxed', amount: 5, quantity: 1 },
      ],
      shippingAmount: 10,
    });

    const byId = Object.fromEntries(result.lines.map((l) => [l.lineId, l]));
    expect(byId.gift).toMatchObject({ taxCode: 'non_taxable', tax: 0, rate: 0, nonTaxableAmount: 50 });
    expect(byId.wrap).toMatchObject({ taxCode: 'non_taxable', tax: 0 });
    expect(byId.goods.tax).toBeGreaterThan(0);
    expect(byId.shipping).toMatchObject({ taxCode: 'shipping' });
    expect(byId.shipping.tax).toBeGreaterThan(0);
    // 110 taxable at 6.25% + 2.00%, rounded once per jurisdiction.
    expect(result.totalTax).toBe(9.08);
    expect(result.lines.reduce((sum, l) => Math.round((sum + l.tax) * 100) / 100, 0)).toBe(result.totalTax);
    expect(result.shippingTax).toBe(byId.shipping.tax);
    expect(result.jurisdictions.map((j) => [j.name, j.taxableAmount, j.tax])).toEqual([
      ['Texas', 110, 6.88],
      ['Austin', 110, 2.2],
    ]);
  });

  it('charges no tax outside the states the entity is registered in, and says so', async () => {
    const result = await calculate({ shipTo: CA_ADDRESS });

    expect(result.totalTax).toBe(0);
    expect(result.warnings).toEqual(['not_registered_in_state']);
    expect(result.jurisdictions).toEqual([]);
    expect(result.lines[0]).toMatchObject({ lineId: 'l1', tax: 0, rate: 0, nonTaxableAmount: 100 });
    expect(result.shipToState).toBe('CA');
  });

  it('falls back to the bill-to address when the ship-to has no state', async () => {
    const result = await calculate({ shipTo: { city: 'Austin' }, billTo: TX_ADDRESS });
    expect(result.totalTax).toBe(8.25);
    expect(result.shipToState).toBe('TX');
  });

  it('warns that no address was given instead of guessing a state', async () => {
    const result = await calculate({ shipTo: null, billTo: null });
    expect(result.totalTax).toBe(0);
    expect(result.warnings).toEqual(['no_ship_to']);
  });

  it('skips the engine when there is nothing to tax', async () => {
    const result = await calculate({ lines: [{ lineId: 'free', amount: 0, quantity: 1 }], shipTo: null });
    expect(result).toMatchObject({ totalTax: 0, warnings: [], lines: [expect.objectContaining({ lineId: 'free', tax: 0 })] });
  });

  it('exempts a buyer with a valid certificate for the state', async () => {
    await db.insert(schema.parties).values({ id: 'pty_resale', kind: 'company', displayName: 'Reseller Inc', role: 'customer' });
    await db.insert(schema.exemptionCertificates).values({
      id: 'cert_resale',
      entityId: ENTITIES.us,
      partyId: 'pty_resale',
      states: ['TX'],
      reason: 'resale',
      certificateNumber: '32-000',
      form: 'state_form',
      issuedOn: '2025-01-01',
      expiresOn: '2030-12-31',
      status: 'valid',
    });

    const result = await calculate({ customerPartyId: 'pty_resale' });

    expect(result.totalTax).toBe(0);
    expect(result.lines[0]).toMatchObject({ tax: 0, exemptAmount: 100 });
    expect(result.lines[0].details.map((d) => d.certificateId)).toEqual(['cert_resale', 'cert_resale']);
  });

  it('warns when an order is flagged tax exempt but no certificate covers it', async () => {
    const result = await calculate({ taxExempt: true });
    expect(result.totalTax).toBe(8.25);
    expect(result.warnings).toEqual(['tax_exempt_flag_without_certificate']);
  });

  it('defaults a company buyer to business use and an anonymous buyer to personal use', async () => {
    await db.insert(schema.parties).values([
      { id: 'pty_company', kind: 'company', displayName: 'Acme', role: 'customer' },
      { id: 'pty_person', kind: 'person', displayName: 'Jane', role: 'customer' },
      { id: 'pty_person_biz', kind: 'person', displayName: 'Sole trader', role: 'customer', taxUse: 'business' },
    ]);
    const saas = [{ lineId: 'sub', productId: 'prod_saas', amount: 100, quantity: 1 }];

    expect((await calculate({ lines: saas })).totalTax).toBe(8.25);
    expect((await calculate({ lines: saas, customerPartyId: 'pty_person' })).totalTax).toBe(8.25);
    expect((await calculate({ lines: saas, customerPartyId: 'pty_company' })).totalTax).toBe(0);
    expect((await calculate({ lines: saas, customerPartyId: 'pty_person_biz' })).totalTax).toBe(0);
    expect((await calculate({ lines: saas, customerPartyId: 'pty_company', customerUse: 'personal' })).totalTax).toBe(8.25);
  });

  it('charges no tax when a marketplace collects it', async () => {
    const result = await calculate({ marketplaceFacilitated: true });
    expect(result.totalTax).toBe(0);
    expect(result.warnings).toEqual(['marketplace_facilitated']);
  });

  it('refuses a duplicate or reserved line id', async () => {
    await expect(
      calculate({ lines: [{ lineId: 'a', amount: 1, quantity: 1 }, { lineId: 'a', amount: 1, quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'TAX_REQUEST_INVALID', status: 422 });
    await expect(calculate({ lines: [{ lineId: 'shipping', amount: 1, quantity: 1 }] })).rejects.toMatchObject({
      code: 'TAX_REQUEST_INVALID',
    });
  });

  it('answers supported: false when the default entity is outside the US', async () => {
    await setDefaultEntity(ENTITIES.nl);
    try {
      const result = await calculateOrderSalesTax(db, env, {
        lines: [{ lineId: 'l1', amount: 100, quantity: 1 }],
        shipTo: TX_ADDRESS,
        currency: 'EUR',
      });
      expect(result).toEqual({ supported: false, reason: 'sales_tax_not_supported', entityId: ENTITIES.nl });
      expect(toTaxResponse(result)).toEqual({ supported: false, reason: 'sales_tax_not_supported', entityId: ENTITIES.nl });
    } finally {
      await setDefaultEntity(ENTITIES.us);
    }
  });

  it('never answers zero tax when the engine is unreachable', async () => {
    await setDefaultEntity(ENTITIES.stripe);
    try {
      const failing = calculateOrderSalesTax(
        db,
        env,
        { lines: [{ lineId: 'l1', amount: 100, quantity: 1 }], shipTo: TX_ADDRESS, currency: 'USD', date: '2026-03-15' },
        {
          fetch: async () => {
            throw new TypeError('network down');
          },
        },
      );
      await expect(failing).rejects.toMatchObject({
        name: 'OrderSalesTaxError',
        code: 'TAX_ENGINE_UNAVAILABLE',
        status: 503,
        details: { reason: 'unreachable', retryable: true },
      });
    } finally {
      await setDefaultEntity(ENTITIES.us);
    }
  });

  it('answers 503 when the provider engine has no credentials', async () => {
    await setDefaultEntity(ENTITIES.stripeNoCredentials);
    try {
      await expect(calculate()).rejects.toMatchObject({
        code: 'TAX_ENGINE_UNAVAILABLE',
        status: 503,
        details: { reason: 'not_configured' },
      });
    } finally {
      await setDefaultEntity(ENTITIES.us);
    }
  });
});

describe('resolveOrderTaxEntity', () => {
  it('prefers the settings default, then the entity flagged default, then the only entity', async () => {
    expect((await resolveOrderTaxEntity(db))?.id).toBe(ENTITIES.us);

    await setDefaultEntity(ENTITIES.nl);
    expect((await resolveOrderTaxEntity(db))?.id).toBe(ENTITIES.nl);

    await setDefaultEntity(null);
    expect((await resolveOrderTaxEntity(db))?.id).toBe(ENTITIES.us);

    const others = [ENTITIES.nl, ENTITIES.stripe, ENTITIES.stripeNoCredentials];
    await db.update(schema.entities).set({ isDefault: false });
    expect(await resolveOrderTaxEntity(db)).toBeNull();

    await db.update(schema.entities).set({ deletedAt: new Date() }).where(inArray(schema.entities.id, others));
    expect((await resolveOrderTaxEntity(db))?.id).toBe(ENTITIES.us);

    await db.update(schema.entities).set({ deletedAt: null }).where(inArray(schema.entities.id, others));
    await db.update(schema.entities).set({ isDefault: true }).where(eq(schema.entities.id, ENTITIES.us));
    await setDefaultEntity(ENTITIES.us);
  });

  it('skips a default entity that was deleted', async () => {
    await db.update(schema.entities).set({ deletedAt: new Date() }).where(eq(schema.entities.id, ENTITIES.nl));
    await setDefaultEntity(ENTITIES.nl);
    try {
      expect((await resolveOrderTaxEntity(db))?.id).toBe(ENTITIES.us);
    } finally {
      await db.update(schema.entities).set({ deletedAt: null }).where(eq(schema.entities.id, ENTITIES.nl));
      await setDefaultEntity(ENTITIES.us);
    }
  });
});

describe('taxInputFromOrder', () => {
  const order = {
    id: 'ord_1',
    currency: 'usd',
    subtotal: '110.00',
    discountTotal: '0',
    shippingTotal: '7.50',
    shippingAddress: { ...TX_ADDRESS, name: 'Jane Doe', phone: '+1 555 0100' },
    billingAddress: CA_ADDRESS,
    counterpartyId: 'pty_x',
    customerId: 'cus_legacy',
    taxExempt: 1,
    createdAt: new Date('2026-02-03T23:30:00Z'),
  };

  it('prices each item at quantity × unit price less its own discount', () => {
    const input = taxInputFromOrder(order, [
      { id: 'oit_a', productId: 'prod_general', quantity: 3, unitPrice: '10.00', discountAmount: '5.00' },
      { id: 'oit_b', productId: null, quantity: 1, unitPrice: '80.00', discountAmount: null },
    ]);

    expect(input).toMatchObject({
      orderId: 'ord_1',
      lines: [
        { lineId: 'oit_a', productId: 'prod_general', amount: 25, quantity: 3 },
        { lineId: 'oit_b', productId: null, amount: 80, quantity: 1 },
      ],
      shippingAmount: 7.5,
      customerPartyId: 'pty_x',
      date: '2026-02-03',
      currency: 'usd',
      taxExempt: true,
      extraWarnings: [],
    });
    expect(input.shipTo).toMatchObject({ state: 'TX' });
  });

  it('spreads an order-level discount over the lines, net of what the items already carry', () => {
    const input = taxInputFromOrder(
      { ...order, discountTotal: '21.00' },
      [
        { id: 'oit_a', productId: null, quantity: 1, unitPrice: '60.00', discountAmount: '1.00' },
        { id: 'oit_b', productId: null, quantity: 1, unitPrice: '40.00', discountAmount: null },
      ],
    );
    // 21 − 1 already on the items = 20 left, in proportion 59 : 40 (the items net of their own discount).
    const amounts = input.lines.map((l) => l.amount);
    expect(amounts[0] + amounts[1]).toBe(79);
    expect(amounts).toEqual([47.08, 31.92]);
  });

  it('taxes the subtotal as one line when an order has no items, and says so', () => {
    const input = taxInputFromOrder({ ...order, id: undefined }, []);
    expect(input.lines).toEqual([{ lineId: 'order', amount: 110, quantity: 1 }]);
    expect(input.extraWarnings).toEqual(['no_line_items']);
    expect(input.orderId).toBeUndefined();
  });

  it('uses the customer id when the order has no counterparty', () => {
    expect(taxInputFromOrder({ ...order, counterpartyId: null }, []).customerPartyId).toBe('cus_legacy');
    expect(taxInputFromOrder({ ...order, counterpartyId: null, customerId: null }, []).customerPartyId).toBeNull();
  });
});

describe('buildOrderTaxApplication', () => {
  const result: OrderSalesTaxCalculated = {
    supported: true,
    entityId: ENTITIES.us,
    engine: 'manual',
    calculatedAt: '2026-03-15T12:00:00.000Z',
    documentDate: '2026-03-15',
    currency: 'USD',
    sourcing: 'origin',
    shipToState: 'TX',
    shipToPostalCode: '78701',
    totalTax: 9.08,
    shippingTax: 0.83,
    warnings: [],
    lines: [
      { lineId: 'oit_a', taxCode: 'general', tax: 8.25, rate: 8.25, taxableAmount: 100, exemptAmount: 0, nonTaxableAmount: 0, details: [] },
      { lineId: 'oit_b', taxCode: 'non_taxable', tax: 0, rate: 0, taxableAmount: 0, exemptAmount: 0, nonTaxableAmount: 50, details: [] },
      { lineId: 'shipping', taxCode: 'shipping', tax: 0.83, rate: 8.25, taxableAmount: 10, exemptAmount: 0, nonTaxableAmount: 0, details: [] },
    ],
    jurisdictions: [
      { code: '48', name: 'Texas', level: 'state', stateCode: 'TX', rate: 6.25, taxableAmount: 110, tax: 6.88 },
      { code: '48-05000', name: 'Austin', level: 'city', stateCode: 'TX', rate: 2, taxableAmount: 110, tax: 2.2 },
      { code: 'x', name: 'Rounds away', level: 'district', stateCode: 'TX', rate: 0.1, taxableAmount: 0, tax: 0 },
    ],
  };
  const items = [
    { id: 'oit_a', productId: null, quantity: 1, unitPrice: '100.00', discountAmount: '0', taxAmount: '0.00' },
    { id: 'oit_b', productId: null, quantity: 1, unitPrice: '50.00', discountAmount: '0', taxAmount: '0.00' },
  ];

  it('writes one tax line per jurisdiction and moves the total by the change in tax', () => {
    const { order, items: changed } = buildOrderTaxApplication(
      { id: 'ord_1', total: '170.00', taxTotal: '10.00', subtotal: '150.00', shippingTotal: '10.00', metadata: { channel: 'pos' } },
      items,
      result,
    );

    expect(order.taxLines).toEqual([
      { title: 'Texas', rate: 6.25, price: '6.88' },
      { title: 'Austin', rate: 2, price: '2.20' },
    ]);
    expect(order.taxTotal).toBe('9.08');
    // 170.00 held 10.00 of tax, and now holds 9.08.
    expect(order.total).toBe('169.08');
    expect(changed).toEqual([{ id: 'oit_a', taxAmount: '8.25' }]);
  });

  it('keeps the engine detail on metadata.salesTax next to what was there', () => {
    const { order } = buildOrderTaxApplication({ total: '0', metadata: { channel: 'pos' } }, items, result);
    expect(order.metadata).toMatchObject({
      channel: 'pos',
      salesTax: {
        version: 1,
        entityId: ENTITIES.us,
        engine: 'manual',
        calculatedAt: '2026-03-15T12:00:00.000Z',
        sourcing: 'origin',
        shipToState: 'TX',
        totalTax: 9.08,
        shippingTax: 0.83,
        warnings: [],
      },
    });
    expect((order.metadata.salesTax as { lines: unknown[] }).lines).toHaveLength(3);
  });

  it('derives the total of an order that has none yet', () => {
    const { order } = buildOrderTaxApplication(
      { subtotal: 150, discountTotal: '5.00', shippingTotal: 10, total: undefined },
      [],
      result,
    );
    expect(order.total).toBe('164.08');
  });
});

describe('orderTaxLockReason', () => {
  it('freezes paid and cancelled orders only', () => {
    expect(orderTaxLockReason({ status: 'pending', paymentStatus: 'pending' })).toBeNull();
    expect(orderTaxLockReason({ paymentStatus: 'paid' })).toMatch(/paid/);
    expect(orderTaxLockReason({ paidAt: new Date() })).toMatch(/paid/);
    expect(orderTaxLockReason({ paymentStatus: 'refunded' })).toMatch(/paid/);
    expect(orderTaxLockReason({ status: 'cancelled' })).toMatch(/cancelled/);
  });
});
