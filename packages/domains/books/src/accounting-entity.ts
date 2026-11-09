/**
 * The accounting view of a legal entity (docs/plans/legal-entities.md).
 *
 * Release 1 keeps the WeldBooks columns on `entities` AND on the extension
 * (`accounting_entity_settings`), and every writer mirrors to both. Readers
 * that load the entity centrally go through here: the result has today's
 * `Entity` shape, with the extension's values preferred over the old columns,
 * the document texts from `document_texts`, and the tax identifiers from the
 * primary registrations. Release 2 drops the old columns; the shape stays.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { decryptField, keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { schema, type Database } from '@weldsuite/worker-kit/db';

export type AccountingEntityRow = typeof schema.legalEntities.$inferSelect;
type SettingsRow = typeof schema.accountingEntitySettings.$inferSelect;
type RegistrationRow = typeof schema.legalEntityRegistrations.$inferSelect;

/** Today's `Entity` plus the account printed on invoices. */
export type AccountingEntity = AccountingEntityRow & {
  /** `accounting_entity_settings.invoice_bank_account_id`: the core bank account invoices print. */
  invoiceBankAccountId: string | null;
  /** WeldBooks is enabled for the entity (it has an extension row). */
  weldbooksEnabled: boolean;
};

/** The five lock dates of an entity (YYYY-MM-DD or null). */
export interface EntityLockDates {
  salesLockDate: string | null;
  purchaseLockDate: string | null;
  taxLockDate: string | null;
  periodLockDate: string | null;
  hardLockDate: string | null;
}

/** A value the extension holds, else the one still on the old column. */
function prefer<T>(extension: T | null | undefined, legacy: T | null | undefined): T | null {
  return extension ?? legacy ?? null;
}

/** The primary registration of a type, which is the number invoices and returns print. */
function primaryNumber(registrations: readonly RegistrationRow[], ...types: string[]): string | undefined {
  for (const type of types) {
    const row = registrations.find((r) => r.type === type && r.isPrimary);
    if (row) return row.number;
  }
  return undefined;
}

/** Pure: today's `Entity` from the core row, the extension row and the entity's primary registrations. */
export function mergeAccountingEntity(
  row: AccountingEntityRow,
  settings: SettingsRow | null,
  registrations: readonly RegistrationRow[],
): AccountingEntity {
  const legacyIds = row.taxIdentifiers ?? {};
  const vat = primaryNumber(registrations, row.jurisdictionCode.toUpperCase().startsWith('IN') ? 'gstin' : 'vat');
  const taxIdentifiers = {
    ...legacyIds,
    ...(vat ? { vatNumber: vat } : {}),
    ...(primaryNumber(registrations, 'company_registration') ? { registrationNumber: primaryNumber(registrations, 'company_registration') } : {}),
    ...(primaryNumber(registrations, 'ein') ? { einOrSsn: primaryNumber(registrations, 'ein') } : {}),
  };
  const texts = settings?.documentTexts ?? {};
  const branding = row.branding ?? null;
  const mergedBranding =
    branding || Object.keys(texts).length > 0 ? { ...(branding ?? {}), ...texts } : branding;

  return {
    ...row,
    taxIdentifiers: Object.keys(taxIdentifiers).length > 0 ? taxIdentifiers : row.taxIdentifiers,
    branding: mergedBranding,
    salesLockDate: prefer(settings?.salesLockDate, row.salesLockDate),
    purchaseLockDate: prefer(settings?.purchaseLockDate, row.purchaseLockDate),
    taxLockDate: prefer(settings?.taxLockDate, row.taxLockDate),
    periodLockDate: prefer(settings?.periodLockDate, row.periodLockDate),
    hardLockDate: prefer(settings?.hardLockDate, row.hardLockDate),
    accountingMethod: prefer(settings?.accountingMethod, row.accountingMethod),
    salesTaxEngine: prefer(settings?.salesTaxEngine, row.salesTaxEngine),
    salesTaxEngineConfig: prefer(settings?.salesTaxEngineConfig, row.salesTaxEngineConfig),
    salesTaxCredentialsEncrypted: prefer(settings?.salesTaxCredentialsEncrypted, row.salesTaxCredentialsEncrypted),
    fiscalCredentialsEncrypted: prefer(settings?.fiscalCredentialsEncrypted, row.fiscalCredentialsEncrypted),
    ssnEncrypted: prefer(settings?.ssnEncrypted, row.ssnEncrypted),
    ssnLast4: prefer(settings?.ssnLast4, row.ssnLast4),
    jurisdictionSettings: prefer(settings?.jurisdictionSettings, row.jurisdictionSettings),
    invoiceBankAccountId: settings?.invoiceBankAccountId ?? null,
    weldbooksEnabled: settings !== null,
  };
}

/** Entities by id (deleted ones included only with `includeDeleted`), merged. Order follows `ids`. */
export async function loadAccountingEntities(
  db: Database,
  ids: readonly string[],
  options: { includeDeleted?: boolean } = {},
): Promise<AccountingEntity[]> {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)];
  const conditions = [inArray(schema.legalEntities.id, unique)];
  if (!options.includeDeleted) conditions.push(isNull(schema.legalEntities.deletedAt));
  const rows = await db.select().from(schema.legalEntities).where(and(...conditions));
  if (rows.length === 0) return [];
  const found = rows.map((r) => r.id);
  const [settings, registrations] = await Promise.all([
    db.select().from(schema.accountingEntitySettings).where(inArray(schema.accountingEntitySettings.entityId, found)),
    db
      .select()
      .from(schema.legalEntityRegistrations)
      .where(
        and(
          inArray(schema.legalEntityRegistrations.entityId, found),
          eq(schema.legalEntityRegistrations.isPrimary, true),
          isNull(schema.legalEntityRegistrations.deletedAt),
        ),
      ),
  ]);
  const byId = new Map(
    rows.map((row) => [
      row.id,
      mergeAccountingEntity(
        row,
        settings.find((s) => s.entityId === row.id) ?? null,
        registrations.filter((r) => r.entityId === row.id),
      ),
    ]),
  );
  return unique.map((id) => byId.get(id)).filter((e): e is AccountingEntity => e !== undefined);
}

