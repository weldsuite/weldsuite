/**
 * pglite ingest of Moneybird records: documents without a contact, the mapper
 * version marker, strict IBANs after field mappings and statement-line links.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getConnector } from '@weldsuite/connectors';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { ingestRecords, recordChecksum } from './ingest';
import { incrementalWatermark, moneybirdAttachmentBacklog } from './sync';

let db: Database;

const moneybird = getConnector('moneybird')!;
const syncFor = (externalEntityType: string) => moneybird.syncs.find((s) => s.externalEntityType === externalEntityType)!;

const CONNECTION = 'conn_moneybird';

function run(externalEntityType: string, records: Array<Record<string, unknown>>) {
  return ingestRecords({
    db,
    connectionId: CONNECTION,
    provider: 'moneybird',
    sync: syncFor(externalEntityType),
    records,
    ownerId: 'user_1',
    workspaceId: 'org_1',
    entityId: 'ent_mb',
    env: {},
  });
}

const contact = { id: 'c1', company_name: 'Acme BV', email: 'info@acme.example', updated_at: '2026-03-01T09:00:00.000Z' };

function purchaseInvoice(extra: Record<string, unknown> = {}) {
  return {
    id: 'pi1',
    reference: 'INK-1',
    contact_id: 'c1',
    contact,
    state: 'open',
    date: '2026-03-02',
    currency: 'EUR',
    total_price_excl_tax: '100.0',
    total_price_incl_tax: '121.0',
    details: [],
    attachments: [],
    updated_at: '2026-03-02T10:00:00.000Z',
    ...extra,
  };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.connectorConnections).values({
    id: CONNECTION,
    provider: 'moneybird',
    displayName: 'Moneybird',
    status: 'active',
    externalAccountId: 'adm1',
  });
}, 60_000);

describe('Moneybird ingest', () => {
  it('skips a document without a contact id or contact, and fails one whose contact id is unknown', async () => {
    const noContact = await run('moneybird_purchase_invoice', [
      { ...purchaseInvoice({ id: 'pi_nc', reference: 'INK-NC' }), contact_id: null, contact: undefined },
    ]);
    expect(noContact).toMatchObject({ created: 0, skipped: 1, failed: 0, errorSamples: [] });
    expect(await db.select().from(schema.bills).where(eq(schema.bills.billNumber, 'INK-NC'))).toEqual([]);

    const unresolved = await run('moneybird_purchase_invoice', [
      { ...purchaseInvoice({ id: 'pi_un', reference: 'INK-UN' }), contact_id: 'c_unknown', contact: undefined },
    ]);
    expect(unresolved).toMatchObject({ created: 0, failed: 1 });
    expect(unresolved.errorSamples).toEqual([
      { externalId: 'pi_un', message: 'Invoice/bill contact is not mapped — sync contacts first' },
    ]);
  });

  it('stores the checksum over the record plus the Moneybird mapper version', async () => {
    await run('moneybird_purchase_invoice', [purchaseInvoice()]);
    const [mapping] = await db
      .select()
      .from(schema.integrationEntityMappings)
      .where(eq(schema.integrationEntityMappings.externalEntityId, 'pi1'));
    expect(mapping!.syncChecksum).toBe(await recordChecksum({ ...purchaseInvoice(), __mapperVersion: 'moneybird-2' }));
    expect(mapping!.syncChecksum).not.toBe(await recordChecksum(purchaseInvoice()));
    // A record stored under the old checksum is updated once; an unchanged one is skipped.
    await db
      .update(schema.integrationEntityMappings)
      .set({ syncChecksum: await recordChecksum(purchaseInvoice()) })
      .where(eq(schema.integrationEntityMappings.id, mapping!.id));
    expect(await run('moneybird_purchase_invoice', [purchaseInvoice()])).toMatchObject({ modified: 1, skipped: 0 });
    expect(await run('moneybird_purchase_invoice', [purchaseInvoice()])).toMatchObject({ modified: 0, skipped: 1 });
  });

  it('imports an exchange rate for a foreign-currency bill', async () => {
    await run('moneybird_purchase_invoice', [
      purchaseInvoice({ id: 'pi_usd', reference: 'INK-USD', currency: 'USD', total_price_incl_tax: '110.0', total_price_incl_tax_base: '100.0' }),
    ]);
    const [bill] = await db.select().from(schema.bills).where(eq(schema.bills.billNumber, 'INK-USD'));
    expect(bill).toMatchObject({ currency: 'USD', exchangeRate: '1.100000' });
  });

  it('nulls an IBAN a default field mapping wrote that is not a valid IBAN', async () => {
    await db.insert(schema.integrationFieldMappings).values({
      id: 'ifm_mb_iban',
      connectionId: CONNECTION,
      entityType: 'bank_account',
      externalFieldPath: 'identifier',
      internalFieldPath: 'iban',
      direction: 'inbound',
      transformType: 'direct',
      isRequired: false,
      isDefault: true,
      position: 0,
    });
    const result = await run('moneybird_financial_account', [
      { id: 'fa_private', name: 'Private', identifier: 'Private withdrawals', currency: 'EUR', type: 'PrivateWithdrawalAccount', active: true },
      { id: 'fa_bank', name: 'Business', identifier: 'NL91ABNA0417164300', currency: 'EUR', type: 'BankAccount', active: true },
    ]);
    expect(result).toMatchObject({ created: 2, failed: 0 });
    const accounts = await db.select().from(schema.bankAccounts).orderBy(schema.bankAccounts.name);
    expect(accounts.map((a) => [a.name, a.iban])).toEqual([
      ['Business', 'NL91ABNA0417164300'],
      ['Private', null],
    ]);
  });

  it('links a statement line to the imported bill it pays, and leaves a void one excluded and unlinked', async () => {
    const [bill] = await db.select().from(schema.bills).where(eq(schema.bills.billNumber, 'INK-1'));
    const line = (id: string, extra: Record<string, unknown>) => ({
      id,
      financial_account_id: 'fa_bank',
      amount: '-121.00',
      date: '2026-03-07',
      payments: [{ invoice_type: 'Document', invoice_id: 'pi1' }],
      ...extra,
    });
    const result = await run('moneybird_financial_mutation', [
      line('mu_paid', { state: 'processed' }),
      line('mu_open', { state: 'unprocessed' }),
      line('mu_void', { state: 'processed', settlement_state: 'expired' }),
    ]);
    expect(result).toMatchObject({ created: 3, failed: 0 });
    const rows = await db.select().from(schema.bankTransactions).orderBy(schema.bankTransactions.externalId);
    expect(rows.map((t) => [t.externalId, t.status, t.reconciledBillId, t.reconciliationType])).toEqual([
      ['mu_open', 'unreconciled', bill!.id, null],
      ['mu_paid', 'reconciled', bill!.id, 'auto'],
      ['mu_void', 'excluded', null, null],
    ]);
  });

  it('links a statement line to the imported sales invoice its payment settles', async () => {
    const sale = await run('moneybird_sales_invoice', [
      {
        id: 'si1',
        invoice_id: '2026-0001',
        contact_id: 'c1',
        contact,
        state: 'open',
        invoice_date: '2026-03-03',
        currency: 'EUR',
        total_price_excl_tax: '100.0',
        total_price_incl_tax: '121.0',
        details: [],
        updated_at: '2026-03-03T10:00:00.000Z',
      },
    ]);
    expect(sale).toMatchObject({ created: 1, failed: 0 });
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.invoiceNumber, '2026-0001'));
    const lines = await run('moneybird_financial_mutation', [
      {
        id: 'mu_sale',
        financial_account_id: 'fa_bank',
        amount: '121.00',
        date: '2026-03-08',
        state: 'processed',
        payments: [{ invoice_type: 'SalesInvoice', invoice_id: 'si1' }],
      },
    ]);
    expect(lines).toMatchObject({ created: 1, failed: 0 });
    const [txn] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.externalId, 'mu_sale'));
    expect([txn!.status, txn!.reconciledInvoiceId, txn!.reconciledBillId, txn!.reconciliationType]).toEqual([
      'reconciled',
      invoice!.id,
      null,
      'auto',
    ]);
  });

  it('reports imported documents whose attachments were never fetched as a backlog', async () => {
    const backlog = (externalEntityType: string, over: { connectionId?: string; provider?: string; storesAttachments?: boolean } = {}) =>
      moneybirdAttachmentBacklog({
        db,
        provider: 'moneybird',
        connectionId: CONNECTION,
        externalEntityType,
        storesAttachments: true,
        ...over,
      });
    // Imported here without attachment storage, so nothing was fetched yet.
    expect(await backlog('moneybird_purchase_invoice')).toBe(true);
    expect(await backlog('moneybird_sales_invoice')).toBe(true);
    expect(await backlog('moneybird_receipt')).toBe(false);
    expect(await backlog('moneybird_purchase_invoice', { connectionId: 'conn_other' })).toBe(false);
    expect(await backlog('moneybird_contact')).toBe(false);
    // A run that stores no attachments, or another provider, has none.
    expect(await backlog('moneybird_purchase_invoice', { storesAttachments: false })).toBe(false);
    expect(await backlog('moneybird_purchase_invoice', { provider: 'stripe' })).toBe(false);

    // Fetched, with or without files: no backlog.
    await db.update(schema.bills).set({ attachmentKeys: [] });
    await db.update(schema.invoices).set({ attachmentKeys: ['k/invoice.pdf'] });
    expect(await backlog('moneybird_purchase_invoice')).toBe(false);
    expect(await backlog('moneybird_sales_invoice')).toBe(false);
  });

  it('counts a failing backlog check as no backlog', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const thrown of [new Error('connection lost'), 'connection lost']) {
      const broken = {
        select: () => {
          throw thrown;
        },
      } as unknown as Database;
      expect(
        await moneybirdAttachmentBacklog({
          db: broken,
          provider: 'moneybird',
          connectionId: CONNECTION,
          externalEntityType: 'moneybird_receipt',
          storesAttachments: true,
        }),
      ).toBe(false);
    }
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('incrementalWatermark', () => {
  const mark = '2026-03-01T00:00:00.000Z';
  const none = () => Promise.resolve(false);
  const some = () => Promise.resolve(true);

  it('pulls from the watermark only for an incremental run without a backlog', async () => {
    expect(await incrementalWatermark({ full: false, continuing: false, watermark: mark, backlog: none })).toBe(mark);
    expect(await incrementalWatermark({ full: false, continuing: false, watermark: mark, backlog: some })).toBeUndefined();
    expect(await incrementalWatermark({ full: true, continuing: false, watermark: mark, backlog: none })).toBeUndefined();
    expect(await incrementalWatermark({ full: false, continuing: true, watermark: mark, backlog: none })).toBeUndefined();
    expect(await incrementalWatermark({ full: false, continuing: false, watermark: undefined, backlog: none })).toBeUndefined();
  });

  it('only asks about a backlog when it would change the answer', async () => {
    const backlog = vi.fn(none);
    await incrementalWatermark({ full: true, continuing: false, watermark: mark, backlog });
    await incrementalWatermark({ full: false, continuing: false, watermark: undefined, backlog });
    expect(backlog).not.toHaveBeenCalled();
  });
});
