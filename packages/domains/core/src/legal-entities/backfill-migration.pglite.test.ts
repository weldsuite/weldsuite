/**
 * The legal-entities release 1 migrations (tenant 0248 schema + 0249 data
 * backfill) on fixture rows: duplicate defaults, an employer linked to a live
 * entity, one linked to a deleted entity, two unlinked employers of the same
 * company, employees with and without a payroll profile, custom roles.
 *
 * Applies the journal up to the migration before 0248, seeds, then applies
 * 0248 and 0249 the way the runner does, and 0249 a second time to prove it
 * is safe to re-run.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../../../core/db/drizzle/tenant-migrations');

const SCHEMA_TAG_PREFIX = '0248_';
const BACKFILL_TAG = '0249_legal_entities_backfill';

async function journalTags(): Promise<string[]> {
  const journal = JSON.parse(await readFile(path.join(migrationsDir, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((e) => e.tag);
}

async function applyMigration(client: PGlite, tag: string, tolerant: boolean): Promise<void> {
  const raw = await readFile(path.join(migrationsDir, `${tag}.sql`), 'utf8');
  const statements = raw
    .split(/-->\s*statement-breakpoint/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    try {
      await client.exec(statement);
    } catch (err) {
      const message = (err as Error).message;
      // Same tolerance as the shared harness for the historic migrations;
      // the two under test must run clean.
      if (tolerant && (/already exists/i.test(message) || /does not exist/i.test(message))) continue;
      throw new Error(`${tag}: ${message}\n${statement.slice(0, 300)}`);
    }
  }
}

async function rows<T>(client: PGlite, sql: string): Promise<T[]> {
  return (await client.query<T>(sql)).rows;
}

let client: PGlite;

beforeAll(async () => {
  client = new PGlite({ extensions: { vector, pg_trgm } });
  const tags = await journalTags();
  const schemaIndex = tags.findIndex((t) => t.startsWith(SCHEMA_TAG_PREFIX));
  expect(schemaIndex).toBeGreaterThan(0);
  expect(tags[schemaIndex + 1]).toBe(BACKFILL_TAG);

  for (const tag of tags.slice(0, schemaIndex)) await applyMigration(client, tag, true);

  await client.exec(`
    INSERT INTO settings (id, default_entity_id) VALUES ('set_1', 'ent_b');

    -- Two defaults (ent_a older): settings points at ent_b, so ent_b stays default.
    INSERT INTO entities (id, name, legal_name, jurisdiction_code, base_currency, is_default, created_at,
                          tax_identifiers, branding)
    VALUES
      ('ent_a', 'Acme', 'Acme B.V.', 'NL', 'EUR', true, '2024-01-01',
       '{"vatNumber":"nl 8530.12.345 B01","registrationNumber":"12345678","other":{"LEI":"5493001KJTIIGC8Y1R12"}}',
       '{"logoUrl":"https://x/logo.png","footerText":"Thanks"}'),
      ('ent_b', 'Acme US', 'Acme Inc.', 'US', 'USD', true, '2024-02-01',
       '{"einOrSsn":"12-3456789"}', null),
      ('ent_gone', 'Old', 'Old B.V.', 'NL', 'EUR', false, '2023-01-01', null, null);
    UPDATE entities SET deleted_at = '2024-06-01' WHERE id = 'ent_gone';

    INSERT INTO bank_accounts (id, entity_id, name, iban, ledger_account_id, current_balance, next_check_number)
    VALUES ('ba_1', 'ent_a', 'Main', 'NL91ABNA0417164300', 'acc_1', '12.50', 1001);

    INSERT INTO hr_payroll_employers (id, name, legal_name, country, currency, accounting_entity_id, nl_settings, us_settings, created_at)
    VALUES
      ('emp_linked', 'Acme NL payroll', 'Acme B.V.', 'NL', 'EUR', 'ent_a', '{"loonheffingennummer":"853012345L01"}', '{}', '2024-03-01'),
      ('emp_deleted_link', 'Beta', 'Beta B.V.', 'nl', 'eur', 'ent_gone', '{"loonheffingennummer":"111222333L01"}', '{}', '2024-04-01'),
      ('emp_us_1', 'Gamma East', 'Gamma LLC', 'US', 'USD', null, '{}',
        '{"ein":"98-7654321","states":{"ca":{"withholdingAccountNumber":"123-4567-8","suiAccountNumber":"SUI-9"}}}', '2024-05-01'),
      -- The same EIN without its dash: still one registration.
      ('emp_us_2', 'Gamma West', 'gamma llc ', 'US', 'USD', null, '{}', '{"ein":"987654321"}', '2024-06-01'),
      ('emp_us_ein_clash', 'Acme US payroll', 'Acme Inc.', 'US', 'USD', 'ent_b', '{}', '{"ein":"55-5555555"}', '2024-07-01');

    INSERT INTO hr_employees (id, first_name, last_name, email) VALUES
      ('e_payroll', 'Pay', 'Roll', 'pay@x'),
      ('e_plain', 'No', 'Payroll', 'plain@x'),
      ('e_us', 'Us', 'Er', 'us@x');
    INSERT INTO hr_payroll_profiles (id, employee_id, employer_id) VALUES
      ('pp_1', 'e_payroll', 'emp_deleted_link'),
      ('pp_2', 'e_us', 'emp_us_2');

    INSERT INTO roles (id, name, is_system, permissions) VALUES
      ('role_books', 'Bookkeeper', false, '["entities:update","invoices:read"]'),
      ('role_reader', 'Reader', false, '["invoices:read"]'),
      ('role_null', 'Empty', false, null),
      ('role_revealer', 'Tax', false, '["tax_ids:reveal"]'),
      ('role_sys', 'Admin', true, '["*"]');
  `);

  for (const tag of tags.slice(schemaIndex, schemaIndex + 2)) await applyMigration(client, tag, false);
}, 120_000);

describe('0248 schema: one default legal entity', () => {
  it('keeps settings.default_entity_id as the only default', async () => {
    const defaults = await rows<{ id: string }>(client, `SELECT id FROM entities WHERE is_default AND deleted_at IS NULL`);
    expect(defaults.map((r) => r.id)).toEqual(['ent_b']);
  });

  it('refuses a second default', async () => {
    await expect(client.exec(`UPDATE entities SET is_default = true WHERE id = 'ent_a'`)).rejects.toThrow();
  });
});

describe('0249 backfill', () => {
  it('enables WeldBooks for every existing entity and moves the document texts', async () => {
    const settings = await rows<{ entity_id: string; document_texts: unknown }>(
      client,
      `SELECT entity_id, document_texts FROM accounting_entity_settings ORDER BY entity_id`,
    );
    expect(settings.map((s) => s.entity_id)).toEqual(['ent_a', 'ent_b', 'ent_gone']);
    expect(settings[0].document_texts).toEqual({ footerText: 'Thanks' });
    expect(settings[1].document_texts).toBeNull();
  });

  it('copies the WeldBooks columns of bank accounts', async () => {
    const [row] = await rows<{ ledger_account_id: string; current_balance: string; next_check_number: number }>(
      client,
      `SELECT ledger_account_id, current_balance, next_check_number FROM accounting_bank_account_settings WHERE bank_account_id = 'ba_1'`,
    );
    expect(row).toEqual({ ledger_account_id: 'acc_1', current_balance: '12.50', next_check_number: 1001 });
  });

  it('turns tax identifiers into primary registrations', async () => {
    const regs = await rows<{ entity_id: string; type: string; number: string; is_primary: boolean; label: string | null }>(
      client,
      `SELECT entity_id, type, number, is_primary, label FROM legal_entity_registrations
       WHERE entity_id IN ('ent_a', 'ent_b') AND type IN ('vat', 'company_registration', 'other', 'ein')
       ORDER BY entity_id, type, number`,
    );
    expect(regs).toEqual([
      { entity_id: 'ent_a', type: 'company_registration', number: '12345678', is_primary: true, label: null },
      { entity_id: 'ent_a', type: 'other', number: '5493001KJTIIGC8Y1R12', is_primary: false, label: 'LEI' },
      { entity_id: 'ent_a', type: 'vat', number: 'NL853012345B01', is_primary: true, label: null },
      { entity_id: 'ent_b', type: 'ein', number: '12-3456789', is_primary: true, label: null },
      // The payroll EIN differs from the entity's own: kept, not primary.
      { entity_id: 'ent_b', type: 'ein', number: '55-5555555', is_primary: false, label: 'Acme US payroll' },
    ]);
  });

  it('links employers to live entities and creates one entity per unlinked company', async () => {
    const employers = await rows<{ id: string; legal_entity_id: string | null }>(
      client,
      `SELECT id, legal_entity_id FROM hr_payroll_employers ORDER BY id`,
    );
    const byId = Object.fromEntries(employers.map((e) => [e.id, e.legal_entity_id]));
    expect(byId.emp_linked).toBe('ent_a');
    expect(byId.emp_us_ein_clash).toBe('ent_b');
    // Linked to a deleted entity: a new entity from the employer.
    expect(byId.emp_deleted_link).toMatch(/^ent_[0-9a-f]{24}$/);
    expect(byId.emp_deleted_link).not.toBe('ent_gone');
    // Same company (legal name differs only in case and spaces): one entity.
    expect(byId.emp_us_1).toMatch(/^ent_[0-9a-f]{24}$/);
    expect(byId.emp_us_2).toBe(byId.emp_us_1);

    const [beta] = await rows<{ name: string; jurisdiction_code: string; base_currency: string; locale: string; is_default: boolean }>(
      client,
      `SELECT name, jurisdiction_code, base_currency, locale, is_default FROM entities WHERE id = '${byId.emp_deleted_link}'`,
    );
    expect(beta).toEqual({ name: 'Beta', jurisdiction_code: 'NL', base_currency: 'EUR', locale: 'nl-NL', is_default: false });
  });

  it('copies payroll numbers into registrations and points employers at them', async () => {
    const employers = await rows<{ id: string; legal_entity_id: string; registration_id: string | null }>(
      client,
      `SELECT id, legal_entity_id, registration_id FROM hr_payroll_employers ORDER BY id`,
    );
    const regs = await rows<{ id: string; entity_id: string; type: string; number: string; region: string | null }>(
      client,
      `SELECT id, entity_id, type, number, region FROM legal_entity_registrations`,
    );
    const regOf = (employerId: string) => regs.find((r) => r.id === employers.find((e) => e.id === employerId)?.registration_id);

    expect(regOf('emp_linked')).toMatchObject({ entity_id: 'ent_a', type: 'nl_payroll_tax', number: '853012345L01' });
    expect(regOf('emp_us_ein_clash')).toMatchObject({ entity_id: 'ent_b', type: 'ein', number: '55-5555555' });
    // Two employers with the same EIN on one entity share one registration.
    expect(regOf('emp_us_1')).toBeDefined();
    expect(regOf('emp_us_2')?.id).toBe(regOf('emp_us_1')?.id);

    const gammaEntity = employers.find((e) => e.id === 'emp_us_1')!.legal_entity_id;
    // 98-7654321 and 987654321 are one number: one EIN registration.
    expect(regs.filter((r) => r.entity_id === gammaEntity && r.type === 'ein')).toHaveLength(1);
    const state = regs.filter((r) => r.entity_id === gammaEntity && r.type.startsWith('us_state_'));
    expect(state.map((r) => [r.type, r.region, r.number]).sort()).toEqual([
      ['us_state_unemployment', 'CA', 'SUI-9'],
      ['us_state_withholding', 'CA', '123-4567-8'],
    ]);
  });

  it('gives every employee an employing entity', async () => {
    const employees = await rows<{ id: string; legal_entity_id: string | null }>(
      client,
      `SELECT id, legal_entity_id FROM hr_employees ORDER BY id`,
    );
    const employers = await rows<{ id: string; legal_entity_id: string }>(
      client,
      `SELECT id, legal_entity_id FROM hr_payroll_employers`,
    );
    const entityOf = (id: string) => employers.find((e) => e.id === id)!.legal_entity_id;
    expect(Object.fromEntries(employees.map((e) => [e.id, e.legal_entity_id]))).toEqual({
      e_payroll: entityOf('emp_deleted_link'),
      e_plain: 'ent_b',
      e_us: entityOf('emp_us_2'),
    });
  });

  it('backfills legal entity permissions on custom roles only', async () => {
    const roles = await rows<{ id: string; permissions: string[] | null }>(client, `SELECT id, permissions FROM roles ORDER BY id`);
    const perms = Object.fromEntries(roles.map((r) => [r.id, r.permissions]));
    expect(perms.role_books).toEqual([
      'entities:update', 'invoices:read', 'legal_entities:read',
      'legal_entities:create', 'legal_entities:update', 'legal_entities:delete',
    ]);
    expect(perms.role_reader).toEqual(['invoices:read', 'legal_entities:read']);
    expect(perms.role_null).toEqual(['legal_entities:read']);
    expect(perms.role_revealer).toEqual(['tax_ids:reveal', 'legal_entities:read', 'legal_entities:reveal']);
    expect(perms.role_sys).toEqual(['*']);
  });

  it('is safe to run again', async () => {
    const count = async (table: string) =>
      Number((await rows<{ n: number }>(client, `SELECT count(*)::int AS n FROM ${table}`))[0].n);
    const before = {
      entities: await count('entities'),
      registrations: await count('legal_entity_registrations'),
      settings: await count('accounting_entity_settings'),
      roles: JSON.stringify(await rows(client, `SELECT id, permissions FROM roles ORDER BY id`)),
    };
    await applyMigration(client, BACKFILL_TAG, false);
    expect({
      entities: await count('entities'),
      registrations: await count('legal_entity_registrations'),
      settings: await count('accounting_entity_settings'),
      roles: JSON.stringify(await rows(client, `SELECT id, permissions FROM roles ORDER BY id`)),
    }).toEqual(before);
  });
});
