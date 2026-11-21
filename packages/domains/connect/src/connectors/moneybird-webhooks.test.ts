import { describe, expect, it } from 'vitest';
import type { MoneybirdClient } from '@weldsuite/connectors';
import { moneybirdDeliveryTargets } from './moneybird-webhooks';

const PURCHASE = 'moneybird-purchase-invoices';
const RECEIPTS = 'moneybird-receipts';
const SALES = 'moneybird-sales-invoices';
const MUTATIONS = 'moneybird-financial-mutations';

/** A Moneybird client that knows a few records, and the reads asked of it. */
function fakeClient(records: {
  purchaseInvoices?: Record<string, Record<string, unknown>>;
  receipts?: Record<string, Record<string, unknown>>;
  salesInvoices?: Record<string, Record<string, unknown>>;
  mutations?: Array<Record<string, unknown>>;
}) {
  const reads: string[] = [];
  const client = {
    getPurchaseInvoice: async (id: string) => {
      reads.push(`purchase:${id}`);
      return records.purchaseInvoices?.[id] ?? null;
    },
    getReceipt: async (id: string) => {
      reads.push(`receipt:${id}`);
      return records.receipts?.[id] ?? null;
    },
    getSalesInvoice: async (id: string) => {
      reads.push(`sales:${id}`);
      return records.salesInvoices?.[id] ?? null;
    },
    getFinancialMutations: async (ids: string[]) => {
      reads.push(`mutations:${ids.join(',')}`);
      return (records.mutations ?? []).filter((m) => ids.includes(String(m.id)));
    },
  };
  return { client: client as unknown as MoneybirdClient, reads };
}

const all = () => true;

function targets(
  client: MoneybirdClient,
  topic: string,
  args: { kind?: string; payload?: Record<string, unknown>; entity: Record<string, unknown>; wants?: (s: string) => boolean },
) {
  return moneybirdDeliveryTargets({
    client,
    topic,
    kind: args.kind ?? 'update',
    payload: args.payload ?? {},
    entity: args.entity,
    wants: args.wants ?? all,
  });
}

