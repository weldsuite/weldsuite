/**
 * Entity routes — flat /api/accounting-entities/* surface backed by `entities`.
 *
 * Entity creation is jurisdiction-aware: the adapter for the entity's
 * country seeds a localized chart of accounts, standard tax rates (with
 * rubriek metadata for the BTW return), and per-entity number sequences.
 * Unsupported jurisdictions are rejected — see services/jurisdictions/.
 * Tax identifiers are checked with the adapter's `validateTaxIdentifier`,
 * and addresses are stored in the shared `PostalAddress` shape (either
 * shape is accepted on input).
 *
 * US entities (docs/plans/weldbooks-us.md §11) also take: `entityType` and
 * `taxClassification` (an LLC may elect S or C corporation status), `dba`,
 * `accountingMethod` (the default basis of every report), a month-based
 * `fiscalYearStart` or a 52–53-week `fiscalYearConfig`, the EIN in
 * `taxIdentifiers.einOrSsn`, and a write-only `ssn` for a sole proprietor
 * without an EIN. The SSN is encrypted into `ssnEncrypted` and never returned
 * (only `ssnLast4` and `hasSsn`); `POST /:id/reveal-ssn` needs
 * `tax_ids:reveal` and writes an append-only `tax_id_reveals` row first.
 * Seeding passes the type and classification to the chart template, which
 * adds the matching equity section; accounts get their income-tax line
 * (`accounts.tax_line`) and 1099 box. `POST /:id/apply-tax-lines` re-maps the
 * lines after the classification changes.
 *
 * Lock dates (`PATCH /:id/lock-dates`) and their logged, time-limited
 * per-user exceptions (`/:id/lock-exceptions`) are set here; the posting
 * service enforces them.
 *
 * Permissions: entities:read | entities:create | entities:update | entities:delete,
 * accounts:update (apply-tax-lines), tax_ids:reveal (reveal-ssn).
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, lte, or } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { decryptField, encryptField, keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { ALL_SENSITIVE_KEYS } from '@weldsuite/db/lib/sensitive-columns';
import { getAdapter, hasAdapter, listJurisdictions } from '@weldsuite/books-domain/jurisdictions/registry';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { normalizePostalAddress } from '@weldsuite/books-domain/accounting-address';
import { isValidIban } from '@weldsuite/books-domain/identifiers';
import {
  extractStateCodeFromGstin,
  isValidGstStateCode,
  validateGstin,
} from '@weldsuite/books-domain/jurisdictions/in';
import { US_ENTITY_TYPE_INFO, US_ENTITY_TYPES, taxFormForClassification } from '@weldsuite/books-domain/jurisdictions/us/entity-types';
import { maskTin, tinLast4 } from '@weldsuite/books-domain/jurisdictions/us/identifiers';
import { TAX_FORM_LABELS } from '@weldsuite/books-domain/jurisdictions/us/tax-lines';
import {
  EntitySetupError,
  applyTaxLines,
  buildSeedAccounts,
  checkSsn,
  checkUsAddress,
  defaultUsTimeZone,
  formOfEntity,
  looksLikeSsn,
  resolveEntityKind,
  taxYearOf,
} from '../../services/accounting-entity-setup';
import { getEntityLockState } from '../../services/accounting-entity-lock';
import { normalizeBrAddress, normalizeBrSettings, syncBrTaxProfiles } from '../../services/br-entity-setup';
import type { StoredPostalAddress } from '@weldsuite/db/schema';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

type TaxIdentifiers = {
  vatNumber?: string;
  registrationNumber?: string;
  einOrSsn?: string;
  other?: Record<string, string>;
};

const VALIDATED_TAX_IDS = ['vatNumber', 'registrationNumber', 'einOrSsn'] as const;
type ValidatedTaxId = (typeof VALIDATED_TAX_IDS)[number];

/**
 * The identifiers the adapter checks. The US adapter takes the EIN in both
 * `vatNumber` (the slot invoices print) and `einOrSsn`, and a state tax ID in
 * `registrationNumber`.
 */
function validatedFieldsFor(jurisdictionCode: string): readonly ValidatedTaxId[] {
  return jurisdictionCode.toUpperCase() === 'US' ? ['vatNumber', 'registrationNumber', 'einOrSsn'] : ['vatNumber', 'registrationNumber'];
}

/**
 * Check the tax identifiers a request touched with the jurisdiction adapter
 * and store them in the adapter's canonical format. A blank value clears the
 * identifier. Untouched identifiers are left alone, so a stale value saved
 * before validation existed doesn't block an unrelated edit.
 */
function validateTaxIdentifiersWithAdapter(
  jurisdictionCode: string,
  taxIdentifiers: TaxIdentifiers | null | undefined,
  touched: ReadonlySet<ValidatedTaxId>,
): { error?: string; taxIdentifiers?: TaxIdentifiers } {
  if (!taxIdentifiers || touched.size === 0) return { taxIdentifiers: taxIdentifiers ?? undefined };
  const adapter = getAdapter(jurisdictionCode);
  const next: TaxIdentifiers = { ...taxIdentifiers };
  for (const field of validatedFieldsFor(jurisdictionCode)) {
    if (!touched.has(field)) continue;
    const value = next[field];
    if (value === undefined) continue;
    if (value.trim() === '') {
      delete next[field];
      continue;
    }
    const check = adapter.validateTaxIdentifier(field, value);
    if (!check.valid) {
      return { error: check.error ?? `Invalid ${field}` };
    }
    const formatted = check.formatted ?? value.trim();
    // A Social Security number never goes in the plain-text identifiers.
    if (field === 'einOrSsn' && looksLikeSsn(formatted)) {
      return { error: 'Enter a Social Security number in the ssn field; the EIN field takes an EIN (XX-XXXXXXX)' };
    }
    next[field] = formatted;
  }

  // A US entity has one EIN, kept in both slots.
  if (jurisdictionCode.toUpperCase() === 'US' && (touched.has('einOrSsn') || touched.has('vatNumber'))) {
    const given = [touched.has('einOrSsn') ? next.einOrSsn : undefined, touched.has('vatNumber') ? next.vatNumber : undefined].filter(
      (v): v is string => Boolean(v),
    );
    if (given.length === 2 && given[0] !== given[1]) {
      return { error: 'vatNumber and einOrSsn hold the same EIN for a US entity' };
    }
    if (given[0]) {
      next.einOrSsn = given[0];
      next.vatNumber = given[0];
    } else {
      delete next.einOrSsn;
      delete next.vatNumber;
    }
  }
  return { taxIdentifiers: next };
}

