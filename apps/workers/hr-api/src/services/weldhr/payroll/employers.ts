/**
 * Payroll employers: the legal employer a pay run and its filings are under.
 *
 * The salary account (IBAN, or routing + account number) is an AES-GCM blob
 * (`bank_encrypted`) encrypted with the same keyring as the employee sensitive
 * block, and only ever returned masked.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
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
import { HrConflictError, HrNotFoundError, HrValidationError } from '../shared';
import { sortIssues, yearOfDate, type EmployerRow } from './common';
import { todayIso } from './dates';
import { isValidIban, isValidRoutingNumber, maskAccountNumber, maskIban, normalizeBic, normalizeIban } from './validators';

const t = schema.hrPayrollEmployers;

export async function requireEmployerRow(db: Database, id: string): Promise<EmployerRow> {
  const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
  if (!row) throw new HrNotFoundError('Payroll employer', id);
  return row;
}

export async function readEmployerBank(row: Pick<EmployerRow, 'bankEncrypted'>, keyring: EncryptionKeyring): Promise<HrPayrollEmployerBank | null> {
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
  rows: EmployerRow[],
  keyring: EncryptionKeyring,
  today: string = todayIso(),
): Promise<EmployerDto[]> {
  if (rows.length === 0) return [];
  const [names, profiles] = await Promise.all([
    entityNames(db, rows.map((r) => r.accountingEntityId)),
    profilesByEmployer(db, rows.map((r) => r.id)),
  ]);
  const year = yearOfDate(today);
  const out: EmployerDto[] = [];
  for (const row of rows) {
    const bank = await readEmployerBank(row, keyring);
    const active = profiles.get(row.id) ?? [];
    out.push({
      id: row.id,
      name: row.name,
      legalName: row.legalName,
      country: row.country as 'NL' | 'US',
      currency: row.currency,
      accountingEntityId: row.accountingEntityId,
      accountingEntityName: row.accountingEntityId ? names.get(row.accountingEntityId) ?? null : null,
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

export async function listEmployers(db: Database, keyring: EncryptionKeyring): Promise<EmployerDto[]> {
  const rows = await db.select().from(t).where(isNull(t.deletedAt)).orderBy(t.name);
  return toEmployerDtos(db, rows, keyring);
}

export async function getEmployer(db: Database, id: string, keyring: EncryptionKeyring): Promise<EmployerDto> {
  const row = await requireEmployerRow(db, id);
  return (await toEmployerDtos(db, [row], keyring))[0]!;
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
  if (input.accountingEntityId) await assertAccountingEntity(db, input.accountingEntityId, row.country);
  await db
    .update(t)
    .set({
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.legalName !== undefined && { legalName: input.legalName.trim() }),
      ...(input.accountingEntityId !== undefined && { accountingEntityId: input.accountingEntityId }),
      ...(input.address !== undefined && { address: { ...row.address, ...input.address } }),
      ...(input.nlSettings !== undefined && row.country === 'NL' && { nlSettings: mergeSettings(row.nlSettings, input.nlSettings, ['years']) }),
      ...(input.usSettings !== undefined && row.country === 'US' && { usSettings: mergeSettings(row.usSettings, input.usSettings, ['states']) }),
      ...(input.requireSeparateApprover !== undefined && { requireSeparateApprover: input.requireSeparateApprover }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      updatedAt: new Date(),
    })
    .where(eq(t.id, id));
  return getEmployer(db, id, keyring);
}

/**
 * Store the salary account. Fields not mentioned are kept, `null` clears one.
 * Returns which fields changed (names only: the caller audits them).
 */
export async function setEmployerBank(
  db: Database,
  id: string,
  input: HrPayrollEmployerBankInput,
  keyring: EncryptionKeyring,
): Promise<{ employer: EmployerDto; changedFields: string[] }> {
  const row = await requireEmployerRow(db, id);
  if (!keyring.v1 && !keyring.v2) throw new HrValidationError('Bank details cannot be stored: the worker has no encryption key');
  const current = (await readEmployerBank(row, keyring)) ?? {};
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
    await db
      .update(t)
      .set({ bankEncrypted: await encryptField(JSON.stringify(next), keyring), updatedAt: new Date() })
      .where(eq(t.id, id));
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