describe('Moneybird document events', () => {
  it('imports a typed document as it is, and leaves other documents alone', async () => {
    const { client, reads } = fakeClient({});
    expect(await targets(client, 'document_saved', { payload: { entity_type: 'PurchaseInvoice' }, entity: { id: 'd1' } })).toEqual([
      { syncName: PURCHASE, records: [{ id: 'd1' }], forceDeleted: false },
    ]);
    expect(await targets(client, 'document_updated', { payload: { entity_type: 'Documents::Receipt' }, entity: { id: 'd2' } })).toEqual([
      { syncName: RECEIPTS, records: [{ id: 'd2' }], forceDeleted: false },
    ]);
    expect(await targets(client, 'document_saved', { payload: { entity_type: 'TypelessDocument' }, entity: { id: 'd3' } })).toEqual([]);
    expect(await targets(client, 'document_saved', { payload: { entity_type: 'Receipt' }, entity: { id: 'd2' }, wants: () => false })).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('reads an untyped document back as a purchase invoice, then as a receipt', async () => {
    const { client, reads } = fakeClient({
      purchaseInvoices: { p1: { id: 'p1', reference: 'PIN-1' } },
      receipts: { r1: { id: 'r1', reference: 'R-1' } },
    });
    expect(await targets(client, 'document_saved', { payload: { entity_type: 'Document' }, entity: { id: 'p1' } })).toEqual([
      { syncName: PURCHASE, records: [{ id: 'p1', reference: 'PIN-1' }], forceDeleted: false },
    ]);
    // The id from the payload when the entity has none.
    expect(await targets(client, 'document_updated', { payload: { entity_id: 'r1' }, entity: {} })).toEqual([
      { syncName: RECEIPTS, records: [{ id: 'r1', reference: 'R-1' }], forceDeleted: false },
    ]);
    expect(await targets(client, 'document_saved', { entity: { id: 'x9' } })).toEqual([]);
    expect(reads).toEqual(['purchase:p1', 'purchase:r1', 'receipt:r1', 'purchase:x9', 'receipt:x9']);
  });

  it('reads nothing for an id it would not put in a path, or bills not imported', async () => {
    const { client, reads } = fakeClient({ purchaseInvoices: { p1: { id: 'p1' } }, receipts: { r1: { id: 'r1' } } });
    expect(await targets(client, 'document_saved', { entity: { id: '../contacts' } })).toEqual([]);
    expect(await targets(client, 'document_saved', { entity: { id: 'p1' }, wants: () => false })).toEqual([]);
    // Found as a purchase invoice, but only receipts are imported.
    expect(await targets(client, 'document_saved', { entity: { id: 'p1' }, wants: (s) => s === RECEIPTS })).toEqual([]);
    // Found as a receipt, but only purchase invoices are imported.
    expect(await targets(client, 'document_saved', { entity: { id: 'r1' }, wants: (s) => s === PURCHASE })).toEqual([]);
    expect(reads).toEqual(['purchase:p1', 'purchase:r1', 'receipt:r1']);
  });

  it('deletes under whichever kind WeldBooks has the document as', async () => {
    const { client, reads } = fakeClient({});
    expect(await targets(client, 'document_destroyed', { kind: 'delete', entity: { id: 'd1' } })).toEqual([
      { syncName: PURCHASE, records: [{ id: 'd1' }], forceDeleted: true },
      { syncName: RECEIPTS, records: [{ id: 'd1' }], forceDeleted: true },
    ]);
    expect(
      await targets(client, 'document_destroyed', { kind: 'delete', payload: { entity_type: 'Receipt' }, entity: { id: 'd1' } }),
    ).toEqual([{ syncName: RECEIPTS, records: [{ id: 'd1' }], forceDeleted: true }]);
    expect(
      await targets(client, 'document_destroyed', { kind: 'delete', entity: { id: 'd1' }, wants: (s) => s === PURCHASE }),
    ).toEqual([{ syncName: PURCHASE, records: [{ id: 'd1' }], forceDeleted: true }]);
    expect(reads).toEqual([]);
  });
});

describe('Moneybird payment events', () => {
  const records = {
    salesInvoices: { si1: { id: 'si1', state: 'open' } },
    receipts: { r1: { id: 'r1' } },
    mutations: [{ id: 'm1', amount: '50.0' }],
  };

  it('reads back the sales invoice it paid and the bank line it was linked to', async () => {
    const { client, reads } = fakeClient(records);
    expect(
      await targets(client, 'payment_registered', { entity: { invoice_type: 'SalesInvoice', invoice_id: 'si1', financial_mutation_id: 'm1' } }),
    ).toEqual([
      { syncName: SALES, records: [{ id: 'si1', state: 'open' }], forceDeleted: false },
      { syncName: MUTATIONS, records: [{ id: 'm1', amount: '50.0' }], forceDeleted: false },
    ]);
    expect(reads).toEqual(['sales:si1', 'mutations:m1']);
  });

  it('reads back the document it paid, by number id too', async () => {
    const { client } = fakeClient({ ...records, receipts: { 42: { id: 42 } } });
    expect(await targets(client, 'payment_destroyed', { entity: { invoice_type: 'Document', invoice_id: 42 } })).toEqual([
      { syncName: RECEIPTS, records: [{ id: 42 }], forceDeleted: false },
    ]);
  });

  it('reads only what the connection imports, and what is still there', async () => {
    const { client, reads } = fakeClient(records);
    const entity = { invoice_type: 'SalesInvoice', invoice_id: 'si1', financial_mutation_id: 'm1' };
    expect(await targets(client, 'payment_registered', { entity, wants: (s) => s === MUTATIONS })).toEqual([
      { syncName: MUTATIONS, records: [{ id: 'm1', amount: '50.0' }], forceDeleted: false },
    ]);
    expect(await targets(client, 'payment_registered', { entity, wants: (s) => s === SALES })).toEqual([
      { syncName: SALES, records: [{ id: 'si1', state: 'open' }], forceDeleted: false },
    ]);
    expect(
      await targets(client, 'payment_registered', { entity: { invoice_type: 'SalesInvoice', invoice_id: 'gone', financial_mutation_id: 'gone' } }),
    ).toEqual([]);
    expect(reads).toEqual(['mutations:m1', 'sales:si1', 'sales:gone', 'mutations:gone']);
  });

  it('leaves payments on external sales invoices and VAT documents alone', async () => {
    const { client, reads } = fakeClient(records);
    for (const type of ['ExternalSalesInvoice', 'VatDocument', undefined]) {
      expect(await targets(client, 'payment_registered', { entity: { invoice_type: type, invoice_id: 'si1', financial_mutation_id: 'm1' } })).toEqual([]);
    }
    expect(reads).toEqual([]);
  });
});

describe('Moneybird statement events', () => {
  it('imports the lines on the statement account', async () => {
    const { client } = fakeClient({});
    const entity = {
      id: 'fs1',
      financial_account_id: 'fa1',
      financial_mutations: [{ id: 'm1' }, { id: 'm2', financial_account_id: 'fa2' }, 'junk'],
    };
    expect(await targets(client, 'financial_statement_created', { kind: 'create', entity })).toEqual([
      { syncName: MUTATIONS, records: [{ id: 'm1', financial_account_id: 'fa1' }, { id: 'm2', financial_account_id: 'fa2' }], forceDeleted: false },
    ]);
    expect((await targets(client, 'financial_statement_destroyed', { kind: 'delete', entity }))[0]?.forceDeleted).toBe(true);
    expect(await targets(client, 'financial_statement_updated', { entity: { id: 'fs1', financial_mutations: [] } })).toEqual([]);
    expect(await targets(client, 'financial_statement_updated', { entity, wants: () => false })).toEqual([]);
    expect(await targets(client, 'financial_statement_updated', { entity: { id: 'fs2', financial_mutations: [{ id: 'm3' }] } })).toEqual([
      { syncName: MUTATIONS, records: [{ id: 'm3' }], forceDeleted: false },
    ]);
  });

  it('routes nothing else', async () => {
    const { client } = fakeClient({});
    expect(await targets(client, 'contact_changed', { entity: { id: 'c1' } })).toEqual([]);
  });
});
