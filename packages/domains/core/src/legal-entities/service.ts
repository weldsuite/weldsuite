/**
 * Core legal entities (docs/plans/legal-entities.md): the companies of a
 * workspace, their registrations and bank accounts. Pure functions over the
 * tenant DB; app-api's `/api/legal-entities` routes, books-api and hr-api
 * call them.
 *
 * Release 1 mirrors: registrations are mirrored into the deprecated
 * `entities.tax_identifiers` and into the WeldHR employer that runs payroll
 * under them; a bank account is mirrored into the deprecated
 * `hr_payroll_employers.bank_encrypted` of the employers that pay from it; the
 * default entity is mirrored into `settings.default_entity_id` when WeldBooks
 * is enabled for it.
 */

import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { decryptField, encryptField, keyringFromEnv, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import type { HrPayrollEmployerBank } from '@weldsuite/db/schema';
import { SYSTEM_ROLES } from '@weldsuite/permissions/catalog';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  normalizeRegistrationNumber,
  registrationNumberError,
  type CreateBankAccountInput,
  type CreateLegalEntityInput,
  type CreateRegistrationInput,
  type LegalEntity,
  type LegalEntityAccess,
  type LegalEntityApp,
  type LegalEntityBankAccount,
  type LegalEntityEffectiveAccess,
  type LegalEntityRegistration,
  type LegalEntityRegistrationType,
  type LegalEntityUsage,
  type UpdateBankAccountInput,
  type UpdateLegalEntityInput,
  type UpdateRegistrationInput,
} from '@weldsuite/app-api-client/schemas/legal-entities';
import {
  canSeeEntity,
  entityAccessSource,
  entityRoleId,
  permissionsInEntity,
  visibleEntityIds,
  type EntityAccess,
} from './access';
import {
  enabledAppsByEntity,
  getLegalEntityExtension,
  LEGAL_ENTITY_EXTENSIONS,
  lockedCoreChange,
  type LegalEntityCoreChange,
} from './extensions';

type EntityRow = typeof schema.legalEntities.$inferSelect;
type RegistrationRow = typeof schema.legalEntityRegistrations.$inferSelect;
type BankAccountRow = typeof schema.bankAccounts.$inferSelect;

export type LegalEntityErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST' | 'NO_ENCRYPTION_KEY';

export class LegalEntityError extends Error {
  constructor(
    readonly code: LegalEntityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LegalEntityError';
  }
}

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : String(d);

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

function toLegalEntity(row: EntityRow, enabledApps: LegalEntityApp[], access?: EntityAccess): LegalEntity {
  const { logoUrl, primaryColor, accentColor } = row.branding ?? {};
  const branding = logoUrl || primaryColor || accentColor ? { logoUrl, primaryColor, accentColor } : null;
  const entity: LegalEntity = {
    id: row.id,
    name: row.name,
    legalName: row.legalName ?? null,
    dba: row.dba ?? null,
    entityType: row.entityType ?? null,
    jurisdictionCode: row.jurisdictionCode,
    baseCurrency: row.baseCurrency,
    locale: row.locale,
    timezone: row.timezone ?? null,
    address: (row.address as LegalEntity['address']) ?? null,
    contact: row.contact ?? null,
    branding,
    fiscalYearStart: row.fiscalYearStart ?? null,
    fiscalYearConfig: row.fiscalYearConfig ?? null,
    taxClassification: row.taxClassification ?? null,
    isDefault: Boolean(row.isDefault),
    isActive: row.isActive !== false,
    accessRestricted: Boolean(row.accessRestricted),
    enabledApps,
    createdAt: iso(row.createdAt) ?? '',
    updatedAt: iso(row.updatedAt) ?? '',
  };
  if (access) {
    entity.myAccess = { source: entityAccessSource(access, row.id), roleId: entityRoleId(access, row.id), roleName: null };
  }
  return entity;
}

async function withRoleNames(db: Database, entities: LegalEntity[]): Promise<LegalEntity[]> {
  const roleIds = [...new Set(entities.map((e) => e.myAccess?.roleId).filter((id): id is string => Boolean(id)))];
  if (roleIds.length === 0) return entities;
  const names = await roleNames(db, roleIds);
  return entities.map((e) =>
    e.myAccess?.roleId ? { ...e, myAccess: { ...e.myAccess, roleName: names.get(e.myAccess.roleId) ?? null } } : e,
  );
}