/** One entity in today's shape, or null when it is unknown or deleted. */
export async function loadAccountingEntity(db: Database, id: string): Promise<AccountingEntity | null> {
  const [entity] = await loadAccountingEntities(db, [id]);
  return entity ?? null;
}

/** The lock dates (extension values first), one query. Null when the entity does not exist. */
export async function loadEntityLockDates(db: Database, entityId: string): Promise<EntityLockDates | null> {
  const [row] = await db
    .select({
      core: {
        salesLockDate: schema.legalEntities.salesLockDate,
        purchaseLockDate: schema.legalEntities.purchaseLockDate,
        taxLockDate: schema.legalEntities.taxLockDate,
        periodLockDate: schema.legalEntities.periodLockDate,
        hardLockDate: schema.legalEntities.hardLockDate,
      },
      ext: {
        salesLockDate: schema.accountingEntitySettings.salesLockDate,
        purchaseLockDate: schema.accountingEntitySettings.purchaseLockDate,
        taxLockDate: schema.accountingEntitySettings.taxLockDate,
        periodLockDate: schema.accountingEntitySettings.periodLockDate,
        hardLockDate: schema.accountingEntitySettings.hardLockDate,
      },
    })
    .from(schema.legalEntities)
    .leftJoin(schema.accountingEntitySettings, eq(schema.accountingEntitySettings.entityId, schema.legalEntities.id))
    .where(eq(schema.legalEntities.id, entityId))
    .limit(1);
  if (!row) return null;
  return {
    salesLockDate: prefer(row.ext?.salesLockDate, row.core.salesLockDate),
    purchaseLockDate: prefer(row.ext?.purchaseLockDate, row.core.purchaseLockDate),
    taxLockDate: prefer(row.ext?.taxLockDate, row.core.taxLockDate),
    periodLockDate: prefer(row.ext?.periodLockDate, row.core.periodLockDate),
    hardLockDate: prefer(row.ext?.hardLockDate, row.core.hardLockDate),
  };
}

/** The sales tax engine columns (extension values first), one query. Null when the entity does not exist. */
export async function loadSalesTaxEngineSettings(
  db: Database,
  entityId: string,
): Promise<{ engine: string | null; config: Record<string, unknown> | null; credentials: string | null } | null> {
  const [row] = await db
    .select({
      core: {
        engine: schema.legalEntities.salesTaxEngine,
        config: schema.legalEntities.salesTaxEngineConfig,
        credentials: schema.legalEntities.salesTaxCredentialsEncrypted,
      },
      ext: {
        engine: schema.accountingEntitySettings.salesTaxEngine,
        config: schema.accountingEntitySettings.salesTaxEngineConfig,
        credentials: schema.accountingEntitySettings.salesTaxCredentialsEncrypted,
      },
    })
    .from(schema.legalEntities)
    .leftJoin(schema.accountingEntitySettings, eq(schema.accountingEntitySettings.entityId, schema.legalEntities.id))
    .where(eq(schema.legalEntities.id, entityId))
    .limit(1);
  if (!row) return null;
  return {
    engine: prefer(row.ext?.engine, row.core.engine),
    config: prefer(row.ext?.config, row.core.config),
    credentials: prefer(row.ext?.credentials, row.core.credentials),
  };
}

/**
 * Release 1 write side: upsert the extension row with `values`. The caller
 * writes the same values to the old `entities` columns (the mirror).
 */
export async function upsertAccountingEntitySettings(
  db: Database,
  entityId: string,
  values: Partial<Omit<typeof schema.accountingEntitySettings.$inferInsert, 'entityId' | 'createdAt' | 'updatedAt'>>,
): Promise<void> {
  const now = new Date();
  await db
    .insert(schema.accountingEntitySettings)
    .values({ entityId, ...values, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.accountingEntitySettings.entityId,
      set: { ...values, updatedAt: now },
    });
}

/**
 * The entity as invoices render it: `loadAccountingEntity`, with the bank
 * details taken from the core account at `invoice_bank_account_id` when one is
 * set (else today's `entities.bank_details`). An account number is only
 * printed when `keyEnv` can decrypt it.
 */
export async function loadInvoiceEntity(
  db: Database,
  id: string,
  keyEnv?: { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string },
): Promise<AccountingEntity | null> {
  const entity = await loadAccountingEntity(db, id);
  if (!entity?.invoiceBankAccountId) return entity;
  const [account] = await db
    .select()
    .from(schema.bankAccounts)
    .where(and(eq(schema.bankAccounts.id, entity.invoiceBankAccountId), isNull(schema.bankAccounts.deletedAt)))
    .limit(1);
  if (!account) return entity;
  let accountNumber: string | undefined;
  if (account.accountNumberEncrypted && keyEnv) {
    const keyring = keyringFromEnv(keyEnv);
    if (keyring.v1 || keyring.v2) accountNumber = await decryptField(account.accountNumberEncrypted, keyring);
  }
  return {
    ...entity,
    bankDetails: {
      ...(account.iban && { iban: account.iban }),
      ...(account.bic && { bic: account.bic }),
      ...(account.bankName && { bankName: account.bankName }),
      ...(account.routingNumber && { routingNumber: account.routingNumber }),
      ...(accountNumber && { accountNumber }),
    },
  };
}