/** Which validated tax identifiers a create/update body sets. */
function touchedTaxIdentifiers(
  taxIdentifiers: Partial<Record<ValidatedTaxId, string>> | undefined,
  vatAlias: string | undefined,
): Set<ValidatedTaxId> {
  const touched = new Set<ValidatedTaxId>();
  for (const field of VALIDATED_TAX_IDS) {
    if (taxIdentifiers?.[field] !== undefined) touched.add(field);
  }
  if (vatAlias !== undefined) touched.add('vatNumber');
  return touched;
}

function unsupportedJurisdictionMessage(code: string): string {
  return `Jurisdiction '${code}' is not supported. Supported: ${listJurisdictions().map((j) => j.code).join(', ')}`;
}

/**
 * The GSTIN of an Indian entity: checked in full (and stored normalized) when `check` is set, otherwise
 * only mined for its state code. Returns the settings with the state code set.
 */
function applyGstin(
  taxIdentifiers: TaxIdentifiers,
  gstin: string,
  jurisdictionSettings: Record<string, unknown>,
  check: boolean,
): { error?: string; jurisdictionSettings: Record<string, unknown> } {
  if (!check) {
    const stateCode = gstin ? extractStateCodeFromGstin(gstin) : undefined;
    return {
      jurisdictionSettings: stateCode && isValidGstStateCode(stateCode) ? { ...jurisdictionSettings, stateCode } : jurisdictionSettings,
    };
  }
  const result = validateGstin(gstin, { pan: taxIdentifiers.registrationNumber });
  if (!result.valid) return { error: result.error ?? 'Invalid GSTIN', jurisdictionSettings };
  taxIdentifiers.vatNumber = result.formatted;
  const stateCode = extractStateCodeFromGstin(result.formatted!);
  return { jurisdictionSettings: stateCode ? { ...jurisdictionSettings, stateCode } : jurisdictionSettings };
}

/**
 * Validate/normalize India GSTIN and derive jurisdictionSettings.stateCode.
 * Returns an error message when GSTIN is present but invalid.
 */
function applyIndiaTaxIdentifiers(opts: {
  jurisdictionCode: string;
  taxIdentifiers?: TaxIdentifiers | null;
  jurisdictionSettings?: Record<string, unknown> | null;
  timezone?: string | null;
  /**
   * Run the full GSTIN check (check digit, state code, PAN match). False on an
   * update that touches neither the GSTIN nor the PAN, so a number saved before
   * the check existed doesn't block an unrelated edit.
   */
  checkGstin?: boolean;
}): {
  error?: string;
  taxIdentifiers?: TaxIdentifiers;
  jurisdictionSettings?: Record<string, unknown>;
  timezone?: string;
} {
  if (opts.jurisdictionCode.toUpperCase() !== 'IN') {
    return {
      taxIdentifiers: opts.taxIdentifiers ?? undefined,
      jurisdictionSettings: opts.jurisdictionSettings ?? undefined,
      timezone: opts.timezone ?? undefined,
    };
  }

  let jurisdictionSettings = opts.jurisdictionSettings ? { ...opts.jurisdictionSettings } : {};
  const taxIdentifiers = opts.taxIdentifiers ? { ...opts.taxIdentifiers } : undefined;
  const timezone = opts.timezone ?? 'Asia/Kolkata';
  const gstin = taxIdentifiers?.vatNumber;
  // Field presence (including '') must be validated — empty GSTIN would leave a stale stateCode
  if (taxIdentifiers && gstin !== undefined) {
    const applied = applyGstin(taxIdentifiers, gstin, jurisdictionSettings, opts.checkGstin !== false);
    if (applied.error) return { error: applied.error };
    jurisdictionSettings = applied.jurisdictionSettings;
  }
  return {
    taxIdentifiers,
    jurisdictionSettings: Object.keys(jurisdictionSettings).length > 0 ? jurisdictionSettings : undefined,
    timezone,
  };
}

/**
 * Either address shape: the shared `PostalAddress` (line1, line2, city,
 * state, postalCode, country, county) or the legacy Dutch one (street +
 * houseNumber, province). Stored normalized to the shared shape.
 */
const addressSchema = z.object({
  line1: z.string().max(255),
  line2: z.string().max(255),
  city: z.string().max(100),
  state: z.string().max(100),
  postalCode: z.string().max(20),
  country: z.string().max(100),
  county: z.string().max(100),
  street: z.string().max(255),
  houseNumber: z.string().max(20),
  province: z.string().max(100),
}).partial();

const taxIdentifiersSchema = z.object({
  vatNumber: z.string().optional(),
  registrationNumber: z.string().optional(),
  einOrSsn: z.string().optional(),
  other: z.record(z.string()).optional(),
}).partial();

const contactSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().optional(),
  website: z.string().optional(),
}).partial();

const bankDetailsSchema = z.object({
  iban: z
    .string()
    .refine((value) => value.trim() === '' || isValidIban(value), { message: 'Not a valid IBAN (length for the country and check digits)' })
    .optional(),
  bic: z.string().optional(),
  accountNumber: z.string().optional(),
  routingNumber: z.string().optional(),
  bankName: z.string().optional(),
}).partial();

const brandingSchema = z.object({
  logoUrl: z.string().optional(),
  primaryColor: z.string().optional(),
  accentColor: z.string().optional(),
  footerText: z.string().optional(),
  paymentInstructions: z.string().optional(),
  termsAndConditions: z.string().optional(),
}).partial();

/** A 52–53-week year: ends on the last (or nearest) `weekday` of `endMonth`. */
const fiscalYearConfigSchema = z.object({
  type: z.literal('fifty_two_fifty_three'),
  endMonth: z.number().int().min(1).max(12),
  /** 0 = Sunday … 6 = Saturday */
  weekday: z.number().int().min(0).max(6),
  rule: z.enum(['last', 'nearest']),
});

const createEntitySchema = z.object({
  name: z.string().min(1).max(255),
  legalName: z.string().max(255).optional(),
  /** US: sole_proprietorship | single_member_llc | multi_member_llc | partnership | s_corp | c_corp | nonprofit. */
  entityType: z.string().max(20).optional(),
  /** US: sole_proprietor | disregarded | partnership | s_corp | c_corp | exempt. Defaults from the entity type. */
  taxClassification: z.string().max(20).optional(),
  /** Doing-business-as name. */
  dba: z.string().max(255).nullable().optional(),
  /** Default basis of the entity's reports; null = the workspace setting. */
  accountingMethod: z.enum(['accrual', 'cash']).nullable().optional(),
  jurisdictionCode: z.string().min(2).max(5).optional(),
  /** Shared-schema alias for jurisdictionCode. */
  jurisdiction: z.string().min(2).max(5).optional(),
  /** Top-level convenience alias — merged into taxIdentifiers.vatNumber. */
  vatNumber: z.string().max(50).optional(),
  baseCurrency: z.string().length(3).optional(),
  locale: z.string().max(10).optional(),
  timezone: z.string().max(50).optional(),
  taxIdentifiers: taxIdentifiersSchema.optional(),
  /** US: Social Security number of a sole proprietor without an EIN. Write-only; null clears it. */
  ssn: z.string().max(20).nullable().optional(),
  address: addressSchema.nullable().optional(),
  contact: contactSchema.optional(),
  bankDetails: bankDetailsSchema.optional(),
  branding: brandingSchema.optional(),
  fiscalYearStart: z.number().int().min(1).max(12).optional(),
  /** 52–53-week fiscal year; null returns to the month-based year of `fiscalYearStart`. */
  fiscalYearConfig: fiscalYearConfigSchema.nullable().optional(),
  isDefault: z.boolean().optional(),
  /** Jurisdiction-specific settings, e.g. `{ kor: { enabled, startDate } }` for NL. */
  jurisdictionSettings: z.record(z.unknown()).optional(),
  /** When true (default), seed chart-of-accounts and tax rates from the jurisdiction adapter. */
  seedDefaults: z.boolean().default(true),
});

