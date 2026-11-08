/**
 * Legal entities, release 1: the part of the backfill SQL cannot do
 * (docs/plans/legal-entities.md, "Release 1 (expand)"). The SQL migration
 * (tenant 0249) has already copied everything deterministic; this works on
 * one tenant database at a time and needs the field-encryption keyring.
 *
 *  1. Employer bank accounts: decrypt `hr_payroll_employers.bank_encrypted`,
 *     match a core `bank_accounts` row on the employer's legal entity (IBAN,
 *     or routing number + decrypted account number), create one when nothing
 *     matches, move `nachaCompanyId` into `ach_settings.companyIdentification`, and set
 *     `bank_account_id`.
 *  2. `entities.bank_details` becomes a core bank account (matched the same
 *     way) and `accounting_entity_settings.invoice_bank_account_id` points at it.
 *  3. `workspace_settings` is merged into the default legal entity: entity
 *     values win, empty entity fields are filled, differences are reported.
 *     Grouped values (the address, the contact person) are only completed
 *     when every part both sides have agrees, so two different addresses are
 *     never mixed. With no entity at all the default is created from the
 *     workspace settings, when the country normalises to ISO-2 and the
 *     currency is a three-letter code.
 *  4. `hr_employees.legal_entity_id` still empty: the payroll employer's
 *     entity (as the SQL does, for employees added since), else the default.
 *  5. Report: ambiguous `tax_identifiers.einOrSsn` values, bank blobs that do
 *     not decrypt or cannot be used, conflicts.
 *
 * Plan, then apply: every step reads and decides in memory (`planWorkspace`),
 * so a dry-run reports exactly what an execute would write and runs in a
 * read-only transaction. An execute applies the plan in one transaction per
 * workspace; every write is conditional on what was read (still empty, still
 * unlinked, same `updated_at`), and a write that finds the row changed rolls
 * the workspace back (`ConcurrentChangeError`) so it can simply be re-run.
 *
 * Idempotent: rows created here get ids derived from their source row, an
 * employer that already has `bank_account_id` or an entity whose invoice
 * account is set is skipped, and filling never overwrites a value. A second
 * run plans no changes.
 *
 * Never puts plaintext account numbers or tax ids in the report: they are
 * masked to the last four characters.
 */

