/**
 * The employer as the payroll engines see it, built from a legal entity and
 * the registration and bank account payroll runs under
 * (docs/plans/legal-entities.md, WeldHR).
 *
 * `loadEmployerForPayroll` merges the entity (name, legal name, country,
 * currency, address), the registration (loonheffingennummer / EIN) and the
 * core bank account into the row shape every payroll service and engine
 * already takes (`EmployerRow`, plus the resolved salary account). Release 1:
 * an employer without a link (or whose link no longer resolves) keeps its
 * deprecated copied columns, so a workspace without legal entities, and every
 * existing output (loonaangifte XML, SEPA, NACHA, 941/W-2), is unchanged.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { decryptField, keyringFromEnv, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import type { HrPayrollAddress, HrPayrollEmployerBank } from '@weldsuite/db/schema';
import { getLegalEntityExtension } from '@weldsuite/core-domain/legal-entities';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { HrNotFoundError } from '../shared';
import type { EmployerRow } from './common';

type EntityRow = typeof schema.legalEntities.$inferSelect;
type RegistrationRow = typeof schema.legalEntityRegistrations.$inferSelect;
type BankAccountRow = typeof schema.bankAccounts.$inferSelect;

/** A keyring, or the worker env it is built from. */
export type PayrollKeys =
  | EncryptionKeyring
  | { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string; FIELD_ENCRYPTION_AAD_WRITES?: string };

function keyringOf(keys: PayrollKeys | undefined): EncryptionKeyring {
  if (!keys) return {};
  if ('DATABASE_ENCRYPTION_KEY' in keys || 'DATABASE_ENCRYPTION_KEY_V2' in keys || 'FIELD_ENCRYPTION_AAD_WRITES' in keys) {
    return keyringFromEnv(keys);
  }
  return keys as EncryptionKeyring;
}

export interface EmployerLinks {
  entity: EntityRow | null;
  registration: RegistrationRow | null;
  bankAccount: BankAccountRow | null;
  /** WeldBooks is enabled for the legal entity (it has an `accounting_entity_settings` row). */
  booksEnabled: boolean;
}

/**
 * An employer row with the entity facts merged in. `linkedBank` is the salary
 * account of the linked core bank account; undefined when the employer has no
 * such link (the deprecated `bank_encrypted` is then the account).
 */
export type PayrollEmployer = EmployerRow & {
  linkedBank?: HrPayrollEmployerBank | null;
  links: EmployerLinks;
};

const unique = (values: Array<string | null | undefined>): string[] => [...new Set(values.filter((v): v is string => Boolean(v)))];