const updateEntitySchema = createEntitySchema.partial().omit({ seedDefaults: true });

/**
 * An entity as the API returns it: the encrypted SSN and sales tax credentials
 * never leave the database (`hasSsn` / `ssnLast4` say one is stored), and an
 * SSN that was typed into the EIN field before it was checked is masked.
 */
function serializeEntity<T extends { ssnEncrypted?: string | null; salesTaxCredentialsEncrypted?: string | null; fiscalCredentialsEncrypted?: string | null; taxIdentifiers?: TaxIdentifiers | null }>(row: T) {
  const { ssnEncrypted, salesTaxCredentialsEncrypted, fiscalCredentialsEncrypted, ...rest } = row;
  const ids = rest.taxIdentifiers;
  return {
    ...rest,
    ...(ids?.einOrSsn && looksLikeSsn(ids.einOrSsn) ? { taxIdentifiers: { ...ids, einOrSsn: maskTin(ids.einOrSsn, 'ssn') } } : {}),
    hasSsn: Boolean(ssnEncrypted),
    hasSalesTaxCredentials: Boolean(salesTaxCredentialsEncrypted),
    hasFiscalCredentials: Boolean(fiscalCredentialsEncrypted),
  };
}

/** Audit-log view of a changed column: tax IDs masked, ciphertext columns left out (see `auditChanges`). */
function auditValue(column: string, value: unknown): unknown {
  if (column === 'taxIdentifiers' && value && typeof value === 'object') {
    const ids = value as TaxIdentifiers;
    return ids.einOrSsn ? { ...ids, einOrSsn: maskTin(ids.einOrSsn) } : ids;
  }
  return value;
}

function auditChanges(patch: Record<string, unknown>, before: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(patch)
      .filter(([k, v]) => k !== 'updatedAt' && !ALL_SENSITIVE_KEYS.has(k) && v !== undefined)
      .map(([k, v]) => [k, { old: auditValue(k, before[k]), new: auditValue(k, v) }]),
  );
}

async function readOptionalJson(c: AppContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

// GET /
app.get('/', requirePermission('entities:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const results = await db
      .select()
      .from(schema.entities)
      .where(isNull(schema.entities.deletedAt))
      .orderBy(schema.entities.name);
    return success(c, results.map(serializeEntity));
  } catch (err) {
    console.error('[app-api/accounting-entities] list failed:', err);
    return error.internal(c, 'Failed to fetch entities');
  }
});

// GET /jurisdictions — supported jurisdiction adapters; the US entry lists the
// entity types with their allowed tax classifications and the return each files
app.get('/jurisdictions', requirePermission('entities:read'), (c) => {
  return success(
    c,
    listJurisdictions().map((jurisdiction) =>
      jurisdiction.code === 'US'
        ? {
            ...jurisdiction,
            entityTypes: US_ENTITY_TYPES.map((type) => {
              const info = US_ENTITY_TYPE_INFO[type];
              return {
                type,
                label: info.label,
                description: info.description,
                minOwners: info.minOwners,
                defaultClassification: info.classifications[0],
                classifications: info.classifications.map((classification) => {
                  const form = taxFormForClassification(classification);
                  return { value: classification, form, formLabel: TAX_FORM_LABELS[form] };
                }),
              };
            }),
          }
        : jurisdiction,
    ),
  );
});

// GET /:id
app.get('/:id', requirePermission('entities:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const [entity] = await db
      .select()
      .from(schema.entities)
      .where(and(eq(schema.entities.id, c.req.param('id')), isNull(schema.entities.deletedAt)))
      .limit(1);
    if (!entity) return error.notFound(c, 'Entity', c.req.param('id'));
    return success(c, { ...serializeEntity(entity), ...(await getEntityLockState(db, entity.id)) });
  } catch (err) {
    console.error('[app-api/accounting-entities] get failed:', err);
    return error.internal(c, 'Failed to fetch entity');
  }
});

type CreateEntityData = z.infer<typeof createEntitySchema>;

/**
 * The address, jurisdiction settings and time zone of a new entity. A US
 * address is checked; a Brazilian entity's settings are checked against its
 * address and give the time zone of its state.
 */
function newEntityLocation(code: string, data: CreateEntityData, india: ReturnType<typeof applyIndiaTaxIdentifiers>) {
  const isUs = code === 'US';
  const isBr = code === 'BR';
  let address = isUs ? checkUsAddress(normalizePostalAddress(data.address)) : normalizePostalAddress(data.address);
  const br = isBr ? normalizeBrSettings(data.jurisdictionSettings, address) : null;
  if (isBr) address = normalizeBrAddress(address);

  const jurisdictionSettings = br ? br.settings : india.jurisdictionSettings;
  let timezone = isUs ? (data.timezone ?? defaultUsTimeZone(address?.state)) : india.timezone;
  if (br) timezone = data.timezone ?? br.timezone;
  return { address, jurisdictionSettings, timezone };
}

/** The encrypted SSN columns of a new entity, or the error response when the SSN can not be stored. */
async function newEntitySsn(
  c: AppContext,
  ssnInput: string | null | undefined,
  isUs: boolean,
): Promise<Response | { ssnEncrypted: string | null; ssnLast4: string | null }> {
  if (!ssnInput) return { ssnEncrypted: null, ssnLast4: null };
  if (!isUs) return error.badRequest(c, 'An SSN can only be stored on a US entity');
  const ssn = checkSsn(ssnInput);
  const keyring = keyringFromEnv(c.env);
  if (!keyring.v1 && !keyring.v2) return error.unavailable(c, 'Encryption is not configured, so an SSN can not be stored');
  return { ssnEncrypted: await encryptField(ssn, keyring), ssnLast4: tinLast4(ssn) };
}