import { createHash } from 'node:crypto';
import { and, asc, desc, eq, getTableColumns, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '@weldsuite/db/schema';
import type { HrPayrollEmployerBank, LegalEntityAddress, LegalEntityContact } from '@weldsuite/db/schema';
import { decryptField, encryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import {
  normalizeRegistrationNumber,
  registrationNumberError,
  type LegalEntityRegistrationType,
} from '@weldsuite/app-api-client/schemas/legal-entities';

/** A tenant database: postgres-js in the CLI, pglite in the tests, or a transaction of either. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

type EntityRow = typeof schema.legalEntities.$inferSelect;
type NewEntityRow = typeof schema.legalEntities.$inferInsert;
type BankAccountRow = typeof schema.bankAccounts.$inferSelect;
type NewBankAccountRow = typeof schema.bankAccounts.$inferInsert;
type RegistrationRow = typeof schema.legalEntityRegistrations.$inferSelect;
type NewRegistrationRow = typeof schema.legalEntityRegistrations.$inferInsert;
type WorkspaceSettingsRow = typeof schema.workspaceSettings.$inferSelect;

const EMPLOYEE_UPDATE_CHUNK = 500;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface BackfillCounts {
  /** Employer bank blobs matched to an existing core account. */
  employerBanksMatched: number;
  /** Core accounts created from employer bank blobs. */
  employerBanksCreated: number;
  /** Employers whose `bank_account_id` was set. */
  employersLinked: number;
  /** `nachaCompanyId` values moved into `ach_settings.companyIdentification`. */
  nachaCompanyIdsMoved: number;
  /** `entities.bank_details` matched to an existing core account. */
  invoiceAccountsMatched: number;
  /** Core accounts created from `entities.bank_details`. */
  invoiceAccountsCreated: number;
  /** `accounting_entity_settings.invoice_bank_account_id` values set. */
  invoiceAccountsSet: number;
  /** Fields of the default entity filled from `workspace_settings`. */
  entityFieldsFilled: number;
  /** Registrations created (VAT, company registration). */
  registrationsCreated: number;
  /** Default entities created from `workspace_settings` (0 or 1). */
  defaultEntitiesCreated: number;
  /** Employees given their payroll employer's entity. */
  employeesFromPayroll: number;
  /** Employees given the default entity. */
  employeesFromDefault: number;
}

export interface ReportItem {
  /** What it is about: `employer emp_1`, `entity ent_1`, `bank account ba_1`, `workspace settings`. */
  subject: string;
  message: string;
}

export interface FieldDifference {
  entityId: string;
  /** `legalName`, `contact.email`, `address.city`, `registrations.vat`, ... */
  field: string;
  /** The value kept. */
  entityValue: string;
  /** The value in `workspace_settings` that was not copied. */
  workspaceValue: string;
}

export interface FilledField {
  entityId: string;
  field: string;
  value: string;
}

export interface CreatedBankAccount {
  accountId: string;
  entityId: string;
  /** `employer` (salary account) or `entity_bank_details` (invoice account). */
  source: 'employer' | 'entity_bank_details';
  sourceId: string;
  /** Masked IBAN or account number. */
  account: string;
}

export interface WorkspaceBackfillReport {
  mode: 'dry-run' | 'execute';
  /** `skipped` when the tenant does not have the release 1 schema yet. */
  status: 'ok' | 'skipped';
  skippedReason?: string;
  /** Writes applied (execute) or planned (dry-run). Zero means the workspace is done. */
  changes: number;
  counts: BackfillCounts;
  createdBankAccounts: CreatedBankAccount[];
  filledFields: FilledField[];
  differences: FieldDifference[];
  /** Values that disagree and were left alone, or rows in an unexpected state. */
  conflicts: ReportItem[];
  /** Bank blobs or accounts that could not be decrypted or used. */
  bankIssues: ReportItem[];
  /** `tax_identifiers.einOrSsn` values the SQL did not migrate. */
  taxIdsToReview: ReportItem[];
  /** Everything else worth knowing (e.g. why the default entity was not created). */
  notes: ReportItem[];
}

function emptyCounts(): BackfillCounts {
  return {
    employerBanksMatched: 0,
    employerBanksCreated: 0,
    employersLinked: 0,
    nachaCompanyIdsMoved: 0,
    invoiceAccountsMatched: 0,
    invoiceAccountsCreated: 0,
    invoiceAccountsSet: 0,
    entityFieldsFilled: 0,
    registrationsCreated: 0,
    defaultEntitiesCreated: 0,
    employeesFromPayroll: 0,
    employeesFromDefault: 0,
  };
}

function emptyReport(mode: WorkspaceBackfillReport['mode']): WorkspaceBackfillReport {
  return {
    mode,
    status: 'ok',
    changes: 0,
    counts: emptyCounts(),
    createdBankAccounts: [],
    filledFields: [],
    differences: [],
    conflicts: [],
    bankIssues: [],
    taxIdsToReview: [],
    notes: [],
  };
}

/** A write found its row changed since it was read; the workspace was rolled back and can be re-run. */
export class ConcurrentChangeError extends Error {
  constructor(what: string) {
    super(`${what} changed while the backfill ran; nothing was written for this workspace, run it again`);
    this.name = 'ConcurrentChangeError';
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** `prefix_` + 24 hex characters derived from `seed`, like the ids the 0249 SQL derives. */
export function derivedId(prefix: string, seed: string): string {
  return `${prefix}_${createHash('md5').update(seed).digest('hex').slice(0, 24)}`;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function comparable(value: string): string {
  return value.trim().replaceAll(/\s+/g, ' ').toLowerCase();
}

function sameText(a: string, b: string): boolean {
  return comparable(a) === comparable(b);
}

/** `*****6789`: never more than the last four characters of a sensitive value. */
export function maskTail(value: string): string {
  if (value.length <= 4) return '****';
  return `${'*'.repeat(Math.min(value.length - 4, 5))}${value.slice(-4)}`;
}

function maskIban(iban: string): string {
  return iban.length <= 8 ? maskTail(iban) : `${iban.slice(0, 4)}****${iban.slice(-4)}`;
}

function describeAccount(facts: { iban: string | null; accountNumber: string | null; routingNumber: string | null }): string {
  if (facts.iban) return `IBAN ${maskIban(facts.iban)}`;
  if (facts.accountNumber) {
    return facts.routingNumber
      ? `routing ${facts.routingNumber}, account ${maskTail(facts.accountNumber)}`
      : `account ${maskTail(facts.accountNumber)}`;
  }
  return 'no account number';
}

/** The reason a value did not decrypt, without the value. */
function decryptFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('decryptField:')) return message.slice('decryptField:'.length).trim();
  return 'authentication failed (wrong key or damaged value)';
}

// ---------------------------------------------------------------------------
// Countries, currencies, locales
// ---------------------------------------------------------------------------

/**
 * Names and codes people type in Settings → Business (free text, up to 100
 * characters), in English, Dutch, German and French, to ISO-2. Deliberately
 * short: an unrecognised country leaves the default entity to the next save
 * of the Business page, which asks for a country code.
 */
const COUNTRY_NAMES: Record<string, string[]> = {
  NL: ['netherlands', 'the netherlands', 'nederland', 'holland', 'pays-bas', 'pays bas', 'niederlande', 'nld'],
  BE: ['belgium', 'belgie', 'belgique', 'belgien', 'bel'],
  DE: ['germany', 'duitsland', 'deutschland', 'allemagne', 'deu'],
  FR: ['france', 'frankrijk', 'frankreich', 'fra'],
  LU: ['luxembourg', 'luxemburg', 'lux'],
  GB: [
    'united kingdom', 'uk', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland',
    'verenigd koninkrijk', 'groot-brittannie', 'groot brittannie', 'engeland', 'royaume-uni', 'gbr',
  ],
  IE: ['ireland', 'ierland', 'irland', 'irl'],
  US: [
    'united states', 'united states of america', 'usa', 'america', 'verenigde staten',
    'verenigde staten van amerika', 'vereinigte staaten', 'etats-unis',
  ],
  CA: ['canada', 'can'],
  IN: ['india', 'ind'],
  BR: ['brazil', 'brasil', 'brazilie', 'bra'],
  ES: ['spain', 'spanje', 'espana', 'spanien', 'espagne', 'esp'],
  IT: ['italy', 'italie', 'italia', 'italien', 'ita'],
  PT: ['portugal', 'prt'],
  AT: ['austria', 'oostenrijk', 'osterreich', 'autriche', 'aut'],
  CH: ['switzerland', 'zwitserland', 'schweiz', 'suisse', 'che'],
  DK: ['denmark', 'denemarken', 'danmark', 'danemark', 'dnk'],
  SE: ['sweden', 'zweden', 'sverige', 'schweden', 'suede', 'swe'],
  NO: ['norway', 'noorwegen', 'norge', 'norwegen', 'norvege', 'nor'],
  FI: ['finland', 'suomi', 'finnland', 'fin'],
  PL: ['poland', 'polen', 'polska', 'pologne', 'pol'],
  CZ: ['czech republic', 'czechia', 'tsjechie', 'tschechien', 'cze'],
  GR: ['greece', 'griekenland', 'griechenland', 'grece', 'grc'],
  AU: ['australia', 'australie', 'australien', 'aus'],
  NZ: ['new zealand', 'nieuw-zeeland', 'nieuw zeeland', 'nzl'],
  ZA: ['south africa', 'zuid-afrika', 'zuid afrika', 'zaf'],
  SG: ['singapore', 'singapur', 'sgp'],
  AE: ['united arab emirates', 'uae', 'verenigde arabische emiraten', 'are'],
  MX: ['mexico', 'mex'],
  JP: ['japan', 'jpn'],
  CW: ['curacao', 'cuw'],
  SR: ['suriname', 'sur'],
  AW: ['aruba', 'abw'],
};

const COUNTRY_LOOKUP: ReadonlyMap<string, string> = new Map(
  Object.entries(COUNTRY_NAMES).flatMap(([code, names]) => [
    [code.toLowerCase(), code] as const,
    ...names.map((name) => [name, code] as const),
  ]),
);

/** ISO-2 code of a country as typed in workspace settings, or null when it is not recognised. */
export function normalizeCountry(raw: string | null | undefined): string | null {
  const key = (raw ?? '')
    .normalize('NFD')
    .replaceAll(/\p{M}/gu, '')
    .replaceAll('.', '')
    .trim()
    .replaceAll(/\s+/g, ' ')
    .toLowerCase()
    .replace(/^the /, '');
  if (!key) return null;
  return COUNTRY_LOOKUP.get(key) ?? null;
}

/** Three-letter currency code, or null. */
export function normalizeCurrency(raw: string | null | undefined): string | null {
  const value = text(raw).toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value : null;
}

/** Same defaults as `createLegalEntity` in `@weldsuite/core-domain/legal-entities`. */
function defaultLocale(country: string): string {
  switch (country) {
    case 'NL': return 'nl-NL';
    case 'BE': return 'nl-BE';
    case 'DE': return 'de-DE';
    case 'FR': return 'fr-FR';
    case 'US': return 'en-US';
    case 'GB': return 'en-GB';
    case 'IN': return 'en-IN';
    case 'BR': return 'pt-BR';
    default: return 'en-GB';
  }
}

// ---------------------------------------------------------------------------
// Bank facts
// ---------------------------------------------------------------------------

/** A bank account as both the employer blob and `entities.bank_details` describe one, normalised. */
interface BankFacts {
  iban: string | null;
  bic: string | null;
  routingNumber: string | null;
  accountNumber: string | null;
  accountHolder: string | null;
  bankName: string | null;
  accountType: 'checking' | 'savings' | null;
  nachaCompanyId: string | null;
}

function normalizeIban(value: unknown): string | null {
  const iban = text(value).replaceAll(/\s/g, '').toUpperCase();
  return iban || null;
}

function normalizeAccountNumber(value: unknown): string | null {
  const number = text(value).replaceAll(/[\s-]/g, '').toUpperCase();
  return number || null;
}

function normalizeRouting(value: unknown): string | null {
  const routing = text(value).replaceAll(/[\s-]/g, '');
  return routing || null;
}

function bankFacts(source: HrPayrollEmployerBank | NonNullable<EntityRow['bankDetails']>): BankFacts {
  const blob = source as HrPayrollEmployerBank;
  const accountType = text(blob.accountType);
  return {
    iban: normalizeIban(blob.iban),
    bic: text(blob.bic).toUpperCase() || null,
    routingNumber: normalizeRouting(blob.routingNumber),
    accountNumber: normalizeAccountNumber(blob.accountNumber),
    accountHolder: text(blob.accountHolder).slice(0, 255) || null,
    bankName: text(blob.bankName).slice(0, 255) || null,
    accountType: accountType === 'checking' || accountType === 'savings' ? accountType : null,
    nachaCompanyId: text(blob.nachaCompanyId) || null,
  };
}

/** Why these facts cannot become a `bank_accounts` row, or null when they can. */
function unusableBank(facts: BankFacts): string | null {
  if (!facts.iban && !facts.accountNumber) return 'has no IBAN and no account number';
  if (facts.iban && facts.iban.length > 34) return 'has an IBAN longer than 34 characters';
  if (facts.routingNumber && facts.routingNumber.length > 9) return 'has a routing number longer than 9 characters';
  return null;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type Op =
  | { kind: 'insert_bank_account'; row: Omit<NewBankAccountRow, 'accountNumberEncrypted'>; accountNumber: string | null }
  | { kind: 'set_ach_company_id'; accountId: string; achSettings: Record<string, unknown> }
  | { kind: 'link_employer_bank'; employerId: string; bankAccountId: string }
  | { kind: 'set_invoice_account'; entityId: string; bankAccountId: string }
  | { kind: 'insert_entity'; row: NewEntityRow }
  | { kind: 'update_entity'; entityId: string; stamp: string; patch: Partial<NewEntityRow> }
  | { kind: 'insert_registration'; row: NewRegistrationRow }
  | { kind: 'employees_from_payroll'; entityId: string; employeeIds: string[] }
  | { kind: 'employees_from_default'; entityId: string; expected: number };

function opWeight(op: Op): number {
  if (op.kind === 'employees_from_payroll') return op.employeeIds.length;
  if (op.kind === 'employees_from_default') return op.expected;
  return 1;
}

/** What matching and the NACHA move need of a core account. */
type AccountFacts = Pick<
  BankAccountRow,
  'id' | 'entityId' | 'iban' | 'routingNumber' | 'accountNumberEncrypted' | 'achSettings' | 'isActive' | 'isDefault'
>;

interface AccountState {
  row: AccountFacts;
  /** Decrypted account number: undefined until needed, null when there is none or it does not decrypt. */
  accountNumber?: string | null;
}

interface PlanContext {
  db: Database;
  keyring: EncryptionKeyring;
  report: WorkspaceBackfillReport;
  ops: Op[];
  entities: Map<string, EntityRow>;
  /** `updated_at::text` per entity, for the compare-and-swap update. */
  entityStamps: Map<string, string>;
  /** Live core accounts per entity, active and default first. */
  accounts: Map<string, AccountState[]>;
  /** Every `bank_accounts.id`, deleted ones included, so a derived id is never reused. */
  accountIds: Set<string>;
  /** Live registrations per entity. */
  registrations: Map<string, RegistrationRow[]>;
  registrationIds: Set<string>;
  /** Entities WeldBooks is enabled for, with their invoice account. */
  booksSettings: Map<string, string | null>;
}

function liveEntity(ctx: PlanContext, id: string | null | undefined): EntityRow | null {
  if (!id) return null;
  const entity = ctx.entities.get(id);
  return entity && !entity.deletedAt ? entity : null;
}

async function accountNumberOf(ctx: PlanContext, account: AccountState): Promise<string | null> {
  if (account.accountNumber !== undefined) return account.accountNumber;
  if (!account.row.accountNumberEncrypted) {
    account.accountNumber = null;
    return null;
  }
  try {
    account.accountNumber = normalizeAccountNumber(await decryptField(account.row.accountNumberEncrypted, ctx.keyring));
  } catch (err) {
    account.accountNumber = null;
    ctx.report.bankIssues.push({
      subject: `bank account ${account.row.id}`,
      message: `account number does not decrypt (${decryptFailure(err)}); not used for matching`,
    });
  }
  return account.accountNumber;
}

/** The entity's core account with the same IBAN, or the same routing number and account number. */
async function findAccount(ctx: PlanContext, entityId: string, facts: BankFacts): Promise<AccountState | null> {
  const accounts = ctx.accounts.get(entityId) ?? [];
  if (facts.iban) {
    const byIban = accounts.find((a) => normalizeIban(a.row.iban) === facts.iban);
    if (byIban) return byIban;
  }
  if (facts.routingNumber && facts.accountNumber) {
    for (const account of accounts) {
      if (normalizeRouting(account.row.routingNumber) !== facts.routingNumber) continue;
      if ((await accountNumberOf(ctx, account)) === facts.accountNumber) return account;
    }
  }
  return null;
}

/**
 * Plan a new core account. Null (with a conflict) when its derived id is
 * already taken, which only happens when someone deleted the account this
 * backfill created before: it is not recreated.
 */
function planAccount(
  ctx: PlanContext,
  entity: EntityRow,
  facts: BankFacts,
  args: { id: string; name: string; achSettings: Record<string, unknown> | null; subject: string },
): AccountState | null {
  if (ctx.accountIds.has(args.id)) {
    ctx.report.conflicts.push({
      subject: args.subject,
      message: `the bank account this backfill created before (${args.id}) was deleted; not created again`,
    });
    return null;
  }
  const bic = facts.bic && facts.bic.length <= 11 ? facts.bic : null;
  if (facts.bic && !bic) {
    ctx.report.notes.push({ subject: args.subject, message: 'BIC longer than 11 characters left out' });
  }
  const row: AccountFacts = {
    id: args.id,
    entityId: entity.id,
    iban: facts.iban,
    routingNumber: facts.routingNumber,
    accountNumberEncrypted: null,
    achSettings: args.achSettings,
    isActive: true,
    isDefault: false,
  };
  ctx.ops.push({
    kind: 'insert_bank_account',
    row: {
      id: row.id,
      entityId: row.entityId,
      name: args.name.slice(0, 255),
      iban: facts.iban,
      bic,
      bankName: facts.bankName,
      accountHolderName: facts.accountHolder ?? entity.legalName ?? entity.name,
      currency: entity.baseCurrency,
      accountType: facts.accountType,
      routingNumber: facts.routingNumber,
      accountNumberLast4: facts.accountNumber ? facts.accountNumber.slice(-4) : null,
      achSettings: args.achSettings,
      isDefault: false,
      isActive: true,
    },
    accountNumber: facts.accountNumber,
  });
  const state: AccountState = { row, accountNumber: facts.accountNumber };
  ctx.accountIds.add(row.id);
  ctx.accounts.set(entity.id, [...(ctx.accounts.get(entity.id) ?? []), state]);
  return state;
}

/** Move the employer's NACHA company id into the account's `ach_settings.companyIdentification` when that is empty. */
function planNachaMove(ctx: PlanContext, account: AccountState, nachaCompanyId: string, employerId: string): void {
  const ach = account.row.achSettings ?? {};
  const current = text(ach.companyIdentification);
  if (current === nachaCompanyId) return;
  if (current) {
    ctx.report.conflicts.push({
      subject: `employer ${employerId}`,
      message: `NACHA company id ${nachaCompanyId} differs from ${current} on bank account ${account.row.id}; the account's value is kept`,
    });
    return;
  }
  const next = { ...ach, companyIdentification: nachaCompanyId };
  account.row = { ...account.row, achSettings: next };
  ctx.ops.push({ kind: 'set_ach_company_id', accountId: account.row.id, achSettings: next });
  ctx.report.counts.nachaCompanyIdsMoved += 1;
}

async function readEmployerBlob(ctx: PlanContext, employerId: string, blob: string): Promise<HrPayrollEmployerBank | null> {
  const subject = `employer ${employerId}`;
  let plaintext: string;
  try {
    plaintext = await decryptField(blob, ctx.keyring);
  } catch (err) {
    ctx.report.bankIssues.push({ subject, message: `bank_encrypted does not decrypt (${decryptFailure(err)})` });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    ctx.report.bankIssues.push({ subject, message: 'bank_encrypted decrypts, but not to JSON' });
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    ctx.report.bankIssues.push({ subject, message: 'bank_encrypted decrypts, but not to an object' });
    return null;
  }
  return parsed as HrPayrollEmployerBank;
}

/** Step 1: employer bank blobs → core bank accounts. */
async function planEmployerBanks(ctx: PlanContext): Promise<void> {
  const employers = await ctx.db
    .select()
    .from(schema.hrPayrollEmployers)
    .where(isNull(schema.hrPayrollEmployers.deletedAt))
    .orderBy(asc(schema.hrPayrollEmployers.createdAt), asc(schema.hrPayrollEmployers.id));

  for (const employer of employers) {
    if (employer.bankAccountId || !employer.bankEncrypted) continue;
    const subject = `employer ${employer.id}`;
    const entity = liveEntity(ctx, employer.legalEntityId);
    if (!entity) {
      ctx.report.conflicts.push({
        subject,
        message: employer.legalEntityId
          ? `legal entity ${employer.legalEntityId} is deleted or missing; bank account not moved`
          : 'has no legal entity (did migration 0249 run?); bank account not moved',
      });
      continue;
    }
    const blob = await readEmployerBlob(ctx, employer.id, employer.bankEncrypted);
    if (!blob) continue;
    const facts = bankFacts(blob);
    const unusable = unusableBank(facts);
    if (unusable) {
      ctx.report.bankIssues.push({
        subject,
        message: `bank_encrypted ${unusable}; not moved${facts.nachaCompanyId ? ' (its NACHA company id stays there too)' : ''}`,
      });
      continue;
    }

    let account = await findAccount(ctx, entity.id, facts);
    if (account) {
      ctx.report.counts.employerBanksMatched += 1;
    } else {
      account = planAccount(ctx, entity, facts, {
        id: derivedId('ba', `hr_employer_bank:${employer.id}`),
        name: `Salary account (${employer.label ?? employer.name})`,
        achSettings: facts.nachaCompanyId ? { companyIdentification: facts.nachaCompanyId } : null,
        subject,
      });
      if (!account) continue;
      ctx.report.counts.employerBanksCreated += 1;
      if (facts.nachaCompanyId) ctx.report.counts.nachaCompanyIdsMoved += 1;
      ctx.report.createdBankAccounts.push({
        accountId: account.row.id,
        entityId: entity.id,
        source: 'employer',
        sourceId: employer.id,
        account: describeAccount(facts),
      });
    }
    if (facts.nachaCompanyId) planNachaMove(ctx, account, facts.nachaCompanyId, employer.id);
    ctx.ops.push({ kind: 'link_employer_bank', employerId: employer.id, bankAccountId: account.row.id });
    ctx.report.counts.employersLinked += 1;
  }
}

/** Step 2: `entities.bank_details` → a core account, printed on invoices. */
async function planInvoiceAccounts(ctx: PlanContext): Promise<void> {
  const entities = [...ctx.entities.values()]
    .filter((e) => !e.deletedAt && e.bankDetails)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const entity of entities) {
    const subject = `entity ${entity.id}`;
    const booksEnabled = ctx.booksSettings.has(entity.id);
    if (booksEnabled && ctx.booksSettings.get(entity.id)) continue;
    const facts = bankFacts(entity.bankDetails ?? {});
    if (!facts.iban && !facts.accountNumber) {
      if (facts.bic || facts.bankName || facts.routingNumber) {
        ctx.report.notes.push({ subject, message: 'bank_details has no IBAN and no account number; nothing to move' });
      }
      continue;
    }
    const unusable = unusableBank(facts);
    if (unusable) {
      ctx.report.bankIssues.push({ subject, message: `bank_details ${unusable}; not moved` });
      continue;
    }

    let account = await findAccount(ctx, entity.id, facts);
    if (account) {
      ctx.report.counts.invoiceAccountsMatched += 1;
    } else {
      account = planAccount(ctx, entity, facts, {
        id: derivedId('ba', `entity_bank_details:${entity.id}`),
        name: 'Invoice account',
        achSettings: null,
        subject,
      });
      if (!account) continue;
      ctx.report.counts.invoiceAccountsCreated += 1;
      ctx.report.createdBankAccounts.push({
        accountId: account.row.id,
        entityId: entity.id,
        source: 'entity_bank_details',
        sourceId: entity.id,
        account: describeAccount(facts),
      });
    }
    if (!booksEnabled) {
      ctx.report.conflicts.push({
        subject,
        message: `WeldBooks is not enabled for this entity; bank account ${account.row.id} is not set as its invoice account`,
      });
      continue;
    }
    ctx.booksSettings.set(entity.id, account.row.id);
    ctx.ops.push({ kind: 'set_invoice_account', entityId: entity.id, bankAccountId: account.row.id });
    ctx.report.counts.invoiceAccountsSet += 1;
  }
}

// ---------------------------------------------------------------------------
// Step 3: workspace settings → default entity
// ---------------------------------------------------------------------------

type Pairs<K extends string> = Record<K, { entity: string; workspace: string }>;

/**
 * Parts of one value (an address, a person): fill the parts the entity lacks,
 * but only when every part both sides have agrees. Otherwise nothing is
 * filled and the disagreeing parts are reported.
 */
function mergeGroup<K extends string>(
  pairs: Pairs<K>,
  same: (key: K, a: string, b: string) => boolean,
): { fill: Partial<Record<K, string>>; differ: K[] } {
  const keys = Object.keys(pairs) as K[];
  const differ = keys.filter((k) => pairs[k].entity && pairs[k].workspace && !same(k, pairs[k].entity, pairs[k].workspace));
  if (differ.length > 0) return { fill: {}, differ };
  const fill: Partial<Record<K, string>> = {};
  for (const k of keys) if (!pairs[k].entity && pairs[k].workspace) fill[k] = pairs[k].workspace;
  return { fill, differ: [] };
}

type AddressKey = 'line1' | 'line2' | 'city' | 'state' | 'postalCode' | 'country';

/** The workspace address, with the country as ISO-2 (left out when it is not recognised). */
function workspaceAddress(ws: WorkspaceSettingsRow): Record<AddressKey, string> {
  return {
    line1: text(ws.addressLine1),
    line2: text(ws.addressLine2),
    city: text(ws.city),
    state: text(ws.state),
    postalCode: text(ws.postalCode),
    country: normalizeCountry(ws.country) ?? '',
  };
}

/** The entity address read the way the shared and the legacy (street + houseNumber, province) shapes allow. */
function entityAddressView(address: LegalEntityAddress | null): Record<AddressKey, string> {
  const a = address ?? {};
  const street = [text(a.street), text(a.houseNumber), text(a.houseNumberAddition)].filter(Boolean).join(' ');
  return {
    line1: text(a.line1) || street,
    line2: text(a.line2),
    city: text(a.city),
    state: text(a.state) || text(a.province),
    postalCode: text(a.postalCode),
    country: text(a.country).toUpperCase(),
  };
}

function sameAddressPart(key: AddressKey, a: string, b: string): boolean {
  if (key === 'postalCode') return a.replaceAll(/\s/g, '').toUpperCase() === b.replaceAll(/\s/g, '').toUpperCase();
  return sameText(a, b);
}

/** The object without empty values, or null when nothing is left. */
function compactObject<T extends object>(value: T): T | null {
  const entries = Object.entries(value).filter(
    ([, v]) => v !== undefined && v !== null && v !== '' && !(typeof v === 'object' && Object.keys(v as object).length === 0),
  );
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : null;
}

function vatType(country: string): LegalEntityRegistrationType {
  return country.toUpperCase().startsWith('IN') ? 'gstin' : 'vat';
}

/** VAT and company registration number from workspace settings, as registrations of the entity when it has none of that type. */
function planRegistrations(ctx: PlanContext, entity: { id: string; jurisdictionCode: string }, ws: WorkspaceSettingsRow): void {
  const candidates: Array<{ type: LegalEntityRegistrationType; raw: string; seed: string }> = [
    { type: vatType(entity.jurisdictionCode), raw: text(ws.vatNumber), seed: 'vat' },
    { type: 'company_registration', raw: text(ws.registrationNumber), seed: 'company_registration' },
  ];
  const live = ctx.registrations.get(entity.id) ?? [];
  for (const { type, raw, seed } of candidates) {
    if (!raw) continue;
    const number = normalizeRegistrationNumber(type, raw).slice(0, 64);
    const existing = live.filter((r) => r.type === type);
    if (existing.length > 0) {
      if (!existing.some((r) => normalizeRegistrationNumber(type, r.number) === number)) {
        const kept = existing.find((r) => r.isPrimary) ?? existing[0];
        ctx.report.differences.push({ entityId: entity.id, field: `registrations.${type}`, entityValue: kept.number, workspaceValue: raw });
      }
      continue;
    }
    const id = derivedId('ler', `workspace_settings:${seed}:${entity.id}`);
    if (ctx.registrationIds.has(id)) {
      ctx.report.conflicts.push({
        subject: `entity ${entity.id}`,
        message: `the ${type} registration this backfill created before was deleted; not created again`,
      });
      continue;
    }
    const formatError = registrationNumberError(type, number);
    if (formatError) {
      ctx.report.notes.push({ subject: `entity ${entity.id}`, message: `${type} ${number} copied as it is, but: ${formatError}` });
    }
    const country = entity.jurisdictionCode.slice(0, 2).toUpperCase();
    ctx.ops.push({
      kind: 'insert_registration',
      row: { id, entityId: entity.id, type, country, number, isPrimary: true },
    });
    ctx.registrationIds.add(id);
    ctx.report.counts.registrationsCreated += 1;
  }
}

/** Fill-only merge of workspace settings into the existing default entity. */
function planMergeIntoDefault(ctx: PlanContext, entity: EntityRow, ws: WorkspaceSettingsRow): void {
  const patch: Partial<NewEntityRow> = {};
  const filled = (field: string, value: string): void => {
    ctx.report.filledFields.push({ entityId: entity.id, field, value });
  };
  const differs = (field: string, entityValue: string, workspaceValue: string): void => {
    ctx.report.differences.push({ entityId: entity.id, field, entityValue, workspaceValue });
  };
  const scalar = (field: string, current: string, incoming: string, set: (v: string) => void): void => {
    if (!incoming) return;
    if (!current) {
      set(incoming);
      filled(field, incoming);
    } else if (!sameText(current, incoming)) {
      differs(field, current, incoming);
    }
  };

  scalar('legalName', text(entity.legalName), text(ws.legalName), (v) => { patch.legalName = v.slice(0, 255); });
  scalar('dba', text(entity.dba), text(ws.tradingName), (v) => { patch.dba = v.slice(0, 255); });

  // Contact: email, phone and website one by one; the contact person as one value.
  const contact: LegalEntityContact = { ...(entity.contact ?? {}) };
  let contactChanged = false;
  scalar('contact.email', text(contact.email), text(ws.email), (v) => { contact.email = v; contactChanged = true; });
  scalar('contact.phone', text(contact.phone), text(ws.phone), (v) => { contact.phone = v; contactChanged = true; });
  scalar('contact.website', text(contact.website), text(ws.websiteUrl), (v) => { contact.website = v; contactChanged = true; });
  const person = mergeGroup(
    {
      firstName: { entity: text(contact.contactPerson?.firstName), workspace: text(ws.contactFirstName) },
      lastName: { entity: text(contact.contactPerson?.lastName), workspace: text(ws.contactLastName) },
    },
    (_k, a, b) => sameText(a, b),
  );
  for (const k of person.differ) {
    differs(`contact.contactPerson.${k}`, text(contact.contactPerson?.[k]), text(k === 'firstName' ? ws.contactFirstName : ws.contactLastName));
  }
  if (Object.keys(person.fill).length > 0) {
    contact.contactPerson = { ...(contact.contactPerson ?? {}), ...person.fill };
    contactChanged = true;
    for (const [k, v] of Object.entries(person.fill)) filled(`contact.contactPerson.${k}`, v ?? '');
  }
  if (contactChanged) patch.contact = contact;

  // Address: one value; completed only when the parts both sides have agree.
  if (text(ws.country) && !normalizeCountry(ws.country)) {
    ctx.report.notes.push({ subject: 'workspace settings', message: `country "${text(ws.country)}" is not recognised; left out of the address` });
  }
  const wsAddress = workspaceAddress(ws);
  const current = entityAddressView(entity.address);
  const keys = Object.keys(wsAddress) as AddressKey[];
  const address = mergeGroup(
    Object.fromEntries(keys.map((k) => [k, { entity: current[k], workspace: wsAddress[k] }])) as Pairs<AddressKey>,
    sameAddressPart,
  );
  for (const k of address.differ) differs(`address.${k}`, current[k], wsAddress[k]);
  if (Object.keys(address.fill).length > 0) {
    patch.address = { ...(entity.address ?? {}), ...address.fill };
    for (const [k, v] of Object.entries(address.fill)) filled(`address.${k}`, v ?? '');
  }

  // Branding: logo and colors one by one; WeldBooks' document texts stay.
  const branding = { ...(entity.branding ?? {}) };
  let brandingChanged = false;
  scalar('branding.logoUrl', text(branding.logoUrl), text(ws.logoUrl), (v) => { branding.logoUrl = v; brandingChanged = true; });
  scalar('branding.primaryColor', text(branding.primaryColor), text(ws.primaryColor), (v) => { branding.primaryColor = v; brandingChanged = true; });
  scalar('branding.accentColor', text(branding.accentColor), text(ws.accentColor), (v) => { branding.accentColor = v; brandingChanged = true; });
  if (brandingChanged) patch.branding = branding;

  if (Object.keys(patch).length > 0) {
    const stamp = ctx.entityStamps.get(entity.id);
    if (stamp === undefined) throw new Error(`no updated_at read for entity ${entity.id}`);
    ctx.ops.push({ kind: 'update_entity', entityId: entity.id, stamp, patch });
    ctx.report.counts.entityFieldsFilled += ctx.report.filledFields.filter((f) => f.entityId === entity.id).length;
  }

  planRegistrations(ctx, entity, ws);
}

/** No legal entity at all: create the default from workspace settings, when they say enough. Returns its id. */
function planDefaultFromSettings(ctx: PlanContext, ws: WorkspaceSettingsRow): string | null {
  const subject = 'workspace settings';
  const legalName = text(ws.legalName);
  const tradingName = text(ws.tradingName);
  const country = normalizeCountry(ws.country);
  const currency = normalizeCurrency(ws.currency);
  const reasons: string[] = [];
  if (!legalName && !tradingName) reasons.push('there is no legal or trading name');
  if (!country) reasons.push(text(ws.country) ? `country "${text(ws.country)}" is not recognised` : 'there is no country');
  if (!currency) reasons.push(text(ws.currency) ? `currency "${text(ws.currency)}" is not a currency code` : 'there is no currency');
  if (!country || !currency || (!legalName && !tradingName)) {
    ctx.report.notes.push({
      subject,
      message: `no legal entity, and none created: ${reasons.join(', ')}. The Business page creates it on its next save`,
    });
    return null;
  }

  const id = derivedId('ent', `workspace_settings:${ws.id}`);
  if (ctx.entities.has(id)) {
    ctx.report.conflicts.push({
      subject,
      message: `the default legal entity this backfill created before (${id}) was deleted; not created again`,
    });
    return null;
  }
  const address = workspaceAddress(ws);
  const timezone = text(ws.timezone);
  const fallbackTimezone = country === 'NL' ? 'Europe/Amsterdam' : null;
  const row: NewEntityRow = {
    id,
    name: (tradingName || legalName).slice(0, 255),
    legalName: legalName ? legalName.slice(0, 255) : null,
    dba: tradingName ? tradingName.slice(0, 255) : null,
    jurisdictionCode: country,
    baseCurrency: currency,
    locale: defaultLocale(country),
    timezone: timezone && timezone.length <= 50 ? timezone : fallbackTimezone,
    address: compactObject<LegalEntityAddress>({ ...address }),
    contact: compactObject<LegalEntityContact>({
      email: text(ws.email),
      phone: text(ws.phone),
      website: text(ws.websiteUrl),
      contactPerson: compactObject({ firstName: text(ws.contactFirstName), lastName: text(ws.contactLastName) }) ?? undefined,
    }),
    branding: compactObject({ logoUrl: text(ws.logoUrl), primaryColor: text(ws.primaryColor), accentColor: text(ws.accentColor) }),
    isDefault: true,
    isActive: true,
    accessRestricted: false,
  };
  ctx.ops.push({ kind: 'insert_entity', row });
  ctx.report.counts.defaultEntitiesCreated += 1;
  ctx.report.notes.push({ subject: `entity ${id}`, message: `default legal entity created from workspace settings (${country}, ${currency})` });
  planRegistrations(ctx, { id, jurisdictionCode: country }, ws);
  return id;
}

/** Step 3. Returns the default entity id after the merge (an existing one, a created one, or null). */
async function planWorkspaceSettings(ctx: PlanContext): Promise<string | null> {
  const live = [...ctx.entities.values()].filter((e) => !e.deletedAt);
  const defaults = live.filter((e) => e.isDefault);
  const existingDefault = defaults[0] ?? null;

  const [ws] = await ctx.db
    .select()
    .from(schema.workspaceSettings)
    .where(isNull(schema.workspaceSettings.deletedAt))
    .orderBy(desc(schema.workspaceSettings.updatedAt), asc(schema.workspaceSettings.id))
    .limit(1);

  if (!ws) {
    if (!existingDefault) ctx.report.notes.push({ subject: 'workspace settings', message: 'no workspace settings and no legal entity' });
    return existingDefault?.id ?? null;
  }
  if (existingDefault) {
    planMergeIntoDefault(ctx, existingDefault, ws);
    return existingDefault.id;
  }
  if (live.length > 0) {
    ctx.report.conflicts.push({
      subject: 'workspace settings',
      message: `${live.length} legal ${live.length === 1 ? 'entity exists' : 'entities exist'} but none is the default (migration 0249 sets one); not merged`,
    });
    return null;
  }
  return planDefaultFromSettings(ctx, ws);
}

// ---------------------------------------------------------------------------
// Step 4: employees; step 5: tax ids
// ---------------------------------------------------------------------------

async function planEmployees(ctx: PlanContext, defaultEntityId: string | null): Promise<void> {
  const viaPayroll = await ctx.db
    .select({ employeeId: schema.hrEmployees.id, entityId: schema.hrPayrollEmployers.legalEntityId })
    .from(schema.hrEmployees)
    .innerJoin(schema.hrPayrollProfiles, eq(schema.hrPayrollProfiles.employeeId, schema.hrEmployees.id))
    .innerJoin(schema.hrPayrollEmployers, eq(schema.hrPayrollEmployers.id, schema.hrPayrollProfiles.employerId))
    .where(and(isNull(schema.hrEmployees.legalEntityId), isNotNull(schema.hrPayrollEmployers.legalEntityId)))
    .orderBy(asc(schema.hrEmployees.id));

  const byEntity = new Map<string, string[]>();
  for (const { employeeId, entityId } of viaPayroll) {
    if (!entityId || !liveEntity(ctx, entityId)) continue;
    byEntity.set(entityId, [...(byEntity.get(entityId) ?? []), employeeId]);
  }
  let fromPayroll = 0;
  for (const [entityId, employeeIds] of [...byEntity.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    ctx.ops.push({ kind: 'employees_from_payroll', entityId, employeeIds });
    fromPayroll += employeeIds.length;
  }
  ctx.report.counts.employeesFromPayroll = fromPayroll;

  const [{ empty }] = await ctx.db
    .select({ empty: sql<number>`count(*)::int` })
    .from(schema.hrEmployees)
    .where(isNull(schema.hrEmployees.legalEntityId));
  const remaining = Number(empty) - fromPayroll;
  if (remaining <= 0) return;
  if (!defaultEntityId) {
    ctx.report.notes.push({ subject: 'employees', message: `${remaining} employee(s) have no employing legal entity, and there is no default entity` });
    return;
  }
  ctx.ops.push({ kind: 'employees_from_default', entityId: defaultEntityId, expected: remaining });
  ctx.report.counts.employeesFromDefault = remaining;
}

/** `einOrSsn` values the SQL left alone: anything not in the `12-3456789` EIN form, unless the entity has that EIN already. */
function reportTaxIds(ctx: PlanContext): void {
  const entities = [...ctx.entities.values()].filter((e) => !e.deletedAt).sort((a, b) => a.id.localeCompare(b.id));
  for (const entity of entities) {
    const value = text(entity.taxIdentifiers?.einOrSsn);
    if (!value || /^\d{2}-\d{7}$/.test(value)) continue;
    const digits = value.replaceAll(/\D/g, '');
    const eins = (ctx.registrations.get(entity.id) ?? []).filter((r) => r.type === 'ein');
    if (digits && eins.some((r) => r.number.replaceAll(/\D/g, '') === digits)) continue;
    let what: string;
    if (/^\d{9}$/.test(value)) what = 'nine digits without a dash: an EIN or an SSN?';
    else if (/^\d{3}-\d{2}-\d{4}$/.test(value)) what = 'has the SSN form (3-2-4 digits)';
    else what = 'is neither an EIN nor an SSN';
    ctx.report.taxIdsToReview.push({
      subject: `entity ${entity.id} (${entity.name})`,
      message: `tax_identifiers.einOrSsn ${maskTail(digits || value)} ${what}; not migrated, add it as an EIN registration if it is one`,
    });
  }
}

// ---------------------------------------------------------------------------
// Plan and apply
// ---------------------------------------------------------------------------

async function loadContext(db: Database, keyring: EncryptionKeyring, report: WorkspaceBackfillReport): Promise<PlanContext> {
  const entityRows = await db
    .select({ ...getTableColumns(schema.legalEntities), stamp: sql<string>`${schema.legalEntities.updatedAt}::text` })
    .from(schema.legalEntities)
    .orderBy(asc(schema.legalEntities.id));
  const entities = new Map<string, EntityRow>();
  const entityStamps = new Map<string, string>();
  for (const { stamp, ...row } of entityRows) {
    entities.set(row.id, row);
    entityStamps.set(row.id, stamp);
  }

  const accountRows = await db.select().from(schema.bankAccounts).orderBy(asc(schema.bankAccounts.createdAt), asc(schema.bankAccounts.id));
  const accounts = new Map<string, AccountState[]>();
  const rank = (a: AccountFacts): number => (a.isActive === false ? 2 : 0) + (a.isDefault ? 0 : 1);
  for (const row of [...accountRows].filter((r) => !r.deletedAt).sort((a, b) => rank(a) - rank(b))) {
    accounts.set(row.entityId, [...(accounts.get(row.entityId) ?? []), { row }]);
  }

  const registrationRows = await db
    .select()
    .from(schema.legalEntityRegistrations)
    .orderBy(asc(schema.legalEntityRegistrations.createdAt), asc(schema.legalEntityRegistrations.id));
  const registrations = new Map<string, RegistrationRow[]>();
  for (const row of registrationRows.filter((r) => !r.deletedAt)) {
    registrations.set(row.entityId, [...(registrations.get(row.entityId) ?? []), row]);
  }

  const settingsRows = await db
    .select({ entityId: schema.accountingEntitySettings.entityId, invoiceBankAccountId: schema.accountingEntitySettings.invoiceBankAccountId })
    .from(schema.accountingEntitySettings);

  return {
    db,
    keyring,
    report,
    ops: [],
    entities,
    entityStamps,
    accounts,
    accountIds: new Set(accountRows.map((r) => r.id)),
    registrations,
    registrationIds: new Set(registrationRows.map((r) => r.id)),
    booksSettings: new Map(settingsRows.map((r) => [r.entityId, r.invoiceBankAccountId ?? null])),
  };
}

/** Read the tenant and decide every write. Reads only. */
export async function planWorkspace(
  db: Database,
  keyring: EncryptionKeyring,
  mode: WorkspaceBackfillReport['mode'] = 'dry-run',
): Promise<{ report: WorkspaceBackfillReport; ops: Op[] }> {
  const report = emptyReport(mode);
  const ctx = await loadContext(db, keyring, report);
  await planEmployerBanks(ctx);
  await planInvoiceAccounts(ctx);
  const defaultEntityId = await planWorkspaceSettings(ctx);
  await planEmployees(ctx, defaultEntityId);
  reportTaxIds(ctx);
  report.changes = ctx.ops.reduce((n, op) => n + opWeight(op), 0);
  return { report, ops: ctx.ops };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function applyOp(db: Database, keyring: EncryptionKeyring, op: Op, report: WorkspaceBackfillReport): Promise<void> {
  const now = new Date();
  switch (op.kind) {
    case 'insert_bank_account': {
      const inserted = await db
        .insert(schema.bankAccounts)
        .values({
          ...op.row,
          accountNumberEncrypted: op.accountNumber ? await encryptField(op.accountNumber, keyring) : null,
        })
        .onConflictDoNothing()
        .returning({ id: schema.bankAccounts.id });
      if (inserted.length === 0) throw new ConcurrentChangeError(`bank account ${op.row.id}`);
      return;
    }
    case 'set_ach_company_id': {
      const updated = await db
        .update(schema.bankAccounts)
        .set({ achSettings: op.achSettings, updatedAt: now })
        .where(and(
          eq(schema.bankAccounts.id, op.accountId),
          sql`coalesce(trim(${schema.bankAccounts.achSettings} ->> 'companyIdentification'), '') = ''`,
        ))
        .returning({ id: schema.bankAccounts.id });
      if (updated.length === 0) throw new ConcurrentChangeError(`ach_settings of bank account ${op.accountId}`);
      return;
    }
    case 'link_employer_bank': {
      const updated = await db
        .update(schema.hrPayrollEmployers)
        .set({ bankAccountId: op.bankAccountId, updatedAt: now })
        .where(and(eq(schema.hrPayrollEmployers.id, op.employerId), isNull(schema.hrPayrollEmployers.bankAccountId)))
        .returning({ id: schema.hrPayrollEmployers.id });
      if (updated.length === 0) throw new ConcurrentChangeError(`employer ${op.employerId}`);
      return;
    }
    case 'set_invoice_account': {
      const updated = await db
        .update(schema.accountingEntitySettings)
        .set({ invoiceBankAccountId: op.bankAccountId, updatedAt: now })
        .where(and(eq(schema.accountingEntitySettings.entityId, op.entityId), isNull(schema.accountingEntitySettings.invoiceBankAccountId)))
        .returning({ id: schema.accountingEntitySettings.entityId });
      if (updated.length === 0) throw new ConcurrentChangeError(`invoice account of entity ${op.entityId}`);
      return;
    }
    case 'insert_entity': {
      const inserted = await db
        .insert(schema.legalEntities)
        .values(op.row)
        .onConflictDoNothing()
        .returning({ id: schema.legalEntities.id });
      if (inserted.length === 0) throw new ConcurrentChangeError(`the default legal entity (${op.row.id})`);
      return;
    }
    case 'update_entity': {
      const updated = await db
        .update(schema.legalEntities)
        .set({ ...op.patch, updatedAt: now })
        .where(and(eq(schema.legalEntities.id, op.entityId), sql`${schema.legalEntities.updatedAt}::text = ${op.stamp}`))
        .returning({ id: schema.legalEntities.id });
      if (updated.length === 0) throw new ConcurrentChangeError(`entity ${op.entityId}`);
      return;
    }
    case 'insert_registration': {
      const inserted = await db
        .insert(schema.legalEntityRegistrations)
        .values(op.row)
        .onConflictDoNothing()
        .returning({ id: schema.legalEntityRegistrations.id });
      if (inserted.length === 0) throw new ConcurrentChangeError(`registration ${op.row.id}`);
      return;
    }
    case 'employees_from_payroll': {
      let count = 0;
      for (const ids of chunks(op.employeeIds, EMPLOYEE_UPDATE_CHUNK)) {
        const updated = await db
          .update(schema.hrEmployees)
          .set({ legalEntityId: op.entityId })
          .where(and(inArray(schema.hrEmployees.id, ids), isNull(schema.hrEmployees.legalEntityId)))
          .returning({ id: schema.hrEmployees.id });
        count += updated.length;
      }
      report.counts.employeesFromPayroll += count - op.employeeIds.length;
      report.changes += count - op.employeeIds.length;
      return;
    }
    case 'employees_from_default': {
      const updated = await db
        .update(schema.hrEmployees)
        .set({ legalEntityId: op.entityId })
        .where(isNull(schema.hrEmployees.legalEntityId))
        .returning({ id: schema.hrEmployees.id });
      report.counts.employeesFromDefault += updated.length - op.expected;
      report.changes += updated.length - op.expected;
      return;
    }
  }
}

/**
 * Whether the tenant has the release 1 schema (tenant migrations 0248 and
 * 0249). Run outside a transaction: a failed probe would abort one.
 */
export async function hasLegalEntitySchema(db: Database): Promise<boolean> {
  try {
    await db.select({ id: schema.legalEntityRegistrations.id }).from(schema.legalEntityRegistrations).limit(1);
    await db.select({ id: schema.accountingEntitySettings.invoiceBankAccountId }).from(schema.accountingEntitySettings).limit(1);
    await db.select({ id: schema.hrPayrollEmployers.bankAccountId }).from(schema.hrPayrollEmployers).limit(1);
    await db.select({ id: schema.hrEmployees.legalEntityId }).from(schema.hrEmployees).limit(1);
    return true;
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    const code = cause?.code ?? (err as { code?: string }).code;
    if (code === '42P01' || code === '42703') return false;
    throw err;
  }
}

export interface BackfillOptions {
  /** Write the plan. Without it the run is a dry-run in a read-only transaction. */
  execute: boolean;
}

/**
 * Backfill one tenant database. A dry-run plans in a read-only transaction
 * and writes nothing; an execute plans and applies in one transaction, so a
 * failure (including a `ConcurrentChangeError`) leaves the tenant untouched.
 */
export async function backfillLegalEntities(
  db: Database,
  keyring: EncryptionKeyring,
  options: BackfillOptions,
): Promise<WorkspaceBackfillReport> {
  if (!(await hasLegalEntitySchema(db))) {
    const report = emptyReport(options.execute ? 'execute' : 'dry-run');
    report.status = 'skipped';
    report.skippedReason = 'the legal entities migrations (tenant 0248 and 0249) have not run here';
    return report;
  }
  if (!options.execute) {
    return db.transaction(async (tx) => (await planWorkspace(tx, keyring, 'dry-run')).report, { accessMode: 'read only' });
  }
  return db.transaction(async (tx) => {
    const { report, ops } = await planWorkspace(tx, keyring, 'execute');
    for (const op of ops) await applyOp(tx, keyring, op, report);
    return report;
  });
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

const COUNT_LABELS: Array<[keyof BackfillCounts, string]> = [
  ['employerBanksMatched', 'employer bank accounts matched'],
  ['employerBanksCreated', 'employer bank accounts created'],
  ['employersLinked', 'employers linked to a bank account'],
  ['nachaCompanyIdsMoved', 'NACHA company ids moved'],
  ['invoiceAccountsMatched', 'invoice bank details matched'],
  ['invoiceAccountsCreated', 'invoice bank accounts created'],
  ['invoiceAccountsSet', 'invoice accounts set'],
  ['entityFieldsFilled', 'default entity fields filled'],
  ['registrationsCreated', 'registrations created'],
  ['defaultEntitiesCreated', 'default entities created'],
  ['employeesFromPayroll', 'employees given their payroll employer'],
  ['employeesFromDefault', 'employees given the default entity'],
];

/** The lines of one workspace's report, indented for the CLI. */
export function formatWorkspaceReport(label: string, report: WorkspaceBackfillReport): string[] {
  if (report.status === 'skipped') return [`  ${label}: skipped, ${report.skippedReason ?? ''}`];
  const verb = report.mode === 'execute' ? 'changed' : 'to change';
  const summary = report.changes === 0 ? 'nothing to change' : `${report.changes} ${verb}`;
  const lines = [`  ${label}: ${summary}`];
  const counts = COUNT_LABELS.filter(([key]) => report.counts[key] > 0).map(([key, l]) => `${l} ${report.counts[key]}`);
  if (counts.length > 0) lines.push(`    ${counts.join('; ')}`);
  for (const a of report.createdBankAccounts) {
    lines.push(`    + bank account ${a.accountId} on ${a.entityId} from ${a.source === 'employer' ? 'employer' : 'bank_details of'} ${a.sourceId} (${a.account})`);
  }
  for (const f of report.filledFields) lines.push(`    + ${f.entityId} ${f.field} = "${f.value}"`);
  const section = (title: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push(`    ${title}:`);
    for (const item of items) lines.push(`      - ${item}`);
  };
  section(
    'differences (entity value kept)',
    report.differences.map((d) => `${d.entityId} ${d.field}: "${d.entityValue}", workspace settings "${d.workspaceValue}"`),
  );
  section('conflicts', report.conflicts.map((i) => `${i.subject}: ${i.message}`));
  section('bank details not moved', report.bankIssues.map((i) => `${i.subject}: ${i.message}`));
  section('tax ids to review', report.taxIdsToReview.map((i) => `${i.subject}: ${i.message}`));
  section('notes', report.notes.map((i) => `${i.subject}: ${i.message}`));
  return lines;
}

/** Totals over several workspaces. */
export interface BackfillSummary {
  workspaces: number;
  withChanges: number;
  skipped: number;
  failed: number;
  changes: number;
  counts: BackfillCounts;
  differences: number;
  conflicts: number;
  bankIssues: number;
  taxIdsToReview: number;
}

export function emptySummary(): BackfillSummary {
  return {
    workspaces: 0,
    withChanges: 0,
    skipped: 0,
    failed: 0,
    changes: 0,
    counts: emptyCounts(),
    differences: 0,
    conflicts: 0,
    bankIssues: 0,
    taxIdsToReview: 0,
  };
}

export function addToSummary(summary: BackfillSummary, report: WorkspaceBackfillReport): void {
  summary.workspaces += 1;
  if (report.status === 'skipped') {
    summary.skipped += 1;
    return;
  }
  if (report.changes > 0) summary.withChanges += 1;
  summary.changes += report.changes;
  for (const [key] of COUNT_LABELS) summary.counts[key] += report.counts[key];
  summary.differences += report.differences.length;
  summary.conflicts += report.conflicts.length;
  summary.bankIssues += report.bankIssues.length;
  summary.taxIdsToReview += report.taxIdsToReview.length;
}

export function formatSummary(summary: BackfillSummary, execute: boolean): string[] {
  const lines = [
    `\nSUMMARY (${execute ? 'execute' : 'dry-run'}): ${summary.workspaces} workspace(s), ${summary.withChanges} with changes, ${summary.skipped} skipped, ${summary.failed} failed`,
    `  ${summary.changes} change(s) ${execute ? 'written' : 'planned'}`,
  ];
  for (const [key, label] of COUNT_LABELS) if (summary.counts[key] > 0) lines.push(`  ${label}: ${summary.counts[key]}`);
  lines.push(
    `  to review: ${summary.differences} difference(s), ${summary.conflicts} conflict(s), ${summary.bankIssues} bank issue(s), ${summary.taxIdsToReview} tax id(s)`,
  );
  return lines;
}
