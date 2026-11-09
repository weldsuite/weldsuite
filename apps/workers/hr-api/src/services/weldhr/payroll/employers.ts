/**
 * Payroll employers: the legal employer a pay run and its filings are under.
 *
 * The salary account (IBAN, or routing + account number) is an AES-GCM blob
 * (`bank_encrypted`) encrypted with the same keyring as the employee sensitive
 * block, and only ever returned masked.
 */

import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { decryptField, encryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import type { HrPayrollEmployerBank, HrPayrollIssue } from '@weldsuite/db/schema';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type {
  CreateHrPayrollEmployerInput,
  HrPayrollEmployerBankInput,
  UpdateHrPayrollEmployerInput,
} from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import type { HrPayrollEmployer as EmployerDto, HrPayrollEmployerBankMasked } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import {
  createBankAccount,
  createRegistration,
  updateBankAccount,
  LegalEntityError,
} from '@weldsuite/core-domain/legal-entities';
import { HrConflictError, HrNotFoundError, HrValidationError } from '../shared';
import { sortIssues, yearOfDate, type EmployerRow } from './common';
import { resolveEmployers } from './employer-context';
import { todayIso } from './dates';
import { isValidIban, isValidRoutingNumber, maskAccountNumber, maskIban, normalizeBic, normalizeIban } from './validators';

const t = schema.hrPayrollEmployers;

export async function requireEmployerRow(db: Database, id: string): Promise<EmployerRow> {
  const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
  if (!row) throw new HrNotFoundError('Payroll employer', id);
  return row;
}

/** The salary account: the linked core bank account when the employer has one (see employer-context.ts), else the sealed copy. */
export async function readEmployerBank(
  row: Pick<EmployerRow, 'bankEncrypted'> & { linkedBank?: HrPayrollEmployerBank | null },
  keyring: EncryptionKeyring,
): Promise<HrPayrollEmployerBank | null> {
  if (row.linkedBank !== undefined) return row.linkedBank;
  if (!row.bankEncrypted) return null;
  return JSON.parse(await decryptField(row.bankEncrypted, keyring)) as HrPayrollEmployerBank;
}

function maskBank(bank: HrPayrollEmployerBank | null): HrPayrollEmployerBankMasked | null {
  if (!bank) return null;
  return {
    accountHolder: bank.accountHolder ?? null,
    ibanMasked: maskIban(bank.iban),
    bic: bank.bic ?? null,
    routingNumber: bank.routingNumber ?? null,
    accountNumberMasked: maskAccountNumber(bank.accountNumber),
    accountType: bank.accountType ?? null,
    nachaCompanyId: bank.nachaCompanyId ?? null,
    bankName: bank.bankName ?? null,
  };
}

/** US states the employer's active employees work in. */
export function workStatesOf(profiles: Array<{ us: { workState?: string | null } }>): string[] {
  return [...new Set(profiles.map((p) => p.us.workState).filter((s): s is string => Boolean(s)))].sort();
}

/**
 * What is still missing before a run can be approved or paid. Errors block
 * approval; warnings (the salary account) only block the payment file.
 */
export function employerIssues(
  row: EmployerRow,
  bank: HrPayrollEmployerBank | null,
  workStates: string[],
  year: number,
): HrPayrollIssue[] {
  const issues: HrPayrollIssue[] = [];
  if (row.country === 'NL') {
    const nl = row.nlSettings;
    if (!nl.loonheffingennummer) issues.push({ severity: 'error', code: 'employer_incomplete', params: { field: 'loonheffingennummer' } });
    // The sector decides the Whk rate for small employers and is written into the loonaangifte.
    if (!nl.sectorCode) issues.push({ severity: 'error', code: 'employer_incomplete', params: { field: 'sectorCode' } });
    const yearSettings = nl.years?.[String(year)];
    if (yearSettings?.whkRate === null || yearSettings?.whkRate === undefined) {
      // Without an individual rate the engine uses the sector's small-employer rate.
      issues.push({ severity: 'warning', code: 'employer_incomplete', params: { field: 'whk_rate', year } });
    }
    // The loonaangifte names a contact person.
    if (!nl.contactName) issues.push({ severity: 'warning', code: 'employer_incomplete', params: { field: 'contactName' } });
    if (!nl.contactPhone) issues.push({ severity: 'warning', code: 'employer_incomplete', params: { field: 'contactPhone' } });
    if (!bank?.iban) issues.push({ severity: 'warning', code: 'employer_incomplete', params: { field: 'bank_iban' } });
  } else {
    const us = row.usSettings;
    if (!us.ein) issues.push({ severity: 'error', code: 'employer_incomplete', params: { field: 'ein' } });
    for (const state of workStates) {
      const rate = us.states?.[state]?.suiRates?.[String(year)];
      if (rate === undefined || rate === null) {
        issues.push({ severity: 'error', code: 'employer_incomplete', params: { field: 'sui_rate', state, year } });
      }
    }
    if (!bank?.routingNumber) issues.push({ severity: 'warning', code: 'employer_incomplete', params: { field: 'bank_routing' } });
    if (!bank?.accountNumber) issues.push({ severity: 'warning', code: 'employer_incomplete', params: { field: 'bank_account' } });
    if (!bank?.nachaCompanyId) issues.push({ severity: 'warning', code: 'employer_incomplete', params: { field: 'nacha_company_id' } });
  }
  return sortIssues(issues);
}

async function entityNames(db: Database, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const rows = await db
    .select({ id: schema.entities.id, name: schema.entities.name })
    .from(schema.entities)
    .where(and(inArray(schema.entities.id, unique), isNull(schema.entities.deletedAt)));
  for (const row of rows) out.set(row.id, row.name);
  return out;
}

/** Active payroll profiles per employer (for counts, the SUI states and the employer issues). */
export async function profilesByEmployer(db: Database, employerIds: string[]) {
  const out = new Map<string, Array<typeof schema.hrPayrollProfiles.$inferSelect>>();
  if (employerIds.length === 0) return out;
  const p = schema.hrPayrollProfiles;
  const rows = await db.select().from(p).where(and(inArray(p.employerId, employerIds), eq(p.status, 'active')));
  for (const row of rows) {
    const list = out.get(row.employerId) ?? [];
    list.push(row);
    out.set(row.employerId, list);
  }
  return out;
}

export async function toEmployerDtos(
  db: Database,
  rawRows: EmployerRow[],
  keyring: EncryptionKeyring,
  today: string = todayIso(),
): Promise<EmployerDto[]> {
  if (rawRows.length === 0) return [];
  const [rows, profiles] = await Promise.all([
    resolveEmployers(db, rawRows, keyring),
    profilesByEmployer(db, rawRows.map((r) => r.id)),
  ]);
  const year = yearOfDate(today);
  const accountingNames = await entityNames(db, rows.map((r) => r.accountingEntityId));
  const out: EmployerDto[] = [];
  for (const row of rows) {
    const bank = await readEmployerBank(row, keyring);
    const active = profiles.get(row.id) ?? [];
    const { entity, registration, booksEnabled } = row.links;
    out.push({
      id: row.id,
      legalEntityId: row.legalEntityId,
      legalEntityName: entity?.name ?? null,
      registrationId: row.registrationId,
      registrationNumber: registration?.number ?? row.nlSettings.loonheffingennummer ?? row.usSettings.ein ?? null,
      bankAccountId: row.bankAccountId,
      label: row.label,
      booksEnabled,
      name: row.name,
      legalName: row.legalName,
      country: row.country as 'NL' | 'US',
      currency: row.currency,
      accountingEntityId: row.accountingEntityId,
      accountingEntityName: row.accountingEntityId ? accountingNames.get(row.accountingEntityId) ?? null : null,
      address: row.address,
      nlSettings: row.nlSettings,
      usSettings: row.usSettings,
      requireSeparateApprover: row.requireSeparateApprover,
      isActive: row.isActive,
      bank: maskBank(bank),
      employeeCount: active.length,
      issues: employerIssues(row, bank, workStatesOf(active), year),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  return out;
}

/** `entity`: condition on `hr_payroll_employers.legal_entity_id` (the request's entity scope); undefined = every employer. */
export async function listEmployers(db: Database, keyring: EncryptionKeyring, entity?: SQL): Promise<EmployerDto[]> {
  const rows = await db.select().from(t).where(and(isNull(t.deletedAt), entity)).orderBy(t.name);
  return toEmployerDtos(db, rows, keyring);
}

export async function getEmployer(db: Database, id: string, keyring: EncryptionKeyring): Promise<EmployerDto> {
  const row = await requireEmployerRow(db, id);
  return (await toEmployerDtos(db, [row], keyring))[0]!;
}

// ---------------------------------------------------------------------------
// Legal entity, registration and bank account (docs/plans/legal-entities.md)
// ---------------------------------------------------------------------------

type KeyEnv = { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string };
const keyEnvOf = (keyring: EncryptionKeyring): KeyEnv => ({
  DATABASE_ENCRYPTION_KEY: keyring.v1,
  DATABASE_ENCRYPTION_KEY_V2: keyring.v2,
});

/** Core errors (unknown entity, bad number…) answer as WeldHR ones. */
async function viaCore<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof LegalEntityError) {
      if (err.code === 'NOT_FOUND') throw new HrNotFoundError('Legal entity', err.message, err.message);
      if (err.code === 'CONFLICT') throw new HrConflictError(err.message);
      throw new HrValidationError(err.message);
    }
    throw err;
  }
}

async function workspaceHasEntities(db: Database): Promise<boolean> {
  const [row] = await db.select({ id: schema.legalEntities.id }).from(schema.legalEntities).where(isNull(schema.legalEntities.deletedAt)).limit(1);
  return Boolean(row);
}

async function requireEntity(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(schema.legalEntities)
    .where(and(eq(schema.legalEntities.id, id), isNull(schema.legalEntities.deletedAt)))
    .limit(1);
  if (!row) throw new HrNotFoundError('Legal entity', id);
  return row;
}

function payrollCountryOf(jurisdictionCode: string): 'NL' | 'US' {
  const country = jurisdictionCode.slice(0, 2).toUpperCase();
  if (country !== 'NL' && country !== 'US') {
    throw new HrValidationError(`WeldHR payroll supports the Netherlands and the United States; this legal entity is registered in ${country}`);
  }
  return country;
}

const REGISTRATION_TYPE: Record<'NL' | 'US', 'nl_payroll_tax' | 'ein'> = { NL: 'nl_payroll_tax', US: 'ein' };

/** A registration of the entity of the right type for the country (loonheffingennummer or EIN). */
async function requirePayrollRegistration(db: Database, entityId: string, registrationId: string, country: 'NL' | 'US') {
  const [row] = await db
    .select()
    .from(schema.legalEntityRegistrations)
    .where(
      and(
        eq(schema.legalEntityRegistrations.id, registrationId),
        eq(schema.legalEntityRegistrations.entityId, entityId),
        isNull(schema.legalEntityRegistrations.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new HrValidationError('That registration does not belong to this legal entity');
  if (row.type !== REGISTRATION_TYPE[country]) {
    throw new HrValidationError(
      country === 'NL' ? 'Payroll runs under a loonheffingennummer (nl_payroll_tax registration)' : 'Payroll runs under an EIN registration',
    );
  }
  return row;
}

async function requireEntityBankAccount(db: Database, entityId: string, accountId: string) {
  const [row] = await db
    .select()
    .from(schema.bankAccounts)
    .where(and(eq(schema.bankAccounts.id, accountId), eq(schema.bankAccounts.entityId, entityId), isNull(schema.bankAccounts.deletedAt)))
    .limit(1);
  if (!row) throw new HrValidationError('That bank account does not belong to this legal entity');
  return row;
}

/** Check inline bank details with the payroll validators before they become a core bank account. */
function checkBankInput(input: HrPayrollEmployerBankInput) {
  if (input.iban && input.iban.trim() !== '' && !isValidIban(normalizeIban(input.iban))) throw new HrValidationError('The IBAN is not valid');
  if (input.bic && input.bic.trim() !== '' && !normalizeBic(input.bic)) throw new HrValidationError('The BIC is not valid');
  if (input.routingNumber && !isValidRoutingNumber(input.routingNumber)) throw new HrValidationError('The routing number is not valid (checksum)');
}

/** Inline salary account → a core bank account of the entity. */
async function createEntityBankAccount(
  db: Database,
  entityId: string,
  input: HrPayrollEmployerBankInput,
  keyring: EncryptionKeyring,
) {
  checkBankInput(input);
  const account = await viaCore(() =>
    createBankAccount(db, keyEnvOf(keyring), entityId, {
      name: input.bankName?.trim() || input.accountHolder?.trim() || 'Payroll account',
      accountHolderName: input.accountHolder ?? null,
      iban: input.iban ? normalizeIban(input.iban) : null,
      bic: input.bic ? normalizeBic(input.bic) : null,
      bankName: input.bankName ?? null,
      accountType: input.accountType ?? null,
      routingNumber: input.routingNumber ?? null,
      accountNumber: input.accountNumber ?? null,
      achSettings: input.nachaCompanyId ? { companyIdentification: input.nachaCompanyId } : null,
    }),
  );
  return account.id;
}

/**
 * Release 1 mirror: the deprecated columns an employer keeps are written from
 * the entity, the registration and the bank account, so a reader that still
 * uses them (the Rust backend, an older worker) sees the same facts.
 */
async function mirrorFromLinks(db: Database, employerId: string, keyring: EncryptionKeyring): Promise<void> {
  const [raw] = await db.select().from(t).where(eq(t.id, employerId)).limit(1);
  if (!raw?.legalEntityId) return;
  const [merged] = await resolveEmployers(db, [raw], keyring);
  if (!merged?.links.entity) return;
  const { entity, registration, booksEnabled } = merged.links;
  const patch: Partial<typeof t.$inferInsert> = {
    // The label is the registration's own name; the mirrored `name` is the entity's.
    name: entity.name,
    legalName: entity.legalName?.trim() || entity.name,
    country: merged.country,
    currency: merged.currency,
    address: merged.address,
    accountingEntityId: booksEnabled ? entity.id : null,
    updatedAt: new Date(),
  };
  if (registration?.type === 'nl_payroll_tax') patch.nlSettings = { ...raw.nlSettings, loonheffingennummer: registration.number };
  if (registration?.type === 'ein') patch.usSettings = { ...raw.usSettings, ein: registration.number };
  if (merged.linkedBank && (keyring.v1 || keyring.v2)) {
    patch.bankEncrypted = await encryptField(JSON.stringify(merged.linkedBank), keyring);
  }
  await db.update(t).set(patch).where(eq(t.id, employerId));
}

async function assertAccountingEntity(db: Database, entityId: string, country: string) {
  const [row] = await db
    .select({ id: schema.entities.id, jurisdictionCode: schema.entities.jurisdictionCode })
    .from(schema.entities)
    .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
    .limit(1);
  if (!row) throw new HrValidationError('The accounting entity does not exist');
  if (row.jurisdictionCode !== country) {
    throw new HrValidationError(`The accounting entity is registered in ${row.jurisdictionCode}; this employer is in ${country}`);
  }
}

export async function createEmployer(
  db: Database,
  input: CreateHrPayrollEmployerInput,
  ctx: { createdBy: string; keyring: EncryptionKeyring },
): Promise<EmployerDto> {
  if (!input.legalEntityId) {
    // Release 1: the pre-entity shape (name, legal name, country, optional accounting entity) is still
    // accepted from clients that predate legal entities; the platform always sends legalEntityId.
    if (!input.name && !input.legalName && !input.country && (await workspaceHasEntities(db))) {
      throw new HrValidationError('Choose the legal entity this employer belongs to');
    }
    return createLegacyEmployer(db, input, ctx);
  }

  const entity = await requireEntity(db, input.legalEntityId);
  const country = payrollCountryOf(entity.jurisdictionCode);
  if (input.registrationId && input.registrationNumber) {
    throw new HrValidationError('Give a registrationId or a registrationNumber, not both');
  }
  if (input.bankAccountId && input.bank) throw new HrValidationError('Give a bankAccountId or bank details, not both');

  let registrationId: string | null = null;
  if (input.registrationId) {
    registrationId = (await requirePayrollRegistration(db, entity.id, input.registrationId, country)).id;
  } else if (input.registrationNumber) {
    const number = input.registrationNumber;
    registrationId = (await viaCore(() => createRegistration(db, entity.id, { type: REGISTRATION_TYPE[country], number, country }))).id;
  }
  let bankAccountId: string | null = null;
  if (input.bankAccountId) {
    bankAccountId = (await requireEntityBankAccount(db, entity.id, input.bankAccountId)).id;
  } else if (input.bank) {
    bankAccountId = await createEntityBankAccount(db, entity.id, input.bank, ctx.keyring);
  }

  const id = generateId('hrpe');
  await db.insert(t).values({
    id,
    name: entity.name,
    legalName: entity.legalName?.trim() || entity.name,
    country,
    currency: entity.baseCurrency,
    legalEntityId: entity.id,
    registrationId,
    bankAccountId,
    label: input.label?.trim() || null,
    address: input.address ?? {},
    nlSettings: country === 'NL' ? (input.nlSettings ?? {}) : {},
    usSettings: country === 'US' ? (input.usSettings ?? {}) : {},
    requireSeparateApprover: input.requireSeparateApprover ?? false,
    createdBy: ctx.createdBy,
  });
  await mirrorFromLinks(db, id, ctx.keyring);
  return getEmployer(db, id, ctx.keyring);
}

async function createLegacyEmployer(
  db: Database,
  input: CreateHrPayrollEmployerInput,
  ctx: { createdBy: string; keyring: EncryptionKeyring },
): Promise<EmployerDto> {
  if (!input.name || !input.legalName || !input.country) {
    throw new HrValidationError('Give the employer a name, legal name and country, or a legal entity');
  }
  if (input.accountingEntityId) await assertAccountingEntity(db, input.accountingEntityId, input.country);
  const currency = (input.currency ?? (input.country === 'NL' ? 'EUR' : 'USD')).toUpperCase();
  const id = generateId('hrpe');
  await db.insert(t).values({
    id,
    name: input.name.trim(),
    legalName: input.legalName.trim(),
    country: input.country,
    currency,
    accountingEntityId: input.accountingEntityId ?? null,
    label: input.label?.trim() || null,
    address: input.address ?? {},
    nlSettings: input.country === 'NL' ? (input.nlSettings ?? {}) : {},
    usSettings: input.country === 'US' ? (input.usSettings ?? {}) : {},
    requireSeparateApprover: input.requireSeparateApprover ?? false,
    createdBy: ctx.createdBy,
  });
  return getEmployer(db, id, ctx.keyring);
}

/** Merge a settings object one level deep: `years` / `states` keep the entries not mentioned. */
function mergeSettings<T extends object>(current: T, patch: Partial<T> | undefined, mapKeys: Array<keyof T>): T {
  if (!patch) return current;
  const next = { ...current, ...patch } as T;
  for (const key of mapKeys) {
    const incoming = patch[key];
    if (incoming && typeof incoming === 'object') {
      (next as Record<keyof T, unknown>)[key] = { ...((current[key] as object | undefined) ?? {}), ...incoming };
    }
  }
  return next;
}

export async function updateEmployer(
  db: Database,
  id: string,
  input: UpdateHrPayrollEmployerInput,
  keyring: EncryptionKeyring,
): Promise<EmployerDto> {
  const row = await requireEmployerRow(db, id);
  const wasLinked = Boolean(row.legalEntityId);

  // Moving an employer to another entity is only possible while nothing runs under it.
  let entityId = row.legalEntityId;
  if (input.legalEntityId && input.legalEntityId !== row.legalEntityId) {
    await requireEntity(db, input.legalEntityId);
    if (row.legalEntityId) await assertNothingRunsUnder(db, id);
    entityId = input.legalEntityId;
  }
  const country = entityId ? payrollCountryOf((await requireEntity(db, entityId)).jurisdictionCode) : (row.country as 'NL' | 'US');
  if (entityId && entityId !== row.legalEntityId && country !== row.country) {
    throw new HrValidationError(`This employer is in ${row.country}; the legal entity is in ${country}`);
  }

  let registrationId = row.registrationId;
  let bankAccountId = row.bankAccountId;
  if (entityId !== row.legalEntityId) {
    // Links belong to the entity they were chosen on.
    registrationId = null;
    bankAccountId = null;
  }
  if (input.registrationId !== undefined) {
    if (input.registrationId && !entityId) throw new HrValidationError('Choose a legal entity before linking a registration');
    registrationId = input.registrationId ? (await requirePayrollRegistration(db, entityId!, input.registrationId, country)).id : null;
  }
  if (input.bankAccountId !== undefined) {
    if (input.bankAccountId && !entityId) throw new HrValidationError('Choose a legal entity before linking a bank account');
    bankAccountId = input.bankAccountId ? (await requireEntityBankAccount(db, entityId!, input.bankAccountId)).id : null;
  }
  if (!entityId && input.accountingEntityId) await assertAccountingEntity(db, input.accountingEntityId, row.country);

  // The copied company facts are the entity's once there is one; an employer with an entity ignores them.
  const ownFacts = !wasLinked && !entityId;
  await db
    .update(t)
    .set({
      ...(entityId !== row.legalEntityId && { legalEntityId: entityId }),
      ...(registrationId !== row.registrationId && { registrationId }),
      ...(bankAccountId !== row.bankAccountId && { bankAccountId }),
      ...(input.label !== undefined && { label: input.label?.trim() || null }),
      ...(ownFacts && input.name !== undefined && { name: input.name.trim() }),
      ...(ownFacts && input.legalName !== undefined && { legalName: input.legalName.trim() }),
      ...(ownFacts && input.accountingEntityId !== undefined && { accountingEntityId: input.accountingEntityId }),
      ...(ownFacts && input.address !== undefined && { address: { ...row.address, ...input.address } }),
      ...(input.nlSettings !== undefined && row.country === 'NL' && { nlSettings: mergeSettings(row.nlSettings, input.nlSettings, ['years']) }),
      ...(input.usSettings !== undefined && row.country === 'US' && { usSettings: mergeSettings(row.usSettings, input.usSettings, ['states']) }),
      ...(input.requireSeparateApprover !== undefined && { requireSeparateApprover: input.requireSeparateApprover }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      updatedAt: new Date(),
    })
    .where(eq(t.id, id));
  if (entityId) await mirrorFromLinks(db, id, keyring);
  return getEmployer(db, id, keyring);
}

async function assertNothingRunsUnder(db: Database, employerId: string) {
  const [run] = await db.select({ id: schema.hrPayRuns.id }).from(schema.hrPayRuns).where(eq(schema.hrPayRuns.employerId, employerId)).limit(1);
  const [profile] = await db
    .select({ id: schema.hrPayrollProfiles.id })
    .from(schema.hrPayrollProfiles)
    .where(and(eq(schema.hrPayrollProfiles.employerId, employerId), sql`${schema.hrPayrollProfiles.status} <> 'ended'`))
    .limit(1);
  if (run || profile) {
    throw new HrConflictError('This employer has pay runs or employees on its payroll, so it cannot move to another legal entity.');
  }
}

/**
 * Store the salary account. Fields not mentioned are kept, `null` clears one.
 * Returns which fields changed (names only: the caller audits them). An
 * employer linked to a core bank account changes that account (and its copy);
 * any other keeps the sealed copy on the employer.
 */
export async function setEmployerBank(
  db: Database,
  id: string,
  input: HrPayrollEmployerBankInput,
  keyring: EncryptionKeyring,
): Promise<{ employer: EmployerDto; changedFields: string[] }> {
  const row = await requireEmployerRow(db, id);
  if (!keyring.v1 && !keyring.v2) throw new HrValidationError('Bank details cannot be stored: the worker has no encryption key');
  const [resolved] = await resolveEmployers(db, [row], keyring);
  const current = (await readEmployerBank(resolved!, keyring)) ?? {};
  const next: HrPayrollEmployerBank = { ...current };
  const changedFields: string[] = [];

  const apply = <K extends keyof HrPayrollEmployerBank>(key: K, value: HrPayrollEmployerBank[K] | undefined) => {
    if (value === undefined) return;
    if ((current[key] ?? null) !== value) changedFields.push(key);
    next[key] = value;
  };

  if (input.iban !== undefined) {
    if (input.iban === null || input.iban.trim() === '') {
      apply('iban', null);
    } else {
      const iban = normalizeIban(input.iban);
      if (!isValidIban(iban)) throw new HrValidationError('The IBAN is not valid');
      apply('iban', iban);
    }
  }
  if (input.bic !== undefined) {
    if (input.bic === null || input.bic.trim() === '') {
      apply('bic', null);
    } else {
      const bic = normalizeBic(input.bic);
      if (!bic) throw new HrValidationError('The BIC is not valid');
      apply('bic', bic);
    }
  }
  if (input.routingNumber !== undefined) {
    if (input.routingNumber !== null && !isValidRoutingNumber(input.routingNumber)) {
      throw new HrValidationError('The routing number is not valid (checksum)');
    }
    apply('routingNumber', input.routingNumber);
  }
  apply('accountHolder', input.accountHolder);
  apply('accountNumber', input.accountNumber);
  apply('accountType', input.accountType);
  apply('nachaCompanyId', input.nachaCompanyId);
  apply('bankName', input.bankName);

  if (changedFields.length > 0) {
    const account = resolved!.links.bankAccount;
    if (account && row.legalEntityId) {
      const ach = { ...((account.achSettings ?? {}) as Record<string, unknown>) };
      if (next.nachaCompanyId) ach.companyIdentification = next.nachaCompanyId;
      else delete ach.companyIdentification;
      // The core update re-seals the copy on every employer that pays from this account.
      await viaCore(() =>
        updateBankAccount(db, keyEnvOf(keyring), row.legalEntityId!, account.id, {
          accountHolderName: next.accountHolder ?? null,
          iban: next.iban ?? null,
          bic: next.bic ?? null,
          bankName: next.bankName ?? null,
          accountType: next.accountType ?? null,
          routingNumber: next.routingNumber ?? null,
          accountNumber: next.accountNumber ?? null,
          achSettings: Object.keys(ach).length ? ach : null,
        }),
      );
    } else {
      await db
        .update(t)
        .set({ bankEncrypted: await encryptField(JSON.stringify(next), keyring), updatedAt: new Date() })
        .where(eq(t.id, id));
    }
  }
  return { employer: await getEmployer(db, id, keyring), changedFields };
}

/** Soft delete; refused while the employer has pay runs or employees on its payroll. */
export async function deleteEmployer(db: Database, id: string): Promise<void> {
  await requireEmployerRow(db, id);
  const [runs] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.hrPayRuns)
    .where(eq(schema.hrPayRuns.employerId, id));
  if (Number(runs?.count ?? 0) > 0) {
    throw new HrConflictError('This employer has pay runs and cannot be deleted. Deactivate it instead.');
  }
  const [profiles] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.hrPayrollProfiles)
    .where(and(eq(schema.hrPayrollProfiles.employerId, id), sql`${schema.hrPayrollProfiles.status} <> 'ended'`));
  if (Number(profiles?.count ?? 0) > 0) {
    throw new HrConflictError('Employees are still on this employer\'s payroll. Move or end them first.');
  }
  const now = new Date();
  await db.update(t).set({ deletedAt: now, updatedAt: now, isActive: false }).where(eq(t.id, id));
  await db
    .update(schema.hrPaySchedules)
    .set({ deletedAt: now, updatedAt: now, isActive: false })
    .where(and(eq(schema.hrPaySchedules.employerId, id), isNull(schema.hrPaySchedules.deletedAt)));
}

