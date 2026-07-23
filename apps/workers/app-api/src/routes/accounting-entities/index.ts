/**
 * Entity routes — flat /api/accounting-entities/* surface backed by `entities`.
 *
 * Entity creation is jurisdiction-aware: the adapter for the entity's
 * country seeds a localized chart of accounts, standard tax rates (with
 * rubriek metadata for the BTW return), and per-entity number sequences.
 * Unsupported jurisdictions are rejected — see services/jurisdictions/.
 *
 * Permissions: entities:read | entities:create | entities:update | entities:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { getAdapter, hasAdapter, listJurisdictions } from '../../services/jurisdictions/registry';
import { writeAccountingAudit } from '../../services/accounting-guards';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const addressSchema = z.object({
  street: z.string().optional(),
  houseNumber: z.string().optional(),
  postalCode: z.string().optional(),
  city: z.string().optional(),
  province: z.string().optional(),
  country: z.string().optional(),
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
  iban: z.string().optional(),
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

const createEntitySchema = z.object({
  name: z.string().min(1).max(255),
  legalName: z.string().max(255).optional(),
  entityType: z.string().max(20).optional(),
  jurisdictionCode: z.string().min(2).max(5).optional(),
  /** Shared-schema alias for jurisdictionCode. */
  jurisdiction: z.string().min(2).max(5).optional(),
  /** Top-level convenience alias — merged into taxIdentifiers.vatNumber. */
  vatNumber: z.string().max(50).optional(),
  baseCurrency: z.string().length(3).default('EUR'),
  locale: z.string().max(10).optional(),
  timezone: z.string().max(50).optional(),
  taxIdentifiers: taxIdentifiersSchema.optional(),
  address: addressSchema.optional(),
  contact: contactSchema.optional(),
  bankDetails: bankDetailsSchema.optional(),
  branding: brandingSchema.optional(),
  fiscalYearStart: z.number().int().min(1).max(12).optional(),
  isDefault: z.boolean().optional(),
  /** Jurisdiction-specific settings, e.g. `{ kor: { enabled, startDate } }` for NL. */
  jurisdictionSettings: z.record(z.unknown()).optional(),
  /** When true (default), seed chart-of-accounts and tax rates from the jurisdiction adapter. */
  seedDefaults: z.boolean().default(true),
});

const updateEntitySchema = createEntitySchema.partial().omit({ seedDefaults: true });

// GET /
app.get('/', requirePermission('entities:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const results = await db
      .select()
      .from(schema.entities)
      .where(isNull(schema.entities.deletedAt))
      .orderBy(schema.entities.name);
    return success(c, results);
  } catch (err) {
    console.error('[app-api/accounting-entities] list failed:', err);
    return error.internal(c, 'Failed to fetch entities');
  }
});

// GET /jurisdictions — supported jurisdiction adapters
app.get('/jurisdictions', requirePermission('entities:read'), async (c) => {
  return success(c, listJurisdictions());
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
    return success(c, entity);
  } catch (err) {
    console.error('[app-api/accounting-entities] get failed:', err);
    return error.internal(c, 'Failed to fetch entity');
  }
});