/** Seed a new entity's chart of accounts and tax rates from its jurisdiction adapter. */
async function seedEntityDefaults(
  db: Database,
  args: {
    adapter: ReturnType<typeof getAdapter>;
    entityId: string;
    jurisdictionCode: string;
    baseCurrency: string;
    kind: ReturnType<typeof resolveEntityKind>;
    timezone: Parameters<typeof taxYearOf>[0];
    now: Date;
  },
): Promise<{ accountsCreated: number; taxRatesCreated: number }> {
  const { adapter, entityId, jurisdictionCode, baseCurrency, kind, timezone, now } = args;
  let accountsCreated = 0;
  let taxRatesCreated = 0;

  const seedAccounts = buildSeedAccounts({
    adapter,
    entityId,
    jurisdictionCode,
    baseCurrency,
    entityType: kind.entityType,
    taxClassification: kind.taxClassification,
    taxYear: taxYearOf(timezone),
    now,
  });

  if (seedAccounts.length > 0) {
    await db.insert(schema.accounts).values(seedAccounts);
    accountsCreated = seedAccounts.length;
  }

  const taxCategories = adapter.getStandardTaxCategories({
    entityType: kind.entityType,
    taxClassification: kind.taxClassification,
  });
  const seedTaxRates = taxCategories.map((t) => ({
    id: generateId('txr'),
    entityId,
    jurisdictionCode,
    name: t.name,
    rate: t.rate,
    type: t.type,
    taxCategoryCode: t.taxCategoryCode,
    isDefault: t.isDefault ?? false,
    isActive: t.isActive ?? true,
    jurisdictionMetadata: t.jurisdictionMetadata,
    createdAt: now,
    updatedAt: now,
  }));

  if (seedTaxRates.length > 0) {
    await db.insert(schema.taxRates).values(seedTaxRates);
    taxRatesCreated = seedTaxRates.length;
  }
  return { accountsCreated, taxRatesCreated };
}

/** Point the accounting settings' defaultEntityId at the entity (creating the settings row if needed). */
async function makeDefaultEntity(db: Database, entityId: string, now: Date): Promise<void> {
  const [existing] = await db.select().from(schema.settings).limit(1);
  if (existing) {
    await db
      .update(schema.settings)
      .set({ defaultEntityId: entityId, updatedAt: now })
      .where(eq(schema.settings.id, existing.id));
  } else {
    await db.insert(schema.settings).values({
      id: generateId('acs'),
      defaultEntityId: entityId,
      createdAt: now,
      updatedAt: now,
    });
  }
}

// POST / — create entity + seed sequences/CoA/tax rates from the jurisdiction adapter
app.post('/', requirePermission('entities:create'), zValidator('json', createEntitySchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');

  const jurisdictionCode = data.jurisdictionCode ?? data.jurisdiction;
  if (!jurisdictionCode) {
    return error.badRequest(c, 'jurisdictionCode is required');
  }
  if (!hasAdapter(jurisdictionCode)) {
    return error.badRequest(c, unsupportedJurisdictionMessage(jurisdictionCode));
  }

  const adapter = getAdapter(jurisdictionCode);
  const code = jurisdictionCode.toUpperCase();
  const isUs = code === 'US';
  const mergedTaxIdentifiers =
    data.vatNumber !== undefined
      ? { ...data.taxIdentifiers, vatNumber: data.taxIdentifiers?.vatNumber ?? data.vatNumber }
      : data.taxIdentifiers;

  const india = applyIndiaTaxIdentifiers({
    jurisdictionCode,
    taxIdentifiers: mergedTaxIdentifiers,
    jurisdictionSettings: data.jurisdictionSettings,
    timezone: data.timezone,
  });
  if (india.error) {
    return error.badRequest(c, india.error);
  }

  const checked = validateTaxIdentifiersWithAdapter(
    jurisdictionCode,
    india.taxIdentifiers,
    touchedTaxIdentifiers(data.taxIdentifiers, data.vatNumber),
  );
  if (checked.error) {
    return error.badRequest(c, checked.error);
  }

  try {
    const kind = resolveEntityKind(code, { entityType: data.entityType, taxClassification: data.taxClassification });
    const { address, jurisdictionSettings, timezone } = newEntityLocation(code, data, india);

    const ssnColumns = await newEntitySsn(c, data.ssn, isUs);
    if (ssnColumns instanceof Response) return ssnColumns;
    const { ssnEncrypted, ssnLast4 } = ssnColumns;

    const taxIdentifiers = checked.taxIdentifiers;
    const locale = data.locale ?? adapter.defaultLocale;
    const baseCurrency = data.baseCurrency ?? adapter.defaultCurrency;

    const fiscalYearConfig = data.fiscalYearConfig ?? null;
    const fiscalYearStart = data.fiscalYearStart ?? (fiscalYearConfig ? (fiscalYearConfig.endMonth % 12) + 1 : 1);

    const now = new Date();
    const entityId = generateId('ent');

    const newEntity = {
      id: entityId,
      name: data.name,
      legalName: data.legalName,
      entityType: kind.entityType ?? undefined,
      taxClassification: kind.taxClassification,
      dba: data.dba ?? null,
      accountingMethod: data.accountingMethod ?? (isUs ? 'accrual' : null),
      jurisdictionCode: code,
      baseCurrency,
      locale,
      timezone,
      taxIdentifiers,
      address,
      contact: data.contact,
      bankDetails: data.bankDetails,
      branding: data.branding,
      jurisdictionSettings,
      fiscalYearStart,
      fiscalYearConfig,
      ssnEncrypted,
      ssnLast4,
      isDefault: data.isDefault ?? false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    await db.insert(schema.entities).values(newEntity);

    // Seed numbering sequences (invoice, bill, credit note, journal)
    const sequences = [
      { type: 'invoice', prefix: 'INV-' },
      { type: 'bill', prefix: 'BILL-' },
      { type: 'creditNote', prefix: 'CN-' },
      { type: 'journal', prefix: 'JE-' },
    ];
    await db.insert(schema.entityNumberSequences).values(
      sequences.map((s) => ({
        id: generateId('seq'),
        entityId,
        sequenceType: s.type,
        prefix: s.prefix,
        nextValue: 1,
        padding: adapter.getInvoiceRequirements(newEntity.locale).defaultPadding,
        createdAt: now,
        updatedAt: now,
      })),
    );

    const { accountsCreated, taxRatesCreated } = data.seedDefaults
      ? await seedEntityDefaults(db, { adapter, entityId, jurisdictionCode: code, baseCurrency, kind, timezone, now })
      : { accountsCreated: 0, taxRatesCreated: 0 };

    // If this is the first / default entity, update settings.defaultEntityId
    if (newEntity.isDefault) await makeDefaultEntity(db, entityId, now);

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'accounting_entity',
      entityId,
      action: 'created',
    });
    publishEntityEvent({
      c,
      entityType: 'accounting_entity',
      entityId,
      action: 'created',
      data: { id: entityId, name: newEntity.name, jurisdictionCode: newEntity.jurisdictionCode, entityType: kind.entityType, taxClassification: kind.taxClassification },
    });

    return success(c, { ...serializeEntity(newEntity), accountsCreated, taxRatesCreated }, 201);
  } catch (err) {
    if (err instanceof EntitySetupError) return error.badRequest(c, err.message);
    console.error('[app-api/accounting-entities] create failed:', err);
    return error.internal(c, 'Failed to create entity');
  }
});

