/**
 * pglite ingest of Moneybird records: documents without a contact, the mapper
 * version marker, strict IBANs after field mappings and statement-line links.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getConnector } from '@weldsuite/connectors';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { ingestRecords, recordChecksum } from './ingest';

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
});