async function roleNames(db: Database, roleIds: string[]): Promise<Map<string, string>> {
  if (roleIds.length === 0) return new Map();
  const rows = await db
    .select({ id: schema.roles.id, name: schema.roles.name })
    .from(schema.roles)
    .where(inArray(schema.roles.id, roleIds));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function loadEntityRow(db: Database, id: string): Promise<EntityRow | null> {
  const [row] = await db
    .select()
    .from(schema.legalEntities)
    .where(and(eq(schema.legalEntities.id, id), isNull(schema.legalEntities.deletedAt)))
    .limit(1);
  return row ?? null;
}

async function requireEntityRow(db: Database, id: string): Promise<EntityRow> {
  const row = await loadEntityRow(db, id);
  if (!row) throw new LegalEntityError('NOT_FOUND', 'Legal entity not found');
  return row;
}

export interface ListLegalEntitiesOptions {
  /** Filter to what this member sees and add `myAccess`. */
  access?: EntityAccess;
  /** Only entities this app is enabled for. */
  app?: LegalEntityApp;
  includeArchived?: boolean;
}

export async function listLegalEntities(db: Database, options: ListLegalEntitiesOptions = {}): Promise<LegalEntity[]> {
  const conditions = [isNull(schema.legalEntities.deletedAt)];
  if (!options.includeArchived) conditions.push(sql`${schema.legalEntities.isActive} is not false`);
  if (options.access) {
    const visible = visibleEntityIds(options.access);
    if (visible.length === 0) return [];
    conditions.push(inArray(schema.legalEntities.id, visible));
  }
  const rows = await db
    .select()
    .from(schema.legalEntities)
    .where(and(...conditions))
    .orderBy(desc(schema.legalEntities.isDefault), asc(schema.legalEntities.name), asc(schema.legalEntities.id));
  const apps = await enabledAppsByEntity(db, rows.map((r) => r.id));
  const entities = rows
    .map((row) => toLegalEntity(row, apps.get(row.id) ?? [], options.access))
    .filter((e) => !options.app || e.enabledApps.includes(options.app));
  return withRoleNames(db, entities);
}

/** One entity, or null when it is deleted, unknown or (with `access`) not visible to the member. */
export async function getLegalEntity(db: Database, id: string, access?: EntityAccess): Promise<LegalEntity | null> {
  if (access && !canSeeEntity(access, id)) return null;
  const row = await loadEntityRow(db, id);
  if (!row) return null;
  const apps = await enabledAppsByEntity(db, [row.id]);
  const [entity] = await withRoleNames(db, [toLegalEntity(row, apps.get(row.id) ?? [], access)]);
  return entity;
}

export async function getDefaultLegalEntityRow(db: Database): Promise<EntityRow | null> {
  const [row] = await db
    .select()
    .from(schema.legalEntities)
    .where(and(eq(schema.legalEntities.isDefault, true), isNull(schema.legalEntities.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function getDefaultLegalEntity(db: Database, access?: EntityAccess): Promise<LegalEntity | null> {
  const row = await getDefaultLegalEntityRow(db);
  return row ? getLegalEntity(db, row.id, access) : null;
}

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

/** Core columns of a create/update input. Document texts in `branding` are WeldBooks' and are kept as they are. */
function coreColumns(input: UpdateLegalEntityInput, existing?: EntityRow): Partial<EntityRow> {
  const out: Partial<EntityRow> = {};
  if (input.name !== undefined) out.name = input.name;
  if (input.legalName !== undefined) out.legalName = input.legalName ?? null;
  if (input.dba !== undefined) out.dba = input.dba ?? null;
  if (input.entityType !== undefined) out.entityType = input.entityType ?? null;
  if (input.jurisdictionCode !== undefined) out.jurisdictionCode = input.jurisdictionCode;
  if (input.baseCurrency !== undefined) out.baseCurrency = input.baseCurrency;
  if (input.locale !== undefined) out.locale = input.locale;
  if (input.timezone !== undefined) out.timezone = input.timezone;
  if (input.address !== undefined) out.address = input.address ?? null;
  if (input.contact !== undefined) out.contact = input.contact ?? null;
  if (input.fiscalYearStart !== undefined) out.fiscalYearStart = input.fiscalYearStart;
  if (input.fiscalYearConfig !== undefined) out.fiscalYearConfig = input.fiscalYearConfig ?? null;
  if (input.taxClassification !== undefined) out.taxClassification = input.taxClassification ?? null;
  if (input.branding !== undefined) {
    const { footerText, paymentInstructions, termsAndConditions } = existing?.branding ?? {};
    out.branding = {
      ...(input.branding ?? {}),
      ...(footerText !== undefined && { footerText }),
      ...(paymentInstructions !== undefined && { paymentInstructions }),
      ...(termsAndConditions !== undefined && { termsAndConditions }),
    };
  }
  return out;
}

export async function createLegalEntity(db: Database, input: CreateLegalEntityInput): Promise<EntityRow> {
  const id = generateId('ent');
  const country = input.jurisdictionCode;
  const [existingDefault] = await db
    .select({ id: schema.legalEntities.id })
    .from(schema.legalEntities)
    .where(and(eq(schema.legalEntities.isDefault, true), isNull(schema.legalEntities.deletedAt)))
    .limit(1);
  const makeDefault = !existingDefault || input.isDefault === true;

  if (makeDefault && existingDefault) {
    await db.update(schema.legalEntities).set({ isDefault: false, updatedAt: new Date() }).where(eq(schema.legalEntities.id, existingDefault.id));
  }
  const [row] = await db
    .insert(schema.legalEntities)
    .values({
      id,
      ...coreColumns(input),
      name: input.name,
      jurisdictionCode: country,
      baseCurrency: input.baseCurrency,
      locale: input.locale ?? defaultLocale(country),
      timezone: input.timezone ?? (country === 'NL' ? 'Europe/Amsterdam' : null),
      isDefault: makeDefault,
      isActive: true,
    })
    .returning();
  return row;
}

/** Which history-bearing fields a patch changes (codes compared case-insensitively). */
function coreChange(existing: EntityRow, patch: Partial<EntityRow>): LegalEntityCoreChange {
  const differs = (next: string | null | undefined, current: string | null | undefined) =>
    next !== undefined && (next ?? '').toUpperCase() !== (current ?? '').toUpperCase();
  return {
    jurisdictionCode: differs(patch.jurisdictionCode, existing.jurisdictionCode),
    baseCurrency: differs(patch.baseCurrency, existing.baseCurrency),
    fiscalYear:
      (patch.fiscalYearStart !== undefined && patch.fiscalYearStart !== existing.fiscalYearStart) ||
      (patch.fiscalYearConfig !== undefined &&
        JSON.stringify(patch.fiscalYearConfig ?? null) !== JSON.stringify(existing.fiscalYearConfig ?? null)),
  };
}

export async function updateLegalEntity(db: Database, id: string, input: UpdateLegalEntityInput): Promise<EntityRow> {
  const existing = await requireEntityRow(db, id);
  const patch = coreColumns(input, existing);
  if (Object.keys(patch).length === 0) return existing;
  const locked = await lockedCoreChange(db, id, coreChange(existing, patch));
  if (locked) throw new LegalEntityError('CONFLICT', locked);
  const [row] = await db
    .update(schema.legalEntities)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.legalEntities.id, id))
    .returning();
  return row;
}

export async function setDefaultLegalEntity(db: Database, id: string): Promise<EntityRow> {
  const entity = await requireEntityRow(db, id);
  if (entity.isActive === false) throw new LegalEntityError('CONFLICT', 'An archived legal entity cannot be the default');
  if (entity.isDefault) return entity;
  await db
    .update(schema.legalEntities)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(eq(schema.legalEntities.isDefault, true), ne(schema.legalEntities.id, id)));
  const [row] = await db
    .update(schema.legalEntities)
    .set({ isDefault: true, updatedAt: new Date() })
    .where(eq(schema.legalEntities.id, id))
    .returning();
  // Release 1 mirror: WeldBooks still reads settings.default_entity_id.
  const booksEnabled = await getLegalEntityExtension('weldbooks').enabledFor(db, [id]);
  if (booksEnabled.has(id)) {
    await db.update(schema.settings).set({ defaultEntityId: id, updatedAt: new Date() });
  }
  return row;
}

export async function setLegalEntityArchived(db: Database, id: string, archived: boolean): Promise<EntityRow> {
  const entity = await requireEntityRow(db, id);
  if (archived && entity.isDefault) {
    throw new LegalEntityError('CONFLICT', 'Make another legal entity the default before archiving this one');
  }
  const [row] = await db
    .update(schema.legalEntities)
    .set({ isActive: !archived, updatedAt: new Date() })
    .where(eq(schema.legalEntities.id, id))
    .returning();
  return row;
}

export async function legalEntityUsage(db: Database, id: string): Promise<LegalEntityUsage[]> {
  await requireEntityRow(db, id);
  const usage: LegalEntityUsage[] = [];
  for (const extension of LEGAL_ENTITY_EXTENSIONS) {
    const enabled = (await extension.enabledFor(db, [id])).has(id);
    usage.push({ app: extension.app, enabled, hasData: enabled ? await extension.hasData(db, id) : false });
  }
  return usage;
}

/** Soft delete. Refused for the default and while any app holds data for the entity. */
export async function deleteLegalEntity(db: Database, id: string): Promise<EntityRow> {
  const entity = await requireEntityRow(db, id);
  if (entity.isDefault) throw new LegalEntityError('CONFLICT', 'Make another legal entity the default before deleting this one');
  const usage = await legalEntityUsage(db, id);
  const inUse = usage.filter((u) => u.hasData).map((u) => u.app);
  if (inUse.length > 0) {
    throw new LegalEntityError('CONFLICT', `This legal entity still has data in ${inUse.join(', ')}; archive it instead`);
  }
  const [row] = await db
    .update(schema.legalEntities)
    .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
    .where(eq(schema.legalEntities.id, id))
    .returning();
  await db.delete(schema.legalEntityMembers).where(eq(schema.legalEntityMembers.entityId, id));
  return row;
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

/** Types where one number per entity (per region for state types) is the primary. */
const PRIMARY_TYPES: ReadonlySet<LegalEntityRegistrationType> = new Set([
  'vat', 'gstin', 'company_registration', 'rsin', 'ein', 'pan', 'eori', 'nl_payroll_tax',
]);

function toRegistration(row: RegistrationRow): LegalEntityRegistration {
  return {
    id: row.id,
    entityId: row.entityId,
    type: row.type as LegalEntityRegistrationType,
    number: row.number,
    country: row.country ?? null,
    region: row.region ?? null,
    label: row.label ?? null,
    validFrom: row.validFrom ?? null,
    validTo: row.validTo ?? null,
    isPrimary: row.isPrimary,
    verifiedAt: iso(row.verifiedAt),
    createdAt: iso(row.createdAt) ?? '',
    updatedAt: iso(row.updatedAt) ?? '',
  };
}

export async function listRegistrations(db: Database, entityId: string): Promise<LegalEntityRegistration[]> {
  await requireEntityRow(db, entityId);
  const rows = await db
    .select()
    .from(schema.legalEntityRegistrations)
    .where(and(eq(schema.legalEntityRegistrations.entityId, entityId), isNull(schema.legalEntityRegistrations.deletedAt)))
    .orderBy(asc(schema.legalEntityRegistrations.type), desc(schema.legalEntityRegistrations.isPrimary), asc(schema.legalEntityRegistrations.createdAt));
  return rows.map(toRegistration);
}

/** Primary registration of a type (and region), the lookup apps use. */
export async function getRegistration(
  db: Database,
  entityId: string,
  type: LegalEntityRegistrationType,
  region?: string | null,
): Promise<LegalEntityRegistration | null> {
  const conditions = [
    eq(schema.legalEntityRegistrations.entityId, entityId),
    eq(schema.legalEntityRegistrations.type, type),
    isNull(schema.legalEntityRegistrations.deletedAt),
  ];
  if (region) conditions.push(eq(schema.legalEntityRegistrations.region, region));
  const [row] = await db
    .select()
    .from(schema.legalEntityRegistrations)
    .where(and(...conditions))
    .orderBy(desc(schema.legalEntityRegistrations.isPrimary), asc(schema.legalEntityRegistrations.createdAt))
    .limit(1);
  return row ? toRegistration(row) : null;
}

async function clearOtherPrimaries(db: Database, row: RegistrationRow): Promise<void> {
  const conditions = [
    eq(schema.legalEntityRegistrations.entityId, row.entityId),
    eq(schema.legalEntityRegistrations.type, row.type),
    ne(schema.legalEntityRegistrations.id, row.id),
    eq(schema.legalEntityRegistrations.isPrimary, true),
  ];
  if (row.region) conditions.push(eq(schema.legalEntityRegistrations.region, row.region));
  await db.update(schema.legalEntityRegistrations).set({ isPrimary: false, updatedAt: new Date() }).where(and(...conditions));
}

/**
 * Release 1 mirror of the primaries into `entities.tax_identifiers` (still
 * read by WeldBooks and the Rust backend). An SSN stored as `einOrSsn` is
 * only replaced when an EIN registration exists.
 */
async function mirrorTaxIdentifiers(db: Database, entityId: string): Promise<void> {
  const entity = await loadEntityRow(db, entityId);
  if (!entity) return;
  const regs = await db
    .select()
    .from(schema.legalEntityRegistrations)
    .where(and(
      eq(schema.legalEntityRegistrations.entityId, entityId),
      eq(schema.legalEntityRegistrations.isPrimary, true),
      isNull(schema.legalEntityRegistrations.deletedAt),
    ));
  const primary = (type: string) => regs.find((r) => r.type === type)?.number;
  const current = entity.taxIdentifiers ?? {};
  const vatType = entity.jurisdictionCode.toUpperCase().startsWith('IN') ? 'gstin' : 'vat';
  const next = {
    ...current,
    vatNumber: primary(vatType) ?? undefined,
    registrationNumber: primary('company_registration') ?? undefined,
    einOrSsn: primary('ein') ?? current.einOrSsn,
  };
  await db
    .update(schema.legalEntities)
    .set({ taxIdentifiers: next, updatedAt: new Date() })
    .where(eq(schema.legalEntities.id, entityId));
}

/** Release 1 mirror into the WeldHR employers that run payroll under this registration. */
async function mirrorRegistrationToEmployers(db: Database, row: RegistrationRow): Promise<void> {
  if (row.type !== 'nl_payroll_tax' && row.type !== 'ein') return;
  const employers = await db
    .select({ id: schema.hrPayrollEmployers.id, nl: schema.hrPayrollEmployers.nlSettings, us: schema.hrPayrollEmployers.usSettings })
    .from(schema.hrPayrollEmployers)
    .where(eq(schema.hrPayrollEmployers.registrationId, row.id));
  for (const employer of employers) {
    await db
      .update(schema.hrPayrollEmployers)
      .set(
        row.type === 'nl_payroll_tax'
          ? { nlSettings: { ...employer.nl, loonheffingennummer: row.number }, updatedAt: new Date() }
          : { usSettings: { ...employer.us, ein: row.number }, updatedAt: new Date() },
      )
      .where(eq(schema.hrPayrollEmployers.id, employer.id));
  }
}

export async function createRegistration(
  db: Database,
  entityId: string,
  input: CreateRegistrationInput,
): Promise<LegalEntityRegistration> {
  const entity = await requireEntityRow(db, entityId);
  const number = normalizeRegistrationNumber(input.type, input.number);
  const problem = registrationNumberError(input.type, number);
  if (problem) throw new LegalEntityError('BAD_REQUEST', problem);

  const existing = await getRegistration(db, entityId, input.type, input.region ?? null);
  const isPrimary = PRIMARY_TYPES.has(input.type) ? (input.isPrimary ?? !existing) : false;
  const [row] = await db
    .insert(schema.legalEntityRegistrations)
    .values({
      id: generateId('ler'),
      entityId,
      type: input.type,
      number,
      country: input.country ?? entity.jurisdictionCode.slice(0, 2).toUpperCase(),
      region: input.region ?? null,
      label: input.label ?? null,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      isPrimary,
    })
    .returning();
  if (row.isPrimary) await clearOtherPrimaries(db, row);
  await mirrorTaxIdentifiers(db, entityId);
  return toRegistration(row);
}

async function requireRegistration(db: Database, entityId: string, registrationId: string): Promise<RegistrationRow> {
  const [row] = await db
    .select()
    .from(schema.legalEntityRegistrations)
    .where(and(
      eq(schema.legalEntityRegistrations.id, registrationId),
      eq(schema.legalEntityRegistrations.entityId, entityId),
      isNull(schema.legalEntityRegistrations.deletedAt),
    ))
    .limit(1);
  if (!row) throw new LegalEntityError('NOT_FOUND', 'Registration not found');
  return row;
}

export async function updateRegistration(
  db: Database,
  entityId: string,
  registrationId: string,
  input: UpdateRegistrationInput,
): Promise<LegalEntityRegistration> {
  const existing = await requireRegistration(db, entityId, registrationId);
  const type = existing.type as LegalEntityRegistrationType;
  const patch: Partial<RegistrationRow> = { updatedAt: new Date() };
  if (input.number !== undefined) {
    const number = normalizeRegistrationNumber(type, input.number);
    const problem = registrationNumberError(type, number);
    if (problem) throw new LegalEntityError('BAD_REQUEST', problem);
    patch.number = number;
    if (number !== existing.number) {
      patch.verifiedAt = null;
      patch.verification = null;
    }
  }
  if (input.country !== undefined) patch.country = input.country ?? null;
  if (input.region !== undefined) patch.region = input.region ?? null;
  if (input.label !== undefined) patch.label = input.label ?? null;
  if (input.validFrom !== undefined) patch.validFrom = input.validFrom ?? null;
  if (input.validTo !== undefined) patch.validTo = input.validTo ?? null;
  if (input.isPrimary !== undefined && PRIMARY_TYPES.has(type)) patch.isPrimary = input.isPrimary;

  const [row] = await db
    .update(schema.legalEntityRegistrations)
    .set(patch)
    .where(eq(schema.legalEntityRegistrations.id, registrationId))
    .returning();
  if (row.isPrimary) await clearOtherPrimaries(db, row);
  await mirrorTaxIdentifiers(db, entityId);
  await mirrorRegistrationToEmployers(db, row);
  return toRegistration(row);
}

export async function deleteRegistration(db: Database, entityId: string, registrationId: string): Promise<void> {
  const row = await requireRegistration(db, entityId, registrationId);
  const [employer] = await db
    .select({ id: schema.hrPayrollEmployers.id })
    .from(schema.hrPayrollEmployers)
    .where(and(eq(schema.hrPayrollEmployers.registrationId, row.id), isNull(schema.hrPayrollEmployers.deletedAt)))
    .limit(1);
  if (employer) throw new LegalEntityError('CONFLICT', 'WeldHR payroll runs under this registration; change the payroll setup first');
  await db
    .update(schema.legalEntityRegistrations)
    .set({ deletedAt: new Date(), isPrimary: false, updatedAt: new Date() })
    .where(eq(schema.legalEntityRegistrations.id, row.id));
  await mirrorTaxIdentifiers(db, entityId);
}

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

type KeyEnv = { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string };

function requireKeyring(env: KeyEnv): EncryptionKeyring {
  const keyring = keyringFromEnv(env);
  if (!keyring.v1 && !keyring.v2) {
    throw new LegalEntityError('NO_ENCRYPTION_KEY', 'Account numbers cannot be stored: the worker has no encryption key');
  }
  return keyring;
}

async function toBankAccounts(db: Database, rows: BankAccountRow[]): Promise<LegalEntityBankAccount[]> {
  const ids = rows.map((r) => r.id);
  const inBooks = ids.length
    ? new Set(
        (
          await db
            .select({ id: schema.accountingBankAccountSettings.bankAccountId })
            .from(schema.accountingBankAccountSettings)
            .where(inArray(schema.accountingBankAccountSettings.bankAccountId, ids))
        ).map((r) => r.id),
      )
    : new Set<string>();
  return rows.map((row) => ({
    id: row.id,
    entityId: row.entityId,
    name: row.name,
    accountHolderName: row.accountHolderName ?? null,
    iban: row.iban ?? null,
    bic: row.bic ?? null,
    bankName: row.bankName ?? null,
    currency: row.currency ?? null,
    accountType: row.accountType ?? null,
    routingNumber: row.routingNumber ?? null,
    accountNumberLast4: row.accountNumberLast4 ?? null,
    hasAccountNumber: Boolean(row.accountNumberEncrypted),
    achSettings: row.achSettings ?? null,
    isDefault: Boolean(row.isDefault),
    isActive: row.isActive !== false,
    inWeldbooks: inBooks.has(row.id),
    createdAt: iso(row.createdAt) ?? '',
    updatedAt: iso(row.updatedAt) ?? '',
  }));
}

export async function listBankAccounts(db: Database, entityId: string): Promise<LegalEntityBankAccount[]> {
  await requireEntityRow(db, entityId);
  const rows = await db
    .select()
    .from(schema.bankAccounts)
    .where(and(eq(schema.bankAccounts.entityId, entityId), isNull(schema.bankAccounts.deletedAt)))
    .orderBy(desc(schema.bankAccounts.isDefault), asc(schema.bankAccounts.name));
  return toBankAccounts(db, rows);
}

async function requireBankAccount(db: Database, entityId: string, accountId: string): Promise<BankAccountRow> {
  const [row] = await db
    .select()
    .from(schema.bankAccounts)
    .where(and(eq(schema.bankAccounts.id, accountId), eq(schema.bankAccounts.entityId, entityId), isNull(schema.bankAccounts.deletedAt)))
    .limit(1);
  if (!row) throw new LegalEntityError('NOT_FOUND', 'Bank account not found');
  return row;
}

/** Release 1 mirror: re-seal `hr_payroll_employers.bank_encrypted` for employers paying from this account. */
async function mirrorBankAccountToEmployers(db: Database, env: KeyEnv, row: BankAccountRow): Promise<void> {
  const employers = await db
    .select({ id: schema.hrPayrollEmployers.id, bankEncrypted: schema.hrPayrollEmployers.bankEncrypted })
    .from(schema.hrPayrollEmployers)
    .where(eq(schema.hrPayrollEmployers.bankAccountId, row.id));
  if (employers.length === 0) return;
  const keyring = requireKeyring(env);
  const accountNumber = row.accountNumberEncrypted ? await decryptField(row.accountNumberEncrypted, keyring) : null;
  const ach = (row.achSettings ?? {}) as Record<string, unknown>;
  for (const employer of employers) {
    let previous: HrPayrollEmployerBank = {};
    if (employer.bankEncrypted) {
      try {
        previous = JSON.parse(await decryptField(employer.bankEncrypted, keyring)) as HrPayrollEmployerBank;
      } catch {
        previous = {};
      }
    }
    const next: HrPayrollEmployerBank = {
      ...previous,
      accountHolder: row.accountHolderName ?? null,
      iban: row.iban ?? null,
      bic: row.bic ?? null,
      routingNumber: row.routingNumber ?? null,
      accountNumber,
      accountType: row.accountType === 'savings' ? 'savings' : row.accountType === 'checking' ? 'checking' : previous.accountType ?? null,
      bankName: row.bankName ?? null,
      nachaCompanyId: typeof ach.companyIdentification === 'string' ? ach.companyIdentification : previous.nachaCompanyId ?? null,
    };
    await db
      .update(schema.hrPayrollEmployers)
      .set({ bankEncrypted: await encryptField(JSON.stringify(next), keyring), updatedAt: new Date() })
      .where(eq(schema.hrPayrollEmployers.id, employer.id));
  }
}

async function clearOtherDefaultAccounts(db: Database, row: BankAccountRow): Promise<void> {
  await db
    .update(schema.bankAccounts)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(eq(schema.bankAccounts.entityId, row.entityId), ne(schema.bankAccounts.id, row.id), eq(schema.bankAccounts.isDefault, true)));
}

export async function createBankAccount(
  db: Database,
  env: KeyEnv,
  entityId: string,
  input: CreateBankAccountInput,
): Promise<LegalEntityBankAccount> {
  const entity = await requireEntityRow(db, entityId);
  const sealed = input.accountNumber
    ? { accountNumberEncrypted: await encryptField(input.accountNumber, requireKeyring(env)), accountNumberLast4: input.accountNumber.slice(-4) }
    : {};
  const [row] = await db
    .insert(schema.bankAccounts)
    .values({
      id: generateId('ba'),
      entityId,
      name: input.name,
      accountHolderName: input.accountHolderName ?? entity.legalName ?? entity.name,
      iban: input.iban || null,
      bic: input.bic || null,
      bankName: input.bankName ?? null,
      currency: input.currency ?? entity.baseCurrency,
      accountType: input.accountType ?? null,
      routingNumber: input.routingNumber || null,
      achSettings: input.achSettings ?? null,
      isDefault: input.isDefault ?? false,
      isActive: input.isActive ?? true,
      ...sealed,
    })
    .returning();
  if (row.isDefault) await clearOtherDefaultAccounts(db, row);
  const [account] = await toBankAccounts(db, [row]);
  return account;
}

export async function updateBankAccount(
  db: Database,
  env: KeyEnv,
  entityId: string,
  accountId: string,
  input: UpdateBankAccountInput,
): Promise<LegalEntityBankAccount> {
  await requireBankAccount(db, entityId, accountId);
  const patch: Partial<BankAccountRow> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.accountHolderName !== undefined) patch.accountHolderName = input.accountHolderName ?? null;
  if (input.iban !== undefined) patch.iban = input.iban || null;
  if (input.bic !== undefined) patch.bic = input.bic || null;
  if (input.bankName !== undefined) patch.bankName = input.bankName ?? null;
  if (input.currency !== undefined) patch.currency = input.currency;
  if (input.accountType !== undefined) patch.accountType = input.accountType ?? null;
  if (input.routingNumber !== undefined) patch.routingNumber = input.routingNumber || null;
  if (input.achSettings !== undefined) patch.achSettings = input.achSettings ?? null;
  if (input.isDefault !== undefined) patch.isDefault = input.isDefault;
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  if (input.accountNumber !== undefined) {
    if (input.accountNumber) {
      patch.accountNumberEncrypted = await encryptField(input.accountNumber, requireKeyring(env));
      patch.accountNumberLast4 = input.accountNumber.slice(-4);
    } else {
      patch.accountNumberEncrypted = null;
      patch.accountNumberLast4 = null;
    }
  }
  const [row] = await db.update(schema.bankAccounts).set(patch).where(eq(schema.bankAccounts.id, accountId)).returning();
  if (row.isDefault) await clearOtherDefaultAccounts(db, row);
  await mirrorBankAccountToEmployers(db, env, row);
  const [account] = await toBankAccounts(db, [row]);
  return account;
}

/** Soft delete. Refused while WeldBooks or WeldHR uses the account. */
export async function deleteBankAccount(db: Database, entityId: string, accountId: string): Promise<void> {
  const row = await requireBankAccount(db, entityId, accountId);
  const [books] = await db
    .select({ id: schema.accountingBankAccountSettings.bankAccountId })
    .from(schema.accountingBankAccountSettings)
    .where(eq(schema.accountingBankAccountSettings.bankAccountId, row.id))
    .limit(1);
  if (books) throw new LegalEntityError('CONFLICT', 'This account is in WeldBooks; remove it there first');
  const [employer] = await db
    .select({ id: schema.hrPayrollEmployers.id })
    .from(schema.hrPayrollEmployers)
    .where(and(eq(schema.hrPayrollEmployers.bankAccountId, row.id), isNull(schema.hrPayrollEmployers.deletedAt)))
    .limit(1);
  if (employer) throw new LegalEntityError('CONFLICT', 'WeldHR pays salaries from this account; change the payroll setup first');
  const [invoiceAccount] = await db
    .select({ id: schema.accountingEntitySettings.entityId })
    .from(schema.accountingEntitySettings)
    .where(eq(schema.accountingEntitySettings.invoiceBankAccountId, row.id))
    .limit(1);
  if (invoiceAccount) throw new LegalEntityError('CONFLICT', 'WeldBooks prints this account on invoices; pick another one first');
  await db
    .update(schema.bankAccounts)
    .set({ deletedAt: new Date(), isActive: false, isDefault: false, updatedAt: new Date() })
    .where(eq(schema.bankAccounts.id, row.id));
}

/** Decrypt the full number for an authorised reveal. Logged in `tax_id_reveals` first; a failed log refuses the reveal. */
export async function revealBankAccountNumber(
  db: Database,
  env: KeyEnv,
  args: { entityId: string; accountId: string; userId: string; reason?: string | null },
): Promise<{ accountNumber: string; routingNumber: string | null }> {
  const account = await requireBankAccount(db, args.entityId, args.accountId);
  if (!account.accountNumberEncrypted) throw new LegalEntityError('BAD_REQUEST', 'This bank account has no account number on file');
  const keyring = requireKeyring(env);
  await db.insert(schema.taxIdReveals).values({
    id: generateId('tir'),
    entityId: account.entityId,
    subjectType: 'bank_account',
    subjectId: account.id,
    field: 'account_number',
    revealedBy: args.userId,
    reason: args.reason?.slice(0, 255) ?? null,
  });
  return { accountNumber: await decryptField(account.accountNumberEncrypted, keyring), routingNumber: account.routingNumber ?? null };
}

// ---------------------------------------------------------------------------
// Per-entity access management
// ---------------------------------------------------------------------------

function systemRoleName(role: string): string | null {
  return SYSTEM_ROLES[role.toUpperCase()]?.name ?? null;
}

export async function getEntityAccessList(db: Database, entityId: string): Promise<LegalEntityAccess> {
  const entity = await requireEntityRow(db, entityId);
  const m = schema.legalEntityMembers;
  const w = schema.workspaceMembers;
  const rows = await db
    .select({
      userId: m.userId,
      roleId: m.roleId,
      grantedBy: m.grantedBy,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      name: w.name,
      email: w.email,
      picture: w.picture,
      workspaceRole: w.role,
      workspaceRoleId: w.roleId,
    })
    .from(m)
    .leftJoin(w, and(eq(w.userId, m.userId), isNull(w.deletedAt)))
    .where(eq(m.entityId, entityId))
    .orderBy(asc(w.name), asc(m.createdAt));
  const names = await roleNames(db, [
    ...new Set(rows.flatMap((r) => [r.roleId, r.workspaceRoleId]).filter((id): id is string => Boolean(id))),
  ]);
  return {
    entityId,
    restricted: Boolean(entity.accessRestricted),
    members: rows.map((r) => ({
      userId: r.userId,
      name: r.name ?? null,
      email: r.email ?? null,
      picture: r.picture ?? null,
      workspaceRole: r.workspaceRole ?? '',
      workspaceRoleName: (r.workspaceRoleId && names.get(r.workspaceRoleId)) || systemRoleName(r.workspaceRole ?? ''),
      roleId: r.roleId ?? null,
      roleName: r.roleId ? (names.get(r.roleId) ?? null) : null,
      grantedBy: r.grantedBy ?? null,
      createdAt: iso(r.createdAt) ?? '',
      updatedAt: iso(r.updatedAt) ?? '',
    })),
  };
}

export async function setEntityRestricted(db: Database, entityId: string, restricted: boolean): Promise<EntityRow> {
  await requireEntityRow(db, entityId);
  const [row] = await db
    .update(schema.legalEntities)
    .set({ accessRestricted: restricted, updatedAt: new Date() })
    .where(eq(schema.legalEntities.id, entityId))
    .returning();
  return row;
}

/**
 * Add a member to an entity or change their role there. The user must be an
 * active internal member (EMPLOYEE members only have My HR); the role must be
 * a live role of the workspace and never Owner.
 */
export async function setEntityMember(
  db: Database,
  args: { entityId: string; userId: string; roleId: string | null; grantedBy: string },
): Promise<{ created: boolean; member: typeof schema.legalEntityMembers.$inferSelect }> {
  await requireEntityRow(db, args.entityId);
  const [member] = await db
    .select({ role: schema.workspaceMembers.role, status: schema.workspaceMembers.status, memberType: schema.workspaceMembers.memberType })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.userId, args.userId), isNull(schema.workspaceMembers.deletedAt)))
    .limit(1);
  if (!member || member.status !== 'ACTIVE') throw new LegalEntityError('BAD_REQUEST', 'This person is not an active member of the workspace');
  if (member.memberType === 'EMPLOYEE' || member.memberType === 'EXTERNAL_GUEST') {
    throw new LegalEntityError('BAD_REQUEST', 'Employee members and guests cannot be given access to a legal entity');
  }
  if (args.roleId) {
    const [role] = await db
      .select({ name: schema.roles.name, isSystem: schema.roles.isSystem })
      .from(schema.roles)
      .where(and(eq(schema.roles.id, args.roleId), isNull(schema.roles.deletedAt)))
      .limit(1);
    if (!role) throw new LegalEntityError('BAD_REQUEST', 'Role not found');
    if (role.isSystem && role.name.toUpperCase() === 'OWNER') {
      throw new LegalEntityError('BAD_REQUEST', 'The Owner role cannot be given per legal entity');
    }
  }

  const m = schema.legalEntityMembers;
  const [existing] = await db
    .select()
    .from(m)
    .where(and(eq(m.entityId, args.entityId), eq(m.userId, args.userId)))
    .limit(1);
  if (existing) {
    const [row] = await db
      .update(m)
      .set({ roleId: args.roleId, grantedBy: args.grantedBy, updatedAt: new Date() })
      .where(eq(m.id, existing.id))
      .returning();
    return { created: false, member: row };
  }
  const [row] = await db
    .insert(m)
    .values({ id: generateId('lem'), entityId: args.entityId, userId: args.userId, roleId: args.roleId, grantedBy: args.grantedBy })
    .returning();
  return { created: true, member: row };
}

export async function removeEntityMember(
  db: Database,
  entityId: string,
  userId: string,
): Promise<typeof schema.legalEntityMembers.$inferSelect | null> {
  const m = schema.legalEntityMembers;
  const [row] = await db.delete(m).where(and(eq(m.entityId, entityId), eq(m.userId, userId))).returning();
  return row ?? null;
}

/** The signed-in member's effective access inside one entity, or null when they do not see it. */
export async function myEffectiveAccess(
  db: Database,
  access: EntityAccess,
  entityId: string,
): Promise<LegalEntityEffectiveAccess | null> {
  if (!canSeeEntity(access, entityId)) return null;
  const roleId = entityRoleId(access, entityId);
  const resolved = await permissionsInEntity(db, access, entityId);
  const names = await roleNames(db, roleId ? [roleId] : []);
  return {
    entityId,
    source: entityAccessSource(access, entityId),
    roleId,
    roleName: roleId ? (names.get(roleId) ?? null) : null,
    permissions: resolved.permissions,
    denies: resolved.denies ?? [],
    isOwner: resolved.isOwner,
  };
}