function addressOf(entity: EntityRow, fallback: HrPayrollAddress): HrPayrollAddress {
  const a = entity.address;
  if (!a) return fallback;
  const mapped: HrPayrollAddress = {
    line1: a.line1 ?? a.street,
    line2: a.line2,
    houseNumber: a.houseNumber,
    houseNumberAddition: a.houseNumberAddition,
    postalCode: a.postalCode,
    city: a.city,
    region: a.state ?? a.province,
    country: a.country,
  };
  // Only what the entity actually has overrides the copied address.
  const defined = Object.fromEntries(Object.entries(mapped).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  return { ...fallback, ...defined };
}

async function previousBank(row: EmployerRow, keyring: EncryptionKeyring): Promise<HrPayrollEmployerBank> {
  if (!row.bankEncrypted) return {};
  try {
    return JSON.parse(await decryptField(row.bankEncrypted, keyring)) as HrPayrollEmployerBank;
  } catch {
    return {};
  }
}

/** The salary account of a core bank account; fields it does not hold (NACHA company id, account type) keep the copied account's. */
async function bankFromAccount(account: BankAccountRow, row: EmployerRow, keyring: EncryptionKeyring): Promise<HrPayrollEmployerBank> {
  const previous = await previousBank(row, keyring);
  let accountNumber: string | null = null;
  if (account.accountNumberEncrypted) {
    try {
      accountNumber = await decryptField(account.accountNumberEncrypted, keyring);
    } catch {
      accountNumber = previous.accountNumber ?? null;
    }
  }
  const ach = (account.achSettings ?? {}) as Record<string, unknown>;
  const accountType = account.accountType === 'savings' || account.accountType === 'checking' ? account.accountType : null;
  return {
    ...previous,
    accountHolder: account.accountHolderName ?? null,
    iban: account.iban ?? null,
    bic: account.bic ?? null,
    routingNumber: account.routingNumber ?? null,
    accountNumber,
    accountType: accountType ?? previous.accountType ?? null,
    bankName: account.bankName ?? null,
    nachaCompanyId: typeof ach.companyIdentification === 'string' ? ach.companyIdentification : previous.nachaCompanyId ?? null,
  };
}

/** Merge entity, registration and bank account into each row. Four queries at most, whatever the number of rows. */
export async function resolveEmployers(db: Database, rows: EmployerRow[], keys?: PayrollKeys): Promise<PayrollEmployer[]> {
  if (rows.length === 0) return [];
  const keyring = keyringOf(keys);
  const entityIds = unique(rows.map((r) => r.legalEntityId));
  const registrationIds = unique(rows.map((r) => r.registrationId));
  const bankIds = unique(rows.map((r) => r.bankAccountId));

  const [entities, registrations, banks, booksEnabled] = await Promise.all([
    entityIds.length
      ? db
          .select()
          .from(schema.legalEntities)
          .where(and(inArray(schema.legalEntities.id, entityIds), isNull(schema.legalEntities.deletedAt)))
      : Promise.resolve([] as EntityRow[]),
    registrationIds.length
      ? db
          .select()
          .from(schema.legalEntityRegistrations)
          .where(and(inArray(schema.legalEntityRegistrations.id, registrationIds), isNull(schema.legalEntityRegistrations.deletedAt)))
      : Promise.resolve([] as RegistrationRow[]),
    bankIds.length
      ? db
          .select()
          .from(schema.bankAccounts)
          .where(and(inArray(schema.bankAccounts.id, bankIds), isNull(schema.bankAccounts.deletedAt)))
      : Promise.resolve([] as BankAccountRow[]),
    entityIds.length ? getLegalEntityExtension('weldbooks').enabledFor(db, entityIds) : Promise.resolve(new Set<string>()),
  ]);
  const entityById = new Map(entities.map((e) => [e.id, e]));
  const registrationById = new Map(registrations.map((r) => [r.id, r]));
  const bankById = new Map(banks.map((b) => [b.id, b]));

  const out: PayrollEmployer[] = [];
  for (const row of rows) {
    const entity = row.legalEntityId ? entityById.get(row.legalEntityId) ?? null : null;
    const registrationRow = row.registrationId ? registrationById.get(row.registrationId) ?? null : null;
    const bankRow = row.bankAccountId ? bankById.get(row.bankAccountId) ?? null : null;
    // A link only counts when it belongs to the employer's entity.
    const registration = entity && registrationRow?.entityId === entity.id ? registrationRow : null;
    const bankAccount = entity && bankRow?.entityId === entity.id ? bankRow : null;
    const books = Boolean(entity && booksEnabled.has(entity.id));

    const merged: PayrollEmployer = { ...row, links: { entity, registration, bankAccount, booksEnabled: books } };
    if (entity) {
      merged.name = row.label?.trim() || entity.name;
      merged.legalName = entity.legalName?.trim() || entity.name;
      const country = entity.jurisdictionCode.slice(0, 2).toUpperCase();
      // Payroll runs in NL and US; an entity elsewhere keeps the employer's own country.
      if (country === 'NL' || country === 'US') merged.country = country;
      merged.currency = entity.baseCurrency;
      merged.address = addressOf(entity, row.address);
    }
    if (registration?.type === 'nl_payroll_tax') {
      merged.nlSettings = { ...row.nlSettings, loonheffingennummer: registration.number };
    } else if (registration?.type === 'ein') {
      merged.usSettings = { ...row.usSettings, ein: registration.number };
    }
    if (bankAccount) merged.linkedBank = await bankFromAccount(bankAccount, row, keyring);
    out.push(merged);
  }
  return out;
}

/** The employer for the payroll engines, or null when there is none. Soft-deleted employers still resolve (their runs and filings exist). */
export async function findEmployerForPayroll(db: Database, employerId: string, keys?: PayrollKeys): Promise<PayrollEmployer | null> {
  const [row] = await db.select().from(schema.hrPayrollEmployers).where(eq(schema.hrPayrollEmployers.id, employerId)).limit(1);
  if (!row) return null;
  return (await resolveEmployers(db, [row], keys))[0] ?? null;
}

/** `findEmployerForPayroll`, or a 404. */
export async function loadEmployerForPayroll(db: Database, employerId: string, keys?: PayrollKeys): Promise<PayrollEmployer> {
  const employer = await findEmployerForPayroll(db, employerId, keys);
  if (!employer) throw new HrNotFoundError('Payroll employer', employerId);
  return employer;
}