type EntityRow = typeof schema.entities.$inferSelect;
/** The PATCH body without the request-shape aliases (`jurisdiction`, `vatNumber`) and the write-only `ssn`. */
type EntityUpdateData = Omit<z.infer<typeof updateEntitySchema>, 'jurisdiction' | 'vatNumber' | 'ssn'>;
type IndiaTaxResult = ReturnType<typeof applyIndiaTaxIdentifiers>;

/** Whether a PATCH moves the fiscal year (month start or 52–53-week config). */
function fiscalYearChanged(data: EntityUpdateData, existing: EntityRow): boolean {
  if (data.fiscalYearStart !== undefined && data.fiscalYearStart !== existing.fiscalYearStart) return true;
  return (
    data.fiscalYearConfig !== undefined &&
    JSON.stringify(data.fiscalYearConfig) !== JSON.stringify(existing.fiscalYearConfig ?? null)
  );
}

/**
 * Base currency, jurisdiction and fiscal-year start are frozen once the
 * books rest on them (posted documents, or generated fiscal periods).
 * Returns the conflict to answer with, or null when the change is allowed.
 */
async function entityLockConflict(
  db: Database,
  existing: EntityRow,
  data: EntityUpdateData,
  nextJurisdiction: string,
): Promise<{ message: string; details: Record<string, unknown> } | null> {
  const baseCurrencyChanges =
    data.baseCurrency !== undefined && data.baseCurrency.toUpperCase() !== (existing.baseCurrency ?? '').toUpperCase();
  const jurisdictionChanges = nextJurisdiction !== (existing.jurisdictionCode ?? '').toUpperCase();
  const fiscalYearChanges = fiscalYearChanged(data, existing);
  if (!baseCurrencyChanges && !jurisdictionChanges && !fiscalYearChanges) return null;

  const lock = await getEntityLockState(db, existing.id);
  if ((baseCurrencyChanges || jurisdictionChanges) && lock.baseSettingsLocked) {
    const fields = [baseCurrencyChanges && 'base currency', jurisdictionChanges && 'jurisdiction'].filter(Boolean).join(' and ');
    return {
      message: `The ${fields} of this entity can no longer be changed because it already has posted transactions. Create a new entity instead.`,
      details: { code: 'ENTITY_HAS_POSTINGS', fields: [baseCurrencyChanges && 'baseCurrency', jurisdictionChanges && 'jurisdictionCode'].filter(Boolean) },
    };
  }
  if (fiscalYearChanges && lock.fiscalYearLocked) {
    return {
      message: lock.hasPostings
        ? 'The fiscal year of this entity can no longer be changed because it already has posted transactions.'
        : 'The fiscal year of this entity can no longer be changed because fiscal periods have been generated for it.',
      details: { code: lock.hasPostings ? 'ENTITY_HAS_POSTINGS' : 'ENTITY_HAS_FISCAL_PERIODS', fields: ['fiscalYearStart'] },
    };
  }
  return null;
}

type UpdatedTaxIdentifiers =
  | { ok: false; error: string }
  | { ok: true; india: IndiaTaxResult; taxIdentifiers: TaxIdentifiers | undefined };

/** Merge the PATCH's tax identifiers into the stored ones and run the India and adapter checks on what it touched. */
function validateUpdatedTaxIdentifiers(
  existing: EntityRow,
  data: EntityUpdateData,
  vatAlias: string | undefined,
  nextJurisdiction: string,
): UpdatedTaxIdentifiers {
  const mergedWithoutAlias = data.taxIdentifiers
    ? { ...existing.taxIdentifiers, ...data.taxIdentifiers }
    : existing.taxIdentifiers;
  const mergedTaxIdentifiers =
    vatAlias !== undefined
      ? { ...existing.taxIdentifiers, ...data.taxIdentifiers, vatNumber: vatAlias }
      : mergedWithoutAlias;
  const touched = touchedTaxIdentifiers(data.taxIdentifiers, vatAlias);

  const india = applyIndiaTaxIdentifiers({
    jurisdictionCode: nextJurisdiction,
    taxIdentifiers: mergedTaxIdentifiers,
    jurisdictionSettings: data.jurisdictionSettings ?? existing.jurisdictionSettings,
    timezone: data.timezone ?? existing.timezone,
    checkGstin: touched.size > 0,
  });
  if (india.error) return { ok: false, error: india.error };

  const checked = hasAdapter(nextJurisdiction)
    ? validateTaxIdentifiersWithAdapter(nextJurisdiction, india.taxIdentifiers, touched)
    : { taxIdentifiers: india.taxIdentifiers };
  if (checked.error) return { ok: false, error: checked.error };
  return { ok: true, india, taxIdentifiers: checked.taxIdentifiers };
}

/** The 52–53-week year replaces the month-based one, and the other way round. */
function applyFiscalYearToPatch(patch: Record<string, unknown>, data: EntityUpdateData): void {
  if (data.fiscalYearConfig !== undefined) {
    patch.fiscalYearConfig = data.fiscalYearConfig;
    if (data.fiscalYearConfig && data.fiscalYearStart === undefined) {
      patch.fiscalYearStart = (data.fiscalYearConfig.endMonth % 12) + 1;
    }
  } else if (data.fiscalYearStart !== undefined) {
    patch.fiscalYearConfig = null;
  }
}

/**
 * Entity type and tax classification (US) are checked against each other.
 * Returns whether the US return form changed (the accounts' tax lines then need a remap).
 */
function applyEntityKindToPatch(
  patch: Record<string, unknown>,
  existing: EntityRow,
  data: EntityUpdateData,
  nextJurisdiction: string,
): boolean {
  const isUs = nextJurisdiction === 'US';
  const kindGiven = data.entityType !== undefined || data.taxClassification !== undefined;
  if (!kindGiven && !(isUs && existing.jurisdictionCode !== 'US')) return false;

  const kind = resolveEntityKind(
    nextJurisdiction,
    { entityType: data.entityType, taxClassification: data.taxClassification },
    { entityType: existing.entityType, taxClassification: existing.taxClassification },
  );
  patch.entityType = kind.entityType ?? undefined;
  patch.taxClassification = kind.taxClassification;
  if (!isUs) return false;
  return (
    existing.jurisdictionCode !== 'US' ||
    formOfEntity(existing) !== formOfEntity({ entityType: kind.entityType, taxClassification: kind.taxClassification })
  );
}

