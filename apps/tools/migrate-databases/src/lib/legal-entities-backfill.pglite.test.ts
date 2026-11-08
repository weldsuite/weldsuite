/**
 * The legal entities backfill script (release 1) on pglite. Every tenant
 * migration in the journal is applied once (0249 included, so the database
 * looks like a tenant after the SQL backfill), and each test seeds a fresh
 * clone of it.
 */

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@weldsuite/db/schema';
import type { HrPayrollEmployerBank } from '@weldsuite/db/schema';
import { decryptField, encryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import {
  backfillLegalEntities,
  derivedId,
  formatWorkspaceReport,
  normalizeCountry,
  type Database,
} from './legal-entities-backfill';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../../../../packages/core/db/drizzle/tenant-migrations');

const keyring: EncryptionKeyring = { v1: randomBytes(32).toString('hex'), v2: randomBytes(32).toString('hex') };
const otherKeyring: EncryptionKeyring = { v2: randomBytes(32).toString('hex') };

let base: PGlite;

/** Apply the journal the way the runner does, with the shared harness's tolerance for the historic migrations. */
beforeAll(async () => {
  base = new PGlite({ extensions: { vector, pg_trgm } });
  const journal = JSON.parse(await readFile(path.join(migrationsDir, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  for (const { tag } of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    const raw = await readFile(path.join(migrationsDir, `${tag}.sql`), 'utf8');
    for (const statement of raw.split(/-->\s*statement-breakpoint/).map((s) => s.trim()).filter(Boolean)) {
      try {
        await base.exec(statement);
      } catch (err) {
        const message = (err as Error).message;
        if (/already exists/i.test(message) || /does not exist/i.test(message)) continue;
        throw new Error(`${tag}: ${message}`);
      }
    }
  }
}, 600_000);

interface Tenant {
  client: PGlite;
  db: Database;
}

async function tenant(): Promise<Tenant> {
  const client = (await base.clone()) as unknown as PGlite;
  return { client, db: drizzle(client, { schema }) as unknown as Database };
}

async function rows<T>(client: PGlite, query: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query<T>(query, params)).rows;
}

const json = (value: unknown): string | null => (value === undefined || value === null ? null : JSON.stringify(value));

interface EntitySeed {
  id: string;
  name?: string;
  legalName?: string | null;
  country?: string;
  currency?: string;
  isDefault?: boolean;
  /** WeldBooks enabled (an accounting_entity_settings row). */
  books?: boolean;
  invoiceBankAccountId?: string | null;
  bankDetails?: Record<string, string>;
  taxIdentifiers?: Record<string, string>;
  address?: Record<string, string>;
  contact?: Record<string, unknown>;
  branding?: Record<string, string>;
}

async function seedEntity(client: PGlite, e: EntitySeed): Promise<void> {
  await client.query(
    `INSERT INTO entities (id, name, legal_name, jurisdiction_code, base_currency, is_default, bank_details, tax_identifiers, address, contact, branding, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, '2026-01-01 10:00:00.123456')`,
    [
      e.id,
      e.name ?? e.id,
      e.legalName === undefined ? `${e.id} B.V.` : e.legalName,
      e.country ?? 'NL',
      e.currency ?? 'EUR',
      e.isDefault ?? false,
      json(e.bankDetails),
      json(e.taxIdentifiers),
      json(e.address),
      json(e.contact),
      json(e.branding),
    ],
  );
  if (e.books !== false) {
    await client.query(`INSERT INTO accounting_entity_settings (entity_id, invoice_bank_account_id) VALUES ($1, $2)`, [
      e.id,
      e.invoiceBankAccountId ?? null,
    ]);
  }
}

async function seedAccount(
  client: PGlite,
  a: { id: string; entityId: string; iban?: string; routingNumber?: string; accountNumber?: string; ach?: Record<string, unknown> },
): Promise<void> {
  await client.query(
    `INSERT INTO bank_accounts (id, entity_id, name, iban, routing_number, account_number_encrypted, account_number_last4, ach_settings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      a.id,
      a.entityId,
      `Account ${a.id}`,
      a.iban ?? null,
      a.routingNumber ?? null,
      a.accountNumber ? await encryptField(a.accountNumber, keyring) : null,
      a.accountNumber ? a.accountNumber.slice(-4) : null,
      json(a.ach),
    ],
  );
}

async function seedEmployer(
  client: PGlite,
  e: { id: string; entityId: string | null; country?: string; bank?: HrPayrollEmployerBank; blob?: string; bankAccountId?: string },
): Promise<void> {
  const blob = e.blob ?? (e.bank ? await encryptField(JSON.stringify(e.bank), keyring) : null);
  await client.query(
    `INSERT INTO hr_payroll_employers (id, name, legal_name, country, currency, legal_entity_id, bank_encrypted, bank_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.id, `Payroll ${e.id}`, `${e.id} B.V.`, e.country ?? 'NL', e.country === 'US' ? 'USD' : 'EUR', e.entityId, blob, e.bankAccountId ?? null],
  );
}

async function seedWorkspaceSettings(client: PGlite, values: Record<string, string>): Promise<void> {
  const columns = ['id', ...Object.keys(values)];
  const params = ['wss_1', ...Object.values(values)];
  await client.query(
    `INSERT INTO workspace_settings (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    params,
  );
}

async function seedEmployee(client: PGlite, id: string, legalEntityId: string | null = null): Promise<void> {
  await client.query(`INSERT INTO hr_employees (id, first_name, last_name, email, legal_entity_id) VALUES ($1, 'A', 'B', $2, $3)`, [
    id,
    `${id}@example.com`,
    legalEntityId,
  ]);
}

const SNAPSHOT_TABLES = [
  'entities',
  'bank_accounts',
  'legal_entity_registrations',
  'accounting_entity_settings',
  'hr_payroll_employers',
  'hr_employees',
  'workspace_settings',
];

async function snapshot(client: PGlite): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of SNAPSHOT_TABLES) {
    out[table] = (await rows<{ r: unknown }>(client, `SELECT to_jsonb(t) AS r FROM ${table} t ORDER BY to_jsonb(t)::text`)).map((x) => x.r);
  }
  return out;
}

async function employer(client: PGlite, id: string): Promise<{ bank_account_id: string | null; bank_encrypted: string | null }> {
  const [row] = await rows<{ bank_account_id: string | null; bank_encrypted: string | null }>(
    client,
    `SELECT bank_account_id, bank_encrypted FROM hr_payroll_employers WHERE id = $1`,
    [id],
  );
  return row;
}

interface AccountRow {
  id: string;
  entity_id: string;
  name: string;
  iban: string | null;
  bic: string | null;
  bank_name: string | null;
  account_holder_name: string | null;
  currency: string | null;
  account_type: string | null;
  routing_number: string | null;
  account_number_encrypted: string | null;
  account_number_last4: string | null;
  ach_settings: Record<string, unknown> | null;
}

async function accounts(client: PGlite): Promise<AccountRow[]> {
  return rows<AccountRow>(client, `SELECT * FROM bank_accounts ORDER BY id`);
}

/** A workspace with something for every step, for the dry-run and re-run tests. */
async function seedEverything(client: PGlite): Promise<void> {
  await seedEntity(client, {
    id: 'ent_nl',
    isDefault: true,
    legalName: 'Acme B.V.',
    bankDetails: { iban: 'NL91 ABNA 0417 1643 00', bic: 'ABNANL2A', bankName: 'ABN AMRO' },
    taxIdentifiers: { einOrSsn: '123456789' },
    contact: { email: 'info@acme.nl' },
  });
  await seedEntity(client, { id: 'ent_us', name: 'Acme US', legalName: 'Acme Inc.', country: 'US', currency: 'USD' });
  await seedAccount(client, { id: 'ba_us', entityId: 'ent_us', routingNumber: '021000021', accountNumber: '000123456789' });
  await seedEmployer(client, { id: 'emp_nl', entityId: 'ent_nl', bank: { iban: 'NL91ABNA0417164300', accountHolder: 'Acme B.V.' } });
  await seedEmployer(client, {
    id: 'emp_us',
    entityId: 'ent_us',
    country: 'US',
    bank: { routingNumber: '021000021', accountNumber: '0001-2345-6789', nachaCompanyId: '1987654321' },
  });
  await seedEmployer(client, { id: 'emp_new', entityId: 'ent_us', country: 'US', bank: { routingNumber: '011000015', accountNumber: '55551234' } });
  await seedEmployer(client, { id: 'emp_bad', entityId: 'ent_nl', blob: await encryptField('{"iban":"NL02ABNA0123456789"}', otherKeyring) });
  await seedWorkspaceSettings(client, {
    legal_name: 'Acme Holding B.V.',
    trading_name: 'Acme',
    email: 'hello@acme.nl',
    phone: '+31 20 123 4567',
    address_line_1: 'Keizersgracht 1',
    city: 'Amsterdam',
    country: 'Nederland',
    vat_number: 'NL 8530.12.345 B01',
  });
  await seedEmployee(client, 'e_plain');
  await seedEmployee(client, 'e_payroll');
  await client.query(`INSERT INTO hr_payroll_profiles (id, employee_id, employer_id) VALUES ('pp_1', 'e_payroll', 'emp_us')`);
}

describe('normalizeCountry', () => {
  it('maps names and codes people type to ISO-2', () => {
    expect(normalizeCountry('Nederland')).toBe('NL');
    expect(normalizeCountry('The Netherlands')).toBe('NL');
    expect(normalizeCountry(' nl ')).toBe('NL');
    expect(normalizeCountry('België')).toBe('BE');
    expect(normalizeCountry('U.S.A.')).toBe('US');
    expect(normalizeCountry('United Kingdom')).toBe('GB');
    expect(normalizeCountry('Atlantis')).toBeNull();
    expect(normalizeCountry('')).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
  });
});

describe('employer bank accounts', () => {
  it('links the employer to the core account with the same IBAN and moves the NACHA company id', async () => {
    const { client, db } = await tenant();
    await seedEntity(client, { id: 'ent_nl', isDefault: true });
    await seedAccount(client, { id: 'ba_main', entityId: 'ent_nl', iban: 'NL91ABNA0417164300', ach: { immediateOrigin: '021000021' } });
    await seedEmployer(client, { id: 'emp_nl', entityId: 'ent_nl', bank: { iban: 'nl91 abna 0417 1643 00', nachaCompanyId: '1987654321' } });

    const report = await backfillLegalEntities(db, keyring, { execute: true });

    expect((await employer(client, 'emp_nl')).bank_account_id).toBe('ba_main');
    const all = await accounts(client);
    expect(all.map((a) => a.id)).toEqual(['ba_main']);
    expect(all[0].ach_settings).toEqual({ immediateOrigin: '021000021', companyIdentification: '1987654321' });
    expect(report.counts).toMatchObject({ employerBanksMatched: 1, employerBanksCreated: 0, employersLinked: 1, nachaCompanyIdsMoved: 1 });
  });

  it('matches on routing number and decrypted account number', async () => {
    const { client, db } = await tenant();
    await seedEntity(client, { id: 'ent_us', country: 'US', currency: 'USD', isDefault: true });
    await seedAccount(client, { id: 'ba_other', entityId: 'ent_us', routingNumber: '021000021', accountNumber: '999988887777' });
    await seedAccount(client, { id: 'ba_us', entityId: 'ent_us', routingNumber: '021000021', accountNumber: '000123456789' });
    await seedEmployer(client, {
      id: 'emp_us',
      entityId: 'ent_us',
      country: 'US',
      bank: { routingNumber: '021000021', accountNumber: '0001-2345-6789', accountType: 'checking' },
    });

    const report = await backfillLegalEntities(db, keyring, { execute: true });

    expect((await employer(client, 'emp_us')).bank_account_id).toBe('ba_us');
    expect((await accounts(client)).map((a) => a.id)).toEqual(['ba_other', 'ba_us']);
    expect(report.counts.employerBanksMatched).toBe(1);
  });

  it('only matches accounts of the employer’s own legal entity, and creates one when nothing matches', async () => {
    const { client, db } = await tenant();
    await seedEntity(client, { id: 'ent_us', legalName: 'Acme Inc.', country: 'US', currency: 'USD', isDefault: true });
    await seedEntity(client, { id: 'ent_other', country: 'US', currency: 'USD' });
    await seedAccount(client, { id: 'ba_elsewhere', entityId: 'ent_other', routingNumber: '021000021', accountNumber: '123456789012' });
    await seedEmployer(client, {
      id: 'emp_us',
      entityId: 'ent_us',
      country: 'US',
      bank: {
        routingNumber: '021000021',
        accountNumber: '1234 5678 9012',
        accountType: 'checking',
        bankName: 'Chase',
        nachaCompanyId: '1123456789',
      },
    });

    const report = await backfillLegalEntities(db, keyring, { execute: true });

    const createdId = derivedId('ba', 'hr_employer_bank:emp_us');
    expect((await employer(client, 'emp_us')).bank_account_id).toBe(createdId);
    const created = (await accounts(client)).find((a) => a.id === createdId);
    expect(created).toMatchObject({
      entity_id: 'ent_us',
      name: 'Salary account (Payroll emp_us)',
      iban: null,
      routing_number: '021000021',
      account_number_last4: '9012',
      account_holder_name: 'Acme Inc.',
      currency: 'USD',
      account_type: 'checking',
      bank_name: 'Chase',
      ach_settings: { companyIdentification: '1123456789' },
    });
    expect(await decryptField(created?.account_number_encrypted ?? '', keyring)).toBe('123456789012');
    expect(created?.account_number_encrypted?.startsWith('v2:')).toBe(true);
    expect(report.counts).toMatchObject({ employerBanksCreated: 1, employersLinked: 1, nachaCompanyIdsMoved: 1 });
    expect(report.createdBankAccounts).toEqual([
      { accountId: createdId, entityId: 'ent_us', source: 'employer', sourceId: 'emp_us', account: 'routing 021000021, account *****9012' },
    ]);
    // The report never carries the full account number.
    expect(JSON.stringify(report)).not.toContain('123456789012');
  });

  it('keeps the account’s own NACHA company id and reports the employer’s', async () => {
    const { client, db } = await tenant();
    await seedEntity(client, { id: 'ent_nl', isDefault: true });
    await seedAccount(client, { id: 'ba_main', entityId: 'ent_nl', iban: 'NL91ABNA0417164300', ach: { companyIdentification: '1111111111' } });
    await seedEmployer(client, { id: 'emp_nl', entityId: 'ent_nl', bank: { iban: 'NL91ABNA0417164300', nachaCompanyId: '2222222222' } });

    const report = await backfillLegalEntities(db, keyring, { execute: true });

    expect((await accounts(client))[0].ach_settings).toEqual({ companyIdentification: '1111111111' });
    expect((await employer(client, 'emp_nl')).bank_account_id).toBe('ba_main');
    expect(report.counts.nachaCompanyIdsMoved).toBe(0);
    expect(report.conflicts).toEqual([
      { subject: 'employer emp_nl', message: expect.stringContaining('2222222222 differs from 1111111111') },
    ]);
  });

  it('reports blobs it cannot decrypt or use and leaves those employers alone', async () => {
    const { client, db } = await tenant();
    await seedEntity(client, { id: 'ent_nl', isDefault: true });
    const foreign = await encryptField(JSON.stringify({ iban: 'NL91ABNA0417164300' }), otherKeyring);
    await seedEmployer(client, { id: 'emp_foreign', entityId: 'ent_nl', blob: foreign });
    await seedEmployer(client, { id: 'emp_empty', entityId: 'ent_nl', bank: { bankName: 'ING', nachaCompanyId: '1234567890' } });
    await seedEmployer(client, { id: 'emp_garbage', entityId: 'ent_nl', blob: await encryptField('not json', keyring) });
    await seedEmployer(client, { id: 'emp_orphan', entityId: null, bank: { iban: 'NL91ABNA0417164300' } });

    const report = await backfillLegalEntities(db, keyring, { execute: true });

    expect(report.bankIssues).toEqual([
      { subject: 'employer emp_foreign', message: expect.stringContaining('does not decrypt') },
      { subject: 'employer emp_empty', message: expect.stringContaining('has no IBAN and no account number') },
      { subject: 'employer emp_garbage', message: 'bank_encrypted decrypts, but not to JSON' },
    ]);
    expect(report.conflicts).toEqual([{ subject: 'employer emp_orphan', message: expect.stringContaining('has no legal entity') }]);
    expect(await accounts(client)).toEqual([]);
    expect((await employer(client, 'emp_foreign')).bank_encrypted).toBe(foreign);
    for (const id of ['emp_foreign', 'emp_empty', 'emp_garbage', 'emp_orphan']) {
      expect((await employer(client, id)).bank_account_id).toBeNull();
    }
  });
});

describe('entity bank details', () => {
  it('turns bank_details into the invoice account, reusing a matching account', async () => {
    const { client, db } = await tenant();
    await seedEntity(client, {
      id: 'ent_nl',
      isDefault: true,
      legalName: 'Acme B.V.',
      bankDetails: { iban: 'NL91 ABNA 0417 1643 00', bic: 'ABNANL2A', bankName: 'ABN AMRO' },
    });
    await seedEntity(client, { id: 'ent_be', country: 'BE', bankDetails: { iban: 'BE68539007547034' } });
    await seedAccount(client, { id: 'ba_be', entityId: 'ent_be', iban: 'BE68 5390 0754 7034' });
    await seedEntity(client, { id: 'ent_set', bankDetails: { iban: 'NL02ABNA0123456789' }, invoiceBankAccountId: 'ba_chosen' });
    await seedEntity(client, { id: 'ent_hr', books: false, bankDetails: { iban: 'NL18RABO0123459876' } });

    const report = await backfillLegalEntities(db, keyring, { execute: true });

    const createdId = derivedId('ba', 'entity_bank_details:ent_nl');
    const invoice = await rows<{ entity_id: string; invoice_bank_account_id: string | null }>(
      client,
      `SELECT entity_id, invoice_bank_account_id FROM accounting_entity_settings ORDER BY entity_id`,
    );
    expect(invoice).toEqual([
      { entity_id: 'ent_be', invoice_bank_account_id: 'ba_be' },
      { entity_id: 'ent_nl', invoice_bank_account_id: createdId },
      { entity_id: 'ent_set', invoice_bank_account_id: 'ba_chosen' },
    ]);
    const created = (await accounts(client)).find((a) => a.id === createdId);
    expect(created).toMatchObject({
      entity_id: 'ent_nl',
      name: 'Invoice account',
      iban: 'NL91ABNA0417164300',
      bic: 'ABNANL2A',
      bank_name: 'ABN AMRO',
      account_holder_name: 'Acme B.V.',
      currency: 'EUR',
      account_number_encrypted: null,
    });
    // WeldBooks is not enabled for ent_hr: the account exists, the invoice link does not.
    expect((await accounts(client)).filter((a) => a.entity_id === 'ent_hr')).toHaveLength(1);
    expect(report.conflicts).toEqual([{ subject: 'entity ent_hr', message: expect.stringContaining('WeldBooks is not enabled') }]);
    expect(report.counts).toMatchObject({ invoiceAccountsMatched: 1, invoiceAccountsCreated: 2, invoiceAccountsSet: 2 });
  });
});

describe('workspace settings', () => {
  it('fills the default entity’s empty fields and reports the differences', async () => {
    const { client, db } = await tenant();
    await seedEntity(client, {
      id: 'ent_nl',
      isDefault: true,
      legalName: 'Acme B.V.',
      contact: { email: 'info@acme.nl' },
      address: { line1: 'Keizersgracht 1', city: 'Amsterdam' },
      branding: { footerText: 'Thanks' },
    });
    await client.query(
      `INSERT INTO legal_entity_registrations (id, entity_id, type, country, number, is_primary) VALUES ('ler_kvk', 'ent_nl', 'company_registration', 'NL', '12345678', true)`,
    );
    await seedWorkspaceSettings(client, {
      legal_name: 'Acme Holding B.V.',
      trading_name: 'Acme',
      contact_first_name: 'Jan',
      contact_last_name: 'Jansen',
      email: 'hello@acme.nl',
      phone: '+31 20 123 4567',
      website_url: 'https://acme.nl',
      address_line_1: 'Keizersgracht 1',
      city: 'amsterdam',
      postal_code: '1015 CJ',
      country: 'Nederland',
      vat_number: 'NL 8530.12.345 B01',
      registration_number: '87654321',
      logo_url: 'https://acme.nl/logo.png',
      primary_color: '#ff6600',
    });

    const report = await backfillLegalEntities(db, keyring, { execute: true });

    const [entity] = await rows<{
      legal_name: string;
      dba: string | null;
      contact: unknown;
      address: unknown;
      branding: unknown;
    }>(client, `SELECT legal_name, dba, contact, address, branding FROM entities WHERE id = 'ent_nl'`);
    expect(entity).toEqual({
      legal_name: 'Acme B.V.',
      dba: 'Acme',
      contact: {
        email: 'info@acme.nl',
        phone: '+31 20 123 4567',
        website: 'https://acme.nl',
        contactPerson: { firstName: 'Jan', lastName: 'Jansen' },
      },
      address: { line1: 'Keizersgracht 1', city: 'Amsterdam', postalCode: '1015 CJ', country: 'NL' },
      branding: { footerText: 'Thanks', logoUrl: 'https://acme.nl/logo.png', primaryColor: '#ff6600' },
    });
    const regs = await rows<{ type: string; number: string; is_primary: boolean }>(
      client,
      `SELECT type, number, is_primary FROM legal_entity_registrations WHERE entity_id = 'ent_nl' ORDER BY type`,
    );
    expect(regs).toEqual([
      { type: 'company_registration', number: '12345678', is_primary: true },
      { type: 'vat', number: 'NL853012345B01', is_primary: true },
    ]);
    expect(report.differences).toEqual([
      { entityId: 'ent_nl', field: 'legalName', entityValue: 'Acme B.V.', workspaceValue: 'Acme Holding B.V.' },
      { entityId: 'ent_nl', field: 'contact.email', entityValue: 'info@acme.nl', workspaceValue: 'hello@acme.nl' },
      { entityId: 'ent_nl', field: 'registrations.company_registration', entityValue: '12345678', workspaceValue: '87654321' },
    ]);
    expect(report.filledFields.map((f) => f.field)).toEqual([
      'dba',
      'contact.phone',
      'contact.website',
      'contact.contactPerson.firstName',
      'contact.contactPerson.lastName',
      'address.postalCode',
      'address.country',
      'branding.logoUrl',
      'branding.primaryColor',
    ]);
    expect(report.counts).toMatchObject({ entityFieldsFilled: 9, registrationsCreated: 1 });
    const printed = formatWorkspaceReport('ws_1', report).join('\n');
    expect(printed).toContain('legalName: "Acme B.V.", workspace settings "Acme Holding B.V."');
  });

  it('never mixes two different addresses', async () => {
    const { client, db } = await tenant();
    await seedEntity(client, { id: 'ent_nl', isDefault: true, address: { line1: 'Keizersgracht 1', city: 'Amsterdam' } });
    await seedWorkspaceSettings(client, { address_line_1: 'Coolsingel 10', city: 'Rotterdam', postal_code: '3011 AD', country: 'NL' });

    const report = await backfillLegalEntities(db, keyring, { execute: true });

    const [{ address }] = await rows<{ address: unknown }>(client, `SELECT address FROM entities WHERE id = 'ent_nl'`);
    expect(address).toEqual({ line1: 'Keizersgracht 1', city: 'Amsterdam' });
    expect(report.differences.map((d) => d.field)).toEqual(['address.line1', 'address.city']);
    expect(report.filledFields).toEqual([]);
  });

  it('creates the default entity from workspace settings when there is no entity', async () => {
    const { client, db } = await tenant();
    await seedWorkspaceSettings(client, {
      legal_name: 'Solo B.V.',
      country: 'Nederland',
      currency: 'eur',
      email: 'solo@example.com',
      address_line_1: 'Dorpsstraat 1',
      city: 'Utrecht',
      vat_number: 'NL853012345B01',
      registration_number: '12345678',
    });
    await seedEmployee(client, 'e_1');
    await seedEmployee(client, 'e_2');

    const report = await backfillLegalEntities(db, keyring, { execute: true });

    const id = derivedId('ent', 'workspace_settings:wss_1');
    const created = await rows<Record<string, unknown>>(
      client,
      `SELECT id, name, legal_name, dba, jurisdiction_code, base_currency, locale, timezone, is_default, is_active, address, contact
       FROM entities`,
    );
    expect(created).toEqual([
      {
        id,
        name: 'Solo B.V.',
        legal_name: 'Solo B.V.',
        dba: null,
        jurisdiction_code: 'NL',
        base_currency: 'EUR',
        locale: 'nl-NL',
        timezone: 'Europe/Amsterdam',
        is_default: true,
        is_active: true,
        address: { line1: 'Dorpsstraat 1', city: 'Utrecht', country: 'NL' },
        contact: { email: 'solo@example.com' },
      },
    ]);
    // A core entity only: WeldBooks is not enabled for it.
    expect(await rows(client, `SELECT entity_id FROM accounting_entity_settings`)).toEqual([]);
    expect(
      await rows(client, `SELECT type, number, is_primary FROM legal_entity_registrations WHERE entity_id = $1 ORDER BY type`, [id]),
    ).toEqual([
      { type: 'company_registration', number: '12345678', is_primary: true },
      { type: 'vat', number: 'NL853012345B01', is_primary: true },
    ]);
    expect(await rows(client, `SELECT id, legal_entity_id FROM hr_employees ORDER BY id`)).toEqual([
      { id: 'e_1', legal_entity_id: id },
      { id: 'e_2', legal_entity_id: id },
    ]);
    expect(report.counts).toMatchObject({ defaultEntitiesCreated: 1, registrationsCreated: 2, employeesFromDefault: 2 });
  });

  it('does not create a default when the country is not recognised or the currency is unknown', async () => {
    const cases: Array<Record<string, string>> = [
      { legal_name: 'Far B.V.', country: 'Atlantis', currency: 'EUR' },
      { legal_name: 'Far B.V.', country: 'Netherlands' },
    ];
    for (const settings of cases) {
      const { client, db } = await tenant();
      await seedWorkspaceSettings(client, settings);
      await seedEmployee(client, 'e_1');

      const report = await backfillLegalEntities(db, keyring, { execute: true });

      expect(await rows(client, `SELECT id FROM entities`)).toEqual([]);
      expect(report.changes).toBe(0);
      expect(report.notes.map((n) => n.message).join('\n')).toMatch(
        settings.country === 'Atlantis' ? /country "Atlantis" is not recognised/ : /there is no currency/,
      );
      expect(await rows(client, `SELECT legal_entity_id FROM hr_employees`)).toEqual([{ legal_entity_id: null }]);
    }
  });
});

describe('employees and tax ids', () => {
  it('gives employees their payroll employer’s entity, else the default', async () => {
    const { client, db } = await tenant();
    await seedEntity(client, { id: 'ent_nl', isDefault: true });
    await seedEntity(client, { id: 'ent_us', country: 'US', currency: 'USD' });
    await seedEmployer(client, { id: 'emp_us', entityId: 'ent_us', country: 'US' });
    await seedEmployee(client, 'e_payroll');
    await seedEmployee(client, 'e_plain');
    await seedEmployee(client, 'e_set', 'ent_us');
    await client.query(`INSERT INTO hr_payroll_profiles (id, employee_id, employer_id) VALUES ('pp_1', 'e_payroll', 'emp_us')`);

    const report = await backfillLegalEntities(db, keyring, { execute: true });

    expect(await rows(client, `SELECT id, legal_entity_id FROM hr_employees ORDER BY id`)).toEqual([
      { id: 'e_payroll', legal_entity_id: 'ent_us' },
      { id: 'e_plain', legal_entity_id: 'ent_nl' },
      { id: 'e_set', legal_entity_id: 'ent_us' },
    ]);
    expect(report.counts).toMatchObject({ employeesFromPayroll: 1, employeesFromDefault: 1 });
  });

  it('reports einOrSsn values the SQL did not migrate, masked', async () => {
    const { client, db } = await tenant();
    await seedEntity(client, { id: 'ent_a', isDefault: true, taxIdentifiers: { einOrSsn: '123456789' } });
    await seedEntity(client, { id: 'ent_b', taxIdentifiers: { einOrSsn: '12-3456789' } });
    await seedEntity(client, { id: 'ent_c', taxIdentifiers: { einOrSsn: '987654321' } });
    await client.query(
      `INSERT INTO legal_entity_registrations (id, entity_id, type, country, number) VALUES ('ler_c', 'ent_c', 'ein', 'US', '98-7654321')`,
    );
    await seedEntity(client, { id: 'ent_d', taxIdentifiers: { einOrSsn: '111-22-3333' } });

    const report = await backfillLegalEntities(db, keyring, { execute: false });

    expect(report.taxIdsToReview).toEqual([
      { subject: 'entity ent_a (ent_a)', message: expect.stringContaining('*****6789 nine digits without a dash') },
      { subject: 'entity ent_d (ent_d)', message: expect.stringContaining('*****3333 has the SSN form') },
    ]);
    expect(JSON.stringify(report)).not.toContain('123456789');
    expect(JSON.stringify(report)).not.toContain('111-22-3333');
  });
});

describe('dry-run and re-run', () => {
  it('a dry-run writes nothing and plans exactly what an execute writes', async () => {
    const { client, db } = await tenant();
    await seedEverything(client);
    const before = await snapshot(client);

    const dry = await backfillLegalEntities(db, keyring, { execute: false });

    expect(await snapshot(client)).toEqual(before);
    expect(dry.mode).toBe('dry-run');
    expect(dry.changes).toBeGreaterThan(0);

    const executed = await backfillLegalEntities(db, keyring, { execute: true });
    expect(executed.changes).toBe(dry.changes);
    expect(executed.counts).toEqual(dry.counts);
    expect(executed.differences).toEqual(dry.differences);
    expect(executed.bankIssues).toEqual(dry.bankIssues);
    expect(await snapshot(client)).not.toEqual(before);
  });

  it('running it again changes nothing', async () => {
    const { client, db } = await tenant();
    await seedEverything(client);

    const first = await backfillLegalEntities(db, keyring, { execute: true });
    // emp_nl creates the NL account that ent_nl's bank_details then matches.
    expect(first.counts).toMatchObject({
      employerBanksMatched: 1,
      employerBanksCreated: 2,
      employersLinked: 3,
      nachaCompanyIdsMoved: 1,
      invoiceAccountsMatched: 1,
      invoiceAccountsCreated: 0,
      invoiceAccountsSet: 1,
      registrationsCreated: 1,
      employeesFromPayroll: 1,
      employeesFromDefault: 1,
    });
    const after = await snapshot(client);

    const second = await backfillLegalEntities(db, keyring, { execute: true });
    const dry = await backfillLegalEntities(db, keyring, { execute: false });

    expect(await snapshot(client)).toEqual(after);
    expect(second.changes).toBe(0);
    expect(dry.changes).toBe(0);
    expect(Object.values(second.counts).every((n) => n === 0)).toBe(true);
    // What needs a person still shows up every time.
    expect(second.bankIssues).toEqual(first.bankIssues);
    expect(second.differences).toEqual(first.differences);
    expect(second.taxIdsToReview).toEqual(first.taxIdsToReview);
  });
});