// POST / — create entity + seed sequences/CoA/tax rates from the jurisdiction adapter
app.post('/', requirePermission('entities:create'), zValidator('json', createEntitySchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');

  const jurisdictionCode = data.jurisdictionCode ?? data.jurisdiction;
  if (!jurisdictionCode) {
    return error.badRequest(c, 'jurisdictionCode is required');
  }
  if (!hasAdapter(jurisdictionCode)) {
    return error.badRequest(
      c,
      `Jurisdiction '${jurisdictionCode}' is not supported. Supported: ${listJurisdictions().map((j) => j.code).join(', ')}`,
    );
  }

  const adapter = getAdapter(jurisdictionCode);
  const taxIdentifiers = data.vatNumber
    ? { ...(data.taxIdentifiers ?? {}), vatNumber: data.taxIdentifiers?.vatNumber ?? data.vatNumber }
    : data.taxIdentifiers;

  try {
    const now = new Date();
    const entityId = generateId('ent');

    const newEntity = {
      id: entityId,
      name: data.name,
      legalName: data.legalName,
      entityType: data.entityType,
      jurisdictionCode: jurisdictionCode.toUpperCase(),
      baseCurrency: data.baseCurrency,
      locale: data.locale ?? adapter.defaultLocale,
      timezone: data.timezone,
      taxIdentifiers,
      address: data.address,
      contact: data.contact,
      bankDetails: data.bankDetails,
      branding: data.branding,
      fiscalYearStart: data.fiscalYearStart ?? 1,
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

    let accountsCreated = 0;
    let taxRatesCreated = 0;

    if (data.seedDefaults) {
      const coaTemplate = adapter.getChartOfAccountsTemplate();
      const seedAccounts = coaTemplate.map((row) => ({
        id: generateId('acc'),
        entityId,
        code: row.code,
        name: row.name,
        type: row.type,
        subtype: row.subtype,
        normalSide: row.normalSide,
        currency: data.baseCurrency,
        isActive: true,
        isSystemAccount: row.isSystemAccount ?? false,
        openingBalance: '0',
        currentBalance: '0',
        metadata: row.systemRole ? { systemRole: row.systemRole } : undefined,
        createdAt: now,
        updatedAt: now,
      }));

      if (seedAccounts.length > 0) {
        await db.insert(schema.accounts).values(seedAccounts);
        accountsCreated = seedAccounts.length;
      }

      const taxCategories = adapter.getStandardTaxCategories();
      const seedTaxRates = taxCategories.map((t) => ({
        id: generateId('txr'),
        entityId,
        jurisdictionCode: newEntity.jurisdictionCode,
        name: t.name,
        rate: t.rate,
        type: t.type,
        taxCategoryCode: t.taxCategoryCode,
        isDefault: t.isDefault ?? false,
        isActive: true,
        jurisdictionMetadata: t.jurisdictionMetadata,
        createdAt: now,
        updatedAt: now,
      }));

      if (seedTaxRates.length > 0) {
        await db.insert(schema.taxRates).values(seedTaxRates);
        taxRatesCreated = seedTaxRates.length;
      }
    }

    // If this is the first / default entity, update settings.defaultEntityId
    if (newEntity.isDefault) {
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

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'accounting_entity',
      entityId,
      action: 'created',
    });
    publishEntityEvent({ c, entityType: 'accounting_entity', entityId, action: 'created', data: { id: entityId, name: newEntity.name, jurisdictionCode: newEntity.jurisdictionCode } });

    return success(c, { ...newEntity, accountsCreated, taxRatesCreated }, 201);
  } catch (err) {
    console.error('[app-api/accounting-entities] create failed:', err);
    return error.internal(c, 'Failed to create entity');
  }
});

// PATCH /:id
app.patch('/:id', requirePermission('entities:update'), zValidator('json', updateEntitySchema), async (c) => {
  const db = c.get('tenantDb');
  // `jurisdiction`/`vatNumber` are request-shape aliases, not columns.
  const { jurisdiction: _alias, vatNumber: _vat, ...data } = c.req.valid('json');
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
      .set({ ...data, updatedAt: new Date() })
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
      changes: Object.fromEntries(
        Object.entries(data)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, { old: (existing as Record<string, unknown>)[k], new: v }]),
      ),
    });
    publishEntityEvent({ c, entityType: 'accounting_entity', entityId: id, action: 'updated', data: { id, name: updated?.name } });

    return success(c, updated);
  } catch (err) {
    console.error('[app-api/accounting-entities] update failed:', err);
    return error.internal(c, 'Failed to update entity');
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

export const accountingEntitiesRoutes = app;