/** Brazil: the CEP of a patched address, and the settings checked against the address (UF, municipality). */
function applyBrSettingsToPatch(patch: Record<string, unknown>, existing: EntityRow, data: EntityUpdateData): void {
  if (data.address !== undefined) patch.address = normalizeBrAddress(patch.address as StoredPostalAddress | null);
  if (data.jurisdictionSettings !== undefined || data.address !== undefined) {
    // Settings merge into the stored ones: the fiscal provider keeps its own keys there.
    const br = normalizeBrSettings(
      { ...existing.jurisdictionSettings, ...data.jurisdictionSettings },
      (patch.address as StoredPostalAddress | null | undefined) ?? existing.address,
    );
    patch.jurisdictionSettings = br.settings;
    // The existing timezone stays unless explicitly patched.
    if (!data.timezone && !existing.timezone) patch.timezone = br.timezone;
  }
}

/** The columns a PATCH sets (everything but the SSN), and whether the US return form changed. */
function buildEntityPatch(
  existing: EntityRow,
  data: EntityUpdateData,
  opts: {
    nextJurisdiction: string;
    jurisdictionGiven: boolean;
    taxIdentifiersGiven: boolean;
    tax: Extract<UpdatedTaxIdentifiers, { ok: true }>;
  },
): { patch: Record<string, unknown>; formChanged: boolean } {
  const { nextJurisdiction, tax } = opts;
  const patch: Record<string, unknown> = {
    ...data,
    updatedAt: new Date(),
  };
  if (opts.jurisdictionGiven) {
    patch.jurisdictionCode = nextJurisdiction;
  }
  if (opts.taxIdentifiersGiven) {
    patch.taxIdentifiers = tax.taxIdentifiers;
  }
  if (data.address !== undefined) {
    const normalized = normalizePostalAddress(data.address);
    patch.address = nextJurisdiction === 'US' ? checkUsAddress(normalized) : normalized;
  }
  // The existing timezone stays unless explicitly patched.
  if (nextJurisdiction === 'IN') {
    patch.jurisdictionSettings = tax.india.jurisdictionSettings ?? existing.jurisdictionSettings;
    if (!data.timezone && !existing.timezone) patch.timezone = tax.india.timezone;
  }
  if (nextJurisdiction === 'BR') applyBrSettingsToPatch(patch, existing, data);

  const formChanged = applyEntityKindToPatch(patch, existing, data, nextJurisdiction);
  applyFiscalYearToPatch(patch, data);
  return { patch, formChanged };
}

/**
 * Encrypt a typed SSN into the patch (null or '' clears it). Returns the error
 * response when it can not be stored, null otherwise.
 */
async function applySsnToPatch(
  c: AppContext,
  patch: Record<string, unknown>,
  ssn: string | null | undefined,
  isUs: boolean,
): Promise<Response | null> {
  if (ssn === undefined) return null;
  if (ssn === null || ssn === '') {
    patch.ssnEncrypted = null;
    patch.ssnLast4 = null;
    return null;
  }
  if (!isUs) return error.badRequest(c, 'An SSN can only be stored on a US entity');
  const formatted = checkSsn(ssn);
  const keyring = keyringFromEnv(c.env);
  if (!keyring.v1 && !keyring.v2) return error.unavailable(c, 'Encryption is not configured, so an SSN can not be stored');
  patch.ssnEncrypted = await encryptField(formatted, keyring);
  patch.ssnLast4 = tinLast4(formatted);
  return null;
}

// PATCH /:id
app.patch('/:id', requirePermission('entities:update'), zValidator('json', updateEntitySchema), async (c) => {
  const db = c.get('tenantDb');
  // `jurisdiction`/`vatNumber` are request-shape aliases, not columns; `ssn` is encrypted before it is stored.
  const { jurisdiction: jurisdictionAlias, vatNumber: vatAlias, ssn, ...data } = c.req.valid('json');
  const id = c.req.param('id');
  try {
    const [existing] = await db
      .select()
      .from(schema.entities)
      .where(and(eq(schema.entities.id, id), isNull(schema.entities.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Entity', id);

    const nextJurisdiction = (
      data.jurisdictionCode ??
      jurisdictionAlias ??
      existing.jurisdictionCode
    ).toUpperCase();
    if ((data.jurisdictionCode || jurisdictionAlias) && !hasAdapter(nextJurisdiction)) {
      return error.badRequest(c, unsupportedJurisdictionMessage(nextJurisdiction));
    }
    const isUs = nextJurisdiction === 'US';

    const conflict = await entityLockConflict(db, existing, data, nextJurisdiction);
    if (conflict) return error.conflict(c, conflict.message, conflict.details);

    const tax = validateUpdatedTaxIdentifiers(existing, data, vatAlias, nextJurisdiction);
    if (!tax.ok) return error.badRequest(c, tax.error);

    const { patch, formChanged } = buildEntityPatch(existing, data, {
      nextJurisdiction,
      jurisdictionGiven: Boolean(data.jurisdictionCode || jurisdictionAlias),
      taxIdentifiersGiven: vatAlias !== undefined || Boolean(data.taxIdentifiers),
      tax,
    });

    const ssnFailure = await applySsnToPatch(c, patch, ssn, isUs);
    if (ssnFailure) return ssnFailure;

    await db
      .update(schema.entities)
      .set(patch)
      .where(and(eq(schema.entities.id, id), isNull(schema.entities.deletedAt)));
    const [updated] = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, id))
      .limit(1);

    await writeAccountingAudit(c, db, {
      accountingEntityId: id,
      entityType: 'accounting_entity',
      entityId: id,
      action: 'updated',
      changes: auditChanges(patch, existing as Record<string, unknown>),
    });
    publishEntityEvent({ c, entityType: 'accounting_entity', entityId: id, action: 'updated', data: { id, name: updated?.name } });

    // Brazil: a new regime switches the tax profiles that apply.
    if (nextJurisdiction === 'BR' && patch.taxClassification !== undefined && patch.taxClassification !== existing.taxClassification) {
      await syncBrTaxProfiles(db, id, patch.taxClassification as string | null);
    }

    // After a classification change the accounts still point at the old return's lines.
    return success(c, { ...serializeEntity(updated), ...(await getEntityLockState(db, id)), taxLineRemapNeeded: formChanged });
  } catch (err) {
    if (err instanceof EntitySetupError) return error.badRequest(c, err.message);
    console.error('[app-api/accounting-entities] update failed:', err);
    return error.internal(c, 'Failed to update entity');
  }
});

// POST /:id/apply-tax-lines — point every account at the line of the entity's
// current return (Schedule C, 1065, 1120-S, ...). Lines set by hand on this
// return stay unless `overwrite`; accounts on another return's lines are
// translated. Run it after changing the tax classification.
app.post('/:id/apply-tax-lines', requirePermission('accounts:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = z
    .object({ overwrite: z.boolean().default(false), taxYear: z.number().int().min(2023).max(2100).optional() })
    .safeParse(await readOptionalJson(c));
  if (!body.success) return error.badRequest(c, 'Invalid request body', body.error.flatten());

  try {
    const entity = await findActiveEntity(db, id);
    if (!entity) return error.notFound(c, 'Entity', id);
    if (entity.jurisdictionCode !== 'US') return error.badRequest(c, 'Tax lines are only available for US entities');

    const result = await applyTaxLines(db, entity, getAdapter('US'), {
      overwrite: body.data.overwrite,
      taxYear: body.data.taxYear ?? taxYearOf(entity.timezone),
    });

    if (result.updated > 0) {
      await writeAccountingAudit(c, db, {
        accountingEntityId: id,
        entityType: 'accounting_entity',
        entityId: id,
        action: 'tax_lines_applied',
        changes: { taxLines: { old: null, new: { form: result.form, updated: result.updated } } },
      });
      publishEntityEvent({
        c,
        entityType: 'accounting_entity',
        entityId: id,
        action: 'updated',
        data: { id, name: entity.name, taxLinesApplied: result.updated, taxForm: result.form },
      });
    }
    return success(c, result);
  } catch (err) {
    console.error('[books-api/accounting-entities] apply tax lines failed:', err);
    return error.internal(c, 'Failed to apply tax lines');
  }
});

// POST /:id/reveal-ssn — the stored SSN in clear text. Needs tax_ids:reveal; the
// reveal is written to the append-only tax_id_reveals log before it is returned.
app.post('/:id/reveal-ssn', requirePermission('tax_ids:reveal'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = z.object({ reason: z.string().trim().max(255).optional() }).safeParse(await readOptionalJson(c));
  if (!body.success) return error.badRequest(c, 'Invalid request body', body.error.flatten());

  try {
    const entity = await findActiveEntity(db, id);
    if (!entity) return error.notFound(c, 'Entity', id);
    if (!entity.ssnEncrypted) return error.notFound(c, 'SSN of entity', id);

    const plaintext = await decryptField(entity.ssnEncrypted, keyringFromEnv(c.env));

    // No log row, no reveal.
    await db.insert(schema.taxIdReveals).values({
      id: generateId('tir'),
      entityId: id,
      subjectType: 'entity',
      subjectId: id,
      field: 'ssn',
      revealedBy: c.get('userId') ?? 'unknown',
      reason: body.data.reason ?? null,
    });

    await writeAccountingAudit(c, db, {
      accountingEntityId: id,
      entityType: 'accounting_entity',
      entityId: id,
      action: 'ssn_revealed',
    });
    publishEntityEvent({ c, entityType: 'accounting_entity', entityId: id, action: 'updated', data: { id, name: entity.name, taxIdRevealed: 'ssn' } });

    c.header('Cache-Control', 'no-store');
    return success(c, { ssn: plaintext });
  } catch (err) {
    console.error('[books-api/accounting-entities] reveal ssn failed:', err);
    return error.internal(c, 'Failed to reveal the SSN');
  }
});

// DELETE /:id — soft delete
app.delete('/:id', requirePermission('entities:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db
      .select()
      .from(schema.entities)
      .where(and(eq(schema.entities.id, id), isNull(schema.entities.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Entity', id);

    await db
      .update(schema.entities)
      .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
      .where(eq(schema.entities.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: id,
      entityType: 'accounting_entity',
      entityId: id,
      action: 'deleted',
    });
    publishEntityEvent({ c, entityType: 'accounting_entity', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/accounting-entities] delete failed:', err);
    return error.internal(c, 'Failed to delete entity');
  }
});

// ---------------------------------------------------------------------------
// Lock dates
//
// Postings dated on or before a lock date are refused by the posting service:
// sales (invoices, credit notes), purchase (bills), tax (anything carrying
// tax), period (everything) and hard. The first four can be bypassed by a
// logged, time-limited exception; the hard lock has none and only moves
// forward.
// ---------------------------------------------------------------------------

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, 'Not a valid date');

const lockDatesSchema = z.object({
  salesLockDate: isoDate.nullable().optional(),
  purchaseLockDate: isoDate.nullable().optional(),
  taxLockDate: isoDate.nullable().optional(),
  periodLockDate: isoDate.nullable().optional(),
  /** Nullable only so a clear attempt gets the "only moves forward" answer. */
  hardLockDate: isoDate.nullable().optional(),
});

const LOCK_DATE_FIELDS = [
  'salesLockDate',
  'purchaseLockDate',
  'taxLockDate',
  'periodLockDate',
  'hardLockDate',
] as const;

const HARD_LOCK_FORWARD_ONLY = 'The hard lock date can only move forward';

/** Today's date (YYYY-MM-DD) in the entity's time zone, UTC when it has none. */
function todayInTimeZone(timeZone: string | null | undefined): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function findActiveEntity(db: Database, id: string) {
  const [entity] = await db
    .select()
    .from(schema.entities)
    .where(and(eq(schema.entities.id, id), isNull(schema.entities.deletedAt)))
    .limit(1);
  return entity ?? null;
}

// PATCH /:id/lock-dates
app.patch(
  '/:id/lock-dates',
  requirePermission('entities:update'),
  zValidator('json', lockDatesSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const body = c.req.valid('json');

    try {
      const existing = await findActiveEntity(db, id);
      if (!existing) return error.notFound(c, 'Entity', id);

      const hardLockDate = body.hardLockDate;
      if (hardLockDate !== undefined) {
        // Dates compare correctly as YYYY-MM-DD strings.
        if (hardLockDate === null) {
          if (existing.hardLockDate) return error.badRequest(c, HARD_LOCK_FORWARD_ONLY);
        } else {
          if (existing.hardLockDate && hardLockDate < existing.hardLockDate) {
            return error.badRequest(c, HARD_LOCK_FORWARD_ONLY);
          }
          // Irreversible, so it can't reach past today: that would freeze
          // the books for days nobody has finished yet.
          if (hardLockDate > todayInTimeZone(existing.timezone)) {
            return error.badRequest(c, "The hard lock date can't be in the future");
          }
        }
      }

      const patch: Partial<typeof schema.entities.$inferInsert> = {};
      for (const field of LOCK_DATE_FIELDS) {
        const value = body[field];
        if (value === undefined) continue;
        if (field === 'hardLockDate' && value === null) continue; // nothing set, nothing to clear
        patch[field] = value;
      }

      const changes = Object.fromEntries(
        Object.entries(patch)
          .filter(([field, value]) => (existing as Record<string, unknown>)[field] !== value)
          .map(([field, value]) => [field, { old: (existing as Record<string, unknown>)[field], new: value }]),
      );
      if (Object.keys(changes).length === 0) return success(c, serializeEntity(existing));

      // The hard-lock guard is repeated in the WHERE clause so two concurrent
      // requests can't move it backwards between the read above and this write.
      const conditions = [eq(schema.entities.id, id), isNull(schema.entities.deletedAt)];
      if (typeof patch.hardLockDate === 'string') {
        conditions.push(
          or(isNull(schema.entities.hardLockDate), lte(schema.entities.hardLockDate, patch.hardLockDate))!,
        );
      }
      const [updated] = await db
        .update(schema.entities)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(...conditions))
        .returning();
      if (!updated) return error.badRequest(c, HARD_LOCK_FORWARD_ONLY);

      await writeAccountingAudit(c, db, {
        accountingEntityId: id,
        entityType: 'accounting_entity',
        entityId: id,
        action: 'lock_dates_updated',
        changes,
      });
      publishEntityEvent({
        c,
        entityType: 'accounting_entity',
        entityId: id,
        action: 'updated',
        data: {
          id,
          name: updated.name,
          salesLockDate: updated.salesLockDate,
          purchaseLockDate: updated.purchaseLockDate,
          taxLockDate: updated.taxLockDate,
          periodLockDate: updated.periodLockDate,
          hardLockDate: updated.hardLockDate,
        },
      });

      return success(c, serializeEntity(updated));
    } catch (err) {
      console.error('[books-api/accounting-entities] lock dates failed:', err);
      return error.internal(c, 'Failed to update lock dates');
    }
  },
);

/** Longest an exception may run: it is a door left open, not a new lock date. */
const MAX_EXCEPTION_DAYS = 30;

const createLockExceptionSchema = z.object({
  lockType: z.enum(['sales', 'purchase', 'tax', 'period']),
  /** The member the exception is for; null or omitted = every member. */
  userId: z.string().min(1).max(255).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(3).max(2000),
});

// GET /:id/lock-exceptions — every exception, newest first, revoked ones included
app.get('/:id/lock-exceptions', requirePermission('entities:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const entity = await findActiveEntity(db, id);
    if (!entity) return error.notFound(c, 'Entity', id);

    const rows = await db
      .select()
      .from(schema.lockDateExceptions)
      .where(eq(schema.lockDateExceptions.entityId, id))
      .orderBy(desc(schema.lockDateExceptions.createdAt), desc(schema.lockDateExceptions.id));
    return success(c, rows);
  } catch (err) {
    console.error('[books-api/accounting-entities] list lock exceptions failed:', err);
    return error.internal(c, 'Failed to fetch lock date exceptions');
  }
});

// POST /:id/lock-exceptions
app.post(
  '/:id/lock-exceptions',
  requirePermission('entities:update'),
  zValidator('json', createLockExceptionSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const body = c.req.valid('json');

    const now = new Date();
    const endsAt = new Date(body.endsAt);
    if (endsAt.getTime() <= now.getTime()) {
      return error.badRequest(c, 'endsAt must be in the future');
    }
    if (endsAt.getTime() > now.getTime() + MAX_EXCEPTION_DAYS * 24 * 60 * 60 * 1000) {
      return error.badRequest(c, `endsAt can be at most ${MAX_EXCEPTION_DAYS} days ahead`);
    }

    try {
      const entity = await findActiveEntity(db, id);
      if (!entity) return error.notFound(c, 'Entity', id);

      const [exception] = await db
        .insert(schema.lockDateExceptions)
        .values({
          id: generateId('lde'),
          createdAt: now,
          entityId: id,
          lockType: body.lockType,
          userId: body.userId ?? null,
          endsAt,
          reason: body.reason,
          createdBy: c.get('userId') ?? null,
        })
        .returning();
      if (!exception) return error.internal(c, 'Failed to create lock date exception');

      await writeAccountingAudit(c, db, {
        accountingEntityId: id,
        entityType: 'lock_date_exception',
        entityId: exception.id,
        action: 'created',
        changes: {
          lockType: { old: null, new: exception.lockType },
          userId: { old: null, new: exception.userId },
          endsAt: { old: null, new: exception.endsAt },
          reason: { old: null, new: exception.reason },
        },
      });
      publishEntityEvent({
        c,
        entityType: 'accounting_entity',
        entityId: id,
        action: 'updated',
        data: {
          id,
          lockDateException: {
            id: exception.id,
            lockType: exception.lockType,
            userId: exception.userId,
            endsAt: exception.endsAt,
            status: 'created',
          },
        },
      });

      return success(c, exception, 201);
    } catch (err) {
      console.error('[books-api/accounting-entities] create lock exception failed:', err);
      return error.internal(c, 'Failed to create lock date exception');
    }
  },
);

// POST /:id/lock-exceptions/:exceptionId/revoke
app.post(
  '/:id/lock-exceptions/:exceptionId/revoke',
  requirePermission('entities:update'),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const exceptionId = c.req.param('exceptionId');

    try {
      const [existing] = await db
        .select()
        .from(schema.lockDateExceptions)
        .where(and(eq(schema.lockDateExceptions.id, exceptionId), eq(schema.lockDateExceptions.entityId, id)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Lock date exception', exceptionId);
      // Already revoked: nothing changes, the first revocation stays on record.
      if (existing.revokedAt) return success(c, existing);

      const revokedBy = c.get('userId') ?? null;
      const [revoked] = await db
        .update(schema.lockDateExceptions)
        .set({ revokedAt: new Date(), revokedBy })
        .where(and(eq(schema.lockDateExceptions.id, exceptionId), isNull(schema.lockDateExceptions.revokedAt)))
        .returning();
      // Lost a race with another revoke: return the row as it now stands.
      if (!revoked) {
        const [current] = await db
          .select()
          .from(schema.lockDateExceptions)
          .where(eq(schema.lockDateExceptions.id, exceptionId))
          .limit(1);
        return success(c, current ?? existing);
      }

      await writeAccountingAudit(c, db, {
        accountingEntityId: id,
        entityType: 'lock_date_exception',
        entityId: exceptionId,
        action: 'revoked',
        changes: { revokedAt: { old: null, new: revoked.revokedAt } },
      });
      publishEntityEvent({
        c,
        entityType: 'accounting_entity',
        entityId: id,
        action: 'updated',
        data: {
          id,
          lockDateException: {
            id: revoked.id,
            lockType: revoked.lockType,
            userId: revoked.userId,
            endsAt: revoked.endsAt,
            status: 'revoked',
          },
        },
      });

      return success(c, revoked);
    } catch (err) {
      console.error('[books-api/accounting-entities] revoke lock exception failed:', err);
      return error.internal(c, 'Failed to revoke lock date exception');
    }
  },
);

export const accountingEntitiesRoutes = app;
