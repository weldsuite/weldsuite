/**
 * /api/sales-tax settings routes: which engine calculates the entity's sales
 * tax, its credentials, the provider registration check, the calculation
 * preview the document forms use, and address validation.
 *
 *   GET  /settings              engine, config, hasCredentials, agencies' registration summary
 *   PUT  /settings              engine, config, credentials (stored encrypted, never returned)
 *   POST /registration-check    provider registrations against WeldBooks agencies
 *   POST /calculate             tax of a draft document, nothing saved
 *   POST /validate-address      provider engines only
 *
 * Permissions: taxes:read | taxes:update (calculate: any invoice or bill write).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { schema } from '@weldsuite/worker-kit/db';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { normalizePostalAddress } from '@weldsuite/books-domain/accounting-address';
import { loadSalesTaxContext } from '@weldsuite/books-domain/sales-tax/load';
import { calculateDocumentTax, TaxCalculationError } from '../../services/accounting-tax-resolve';
import { SalesTaxDocumentError, SalesTaxSetupError, salesTaxErrorResponse } from '../../services/sales-tax/errors';
import { hasEncryptionKey, salesTaxRuntimeFromEnv, sealEngineCredentials } from '../../services/sales-tax/runtime';
import { requireEntityId, requireSalesTaxEntity } from '../../services/sales-tax/route-helpers';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const ENGINES = ['manual', 'stripe_tax', 'avalara'] as const;

/** What the settings screen needs to draw a form for each engine. */
const ENGINE_OPTIONS = [
  { id: 'manual', credentialFields: [], configFields: [] },
  { id: 'stripe_tax', credentialFields: ['apiKey'], configFields: [] },
  { id: 'avalara', credentialFields: ['accountId', 'licenseKey'], configFields: ['companyCode', 'environment'] },
] as const;

const configSchema = z.object({
  /** Avalara: the company code the transactions are recorded under. */
  companyCode: z.string().min(1).max(25).optional(),
  environment: z.enum(['sandbox', 'production']).optional(),
});

const credentialsSchema = z
  .object({
    apiKey: z.string().min(8).max(300).optional(),
    accountId: z.string().min(1).max(50).optional(),
    licenseKey: z.string().min(1).max(200).optional(),
  })
  .strict();

const updateSettingsSchema = z.object({
  engine: z.enum(ENGINES),
  config: configSchema.optional(),
  /** `{ apiKey }` for Stripe Tax, `{ accountId, licenseKey }` for Avalara. null removes the stored ones. */
  credentials: credentialsSchema.nullish(),
});

type EntityRow = typeof schema.entities.$inferSelect;

interface StoredConfig {
  companyCode?: string;
  environment?: 'sandbox' | 'production';
  /** The engine the stored credentials belong to. */
  credentialsEngine?: string;
}

function storedConfig(entity: EntityRow): StoredConfig {
  return (entity.salesTaxEngineConfig ?? {}) as StoredConfig;
}

async function settingsPayload(db: Parameters<typeof requireEntityId>[1], entity: EntityRow) {
  const engine = (ENGINES as readonly string[]).includes(entity.salesTaxEngine ?? '') ? (entity.salesTaxEngine as (typeof ENGINES)[number]) : 'manual';
  const config = storedConfig(entity);
  const agencies = await db
    .select({
      id: schema.salesTaxAgencies.id,
      stateCode: schema.salesTaxAgencies.stateCode,
      level: schema.salesTaxAgencies.level,
      name: schema.salesTaxAgencies.name,
      status: schema.salesTaxAgencies.status,
      registeredFrom: schema.salesTaxAgencies.registeredFrom,
      registeredUntil: schema.salesTaxAgencies.registeredUntil,
      providerRegistrationRef: schema.salesTaxAgencies.providerRegistrationRef,
    })
    .from(schema.salesTaxAgencies)
    .where(and(eq(schema.salesTaxAgencies.entityId, entity.id), isNull(schema.salesTaxAgencies.deletedAt)))
    .orderBy(asc(schema.salesTaxAgencies.stateCode), asc(schema.salesTaxAgencies.name));
  return {
    entityId: entity.id,
    engine,
    config: { companyCode: config.companyCode ?? null, environment: config.environment ?? 'production' },
    hasCredentials: Boolean(entity.salesTaxCredentialsEncrypted) && (!config.credentialsEngine || config.credentialsEngine === engine),
    engineOptions: ENGINE_OPTIONS,
    agencies,
    registeredStates: agencies.filter((a) => a.status === 'registered').map((a) => a.stateCode),
  };
}

// GET /settings
app.get('/settings', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    return success(c, await settingsPayload(db, entity));
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax] get settings failed:', err);
    return error.internal(c, 'Failed to fetch sales tax settings');
  }
});

// PUT /settings
app.put('/settings', requirePermission('taxes:update'), zValidator('json', updateSettingsSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const current = storedConfig(entity);

    const nextConfig: StoredConfig = { ...current };
    if (data.config?.companyCode !== undefined) nextConfig.companyCode = data.config.companyCode;
    if (data.config?.environment !== undefined) nextConfig.environment = data.config.environment;

    let credentialsBlob = entity.salesTaxCredentialsEncrypted;
    if (data.credentials === null) {
      credentialsBlob = null;
      delete nextConfig.credentialsEngine;
    } else if (data.credentials) {
      const creds = data.credentials;
      if (data.engine === 'stripe_tax' && !creds.apiKey) throw new SalesTaxSetupError('Stripe Tax needs an API key (a restricted key with Tax read and write access)');
      if (data.engine === 'avalara' && (!creds.accountId || !creds.licenseKey)) {
        throw new SalesTaxSetupError('Avalara needs an account ID and a license key');
      }
      if (data.engine === 'manual') throw new SalesTaxSetupError('The manual engine has no credentials');
      if (!hasEncryptionKey(c.env)) {
        return error.unavailable(c, 'Encryption is not configured, so engine credentials can not be stored');
      }
      credentialsBlob = await sealEngineCredentials(
        data.engine === 'stripe_tax' ? { apiKey: creds.apiKey } : { accountId: creds.accountId, licenseKey: creds.licenseKey },
        c.env,
      );
      nextConfig.credentialsEngine = data.engine;
    }

    if (data.engine !== 'manual') {
      const stored = Boolean(credentialsBlob) && (!nextConfig.credentialsEngine || nextConfig.credentialsEngine === data.engine);
      if (!stored) throw new SalesTaxSetupError(`Enter the ${data.engine === 'stripe_tax' ? 'Stripe Tax' : 'Avalara'} credentials to use this engine`);
    }
    if (data.engine === 'avalara' && !nextConfig.companyCode) {
      throw new SalesTaxSetupError('Avalara needs the company code the transactions are recorded under');
    }

    await db
      .update(schema.entities)
      .set({
        salesTaxEngine: data.engine,
        salesTaxEngineConfig: nextConfig as Record<string, unknown>,
        salesTaxCredentialsEncrypted: credentialsBlob,
        updatedAt: new Date(),
      })
      .where(eq(schema.entities.id, entity.id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'accounting_entity',
      entityId: entity.id,
      action: 'engine_changed',
      changes: { salesTaxEngine: { old: entity.salesTaxEngine, new: data.engine }, credentialsChanged: { old: null, new: data.credentials !== undefined } },
    });
    publishEntityEvent({
      c,
      entityType: 'accounting_entity',
      entityId: entity.id,
      action: 'updated',
      data: { id: entity.id, salesTaxEngine: data.engine },
    });

    const updated = { ...entity, salesTaxEngine: data.engine, salesTaxEngineConfig: nextConfig as Record<string, unknown>, salesTaxCredentialsEncrypted: credentialsBlob };
    return success(c, await settingsPayload(db, updated));
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax] update settings failed:', err);
    return error.internal(c, 'Failed to update sales tax settings');
  }
});

// POST /registration-check — the provider's registrations against the agencies registered here
app.post('/registration-check', requirePermission('taxes:read', 'taxes:update'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const ctx = await loadSalesTaxContext(db, entity.id, { decrypt: salesTaxRuntimeFromEnv(c.env).decrypt, fetch: salesTaxRuntimeFromEnv(c.env).fetch });
    if (!ctx.engine.listRegistrations) {
      throw new SalesTaxSetupError('The manual engine has no provider registrations to check. Choose Stripe Tax or Avalara first.');
    }
    const provider = (await ctx.engine.listRegistrations()).filter((r) => r.active);

    const registered = ctx.agencies.filter((a) => a.status === 'registered' && a.level === 'state');
    const providerByState = new Map(provider.map((r) => [r.stateCode.toUpperCase(), r]));
    const ourStates = new Set(registered.map((a) => a.stateCode.toUpperCase()));

    return success(c, {
      engine: ctx.engineId,
      matched: registered
        .filter((a) => providerByState.has(a.stateCode.toUpperCase()))
        .map((a) => ({ agencyId: a.id, stateCode: a.stateCode, name: a.name, providerRef: providerByState.get(a.stateCode.toUpperCase())?.ref ?? null })),
      // Registered here but unknown to the provider: it will not calculate tax for that state.
      missingInProvider: registered
        .filter((a) => !providerByState.has(a.stateCode.toUpperCase()))
        .map((a) => ({ agencyId: a.id, stateCode: a.stateCode, name: a.name })),
      // Registered at the provider but not here: tax would be calculated that WeldBooks does not charge.
      missingInWeldBooks: provider
        .filter((r) => !ourStates.has(r.stateCode.toUpperCase()))
        .map((r) => ({ stateCode: r.stateCode, providerRef: r.ref })),
      inSync:
        registered.every((a) => providerByState.has(a.stateCode.toUpperCase())) &&
        provider.every((r) => ourStates.has(r.stateCode.toUpperCase())),
    });
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax] registration check failed:', err);
    return error.internal(c, 'Failed to check the provider registrations');
  }
});

const addressSchema = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  county: z.string().optional(),
  street: z.string().optional(),
  houseNumber: z.string().optional(),
  province: z.string().optional(),
});

/** Amounts arrive as strings from forms and numbers from scripts. */
const amountField = z.union([z.string(), z.number()]).transform((v) => String(v));

const previewItemSchema = z.object({
  /** Echoed back so the form can match lines to results; generated when omitted. */
  id: z.string().max(30).optional(),
  description: z.string().nullish(),
  quantity: amountField.optional(),
  unitPrice: amountField,
  discountPercent: amountField.optional(),
  sortOrder: z.number().optional(),
  productId: z.string().max(30).nullish(),
  taxCode: z.string().max(30).nullish(),
  taxUse: z.enum(['business', 'personal']).nullish(),
  taxIncluded: z.boolean().nullish(),
  taxOverrideAmount: amountField.nullish(),
  taxOverrideReason: z.string().max(255).nullish(),
  accrueUseTax: z.boolean().nullish(),
  /** Credit memos: the invoice line credited. */
  originalLineId: z.string().max(30).nullish(),
  /** VAT / GST entities, and the vendor's tax on a US bill. */
  taxRateId: z.string().max(30).nullish(),
  taxRate: amountField.nullish(),
});

const previewSchema = z.object({
  kind: z.enum(['invoice', 'estimate', 'credit_memo', 'bill']).default('invoice'),
  contactId: z.string().max(30).nullish(),
  issueDate: z.string().optional(),
  currency: z.string().length(3).optional(),
  billingAddress: addressSchema.nullish(),
  shippingAddress: addressSchema.nullish(),
  shipFromAddress: addressSchema.nullish(),
  /** Bills: where the goods were delivered (use tax). */
  deliveryAddress: addressSchema.nullish(),
  marketplaceFacilitated: z.boolean().nullish(),
  originalInvoiceId: z.string().max(30).nullish(),
  items: z.array(previewItemSchema).min(1).max(500),
});

// POST /calculate — the tax of a draft document, as the server would post it. Nothing is saved.
app.post(
  '/calculate',
  requirePermission('invoices:create', 'invoices:update', 'bills:create', 'bills:update', 'taxes:read'),
  zValidator('json', previewSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const data = c.req.valid('json');
    try {
      const entityId = await requireEntityId(c, db);
      const direction = data.kind === 'bill' ? 'purchase' : 'sales';
      const billing = normalizePostalAddress(data.billingAddress);
      const shipping = normalizePostalAddress(data.shippingAddress);
      const items = data.items.map((item, index) => ({ ...item, id: item.id ?? `line_${index}` }));

      const calc = await calculateDocumentTax(db, {
        entityId,
        direction,
        items,
        buyerCountry: (shipping ?? billing)?.country,
        billingProvince: (shipping ?? billing)?.state,
        runtime: salesTaxRuntimeFromEnv(c.env),
        document: {
          kind: data.kind,
          contactId: data.contactId,
          issueDate: data.issueDate ?? new Date().toISOString().slice(0, 10),
          currency: data.currency,
          billingAddress: billing,
          shippingAddress: shipping,
          shipFromAddress: normalizePostalAddress(data.shipFromAddress),
          deliveryAddress: normalizePostalAddress(data.deliveryAddress),
          marketplaceFacilitated: data.marketplaceFacilitated,
          originalInvoiceId: data.originalInvoiceId,
        },
      });

      // The same rows grouped per jurisdiction, for the tax lines of the totals block.
      const byJurisdiction = new Map<string, { jurisdictionCode: string | null; jurisdictionName: string; level: string; stateCode: string | null; agencyId: string | null; rate: number; taxableAmount: number; taxAmount: number; kind: string }>();
      for (const row of calc.taxBreakdown) {
        const key = `${row.jurisdictionCode ?? row.taxRateName}|${row.jurisdictionLevel ?? ''}|${row.taxRate}|${row.kind ?? ''}`;
        const entry = byJurisdiction.get(key);
        if (entry) {
          entry.taxableAmount = Math.round((entry.taxableAmount + row.taxableAmount) * 100) / 100;
          entry.taxAmount = Math.round((entry.taxAmount + row.taxAmount) * 100) / 100;
        } else {
          byJurisdiction.set(key, {
            jurisdictionCode: row.jurisdictionCode ?? null,
            jurisdictionName: row.jurisdictionName ?? row.taxRateName,
            level: row.jurisdictionLevel ?? 'state',
            stateCode: row.stateCode ?? null,
            agencyId: row.agencyId ?? null,
            rate: row.taxRate,
            taxableAmount: row.taxableAmount,
            taxAmount: row.taxAmount,
            kind: row.kind ?? 'tax',
          });
        }
      }

      return success(c, {
        engine: calc.salesTax?.engine ?? null,
        engineRef: calc.salesTax?.engineRef ?? null,
        calculatedAt: (calc.salesTax?.calculatedAt ?? new Date()).toISOString(),
        warnings: calc.salesTax?.warnings ?? [],
        shipToState: calc.salesTax?.shipToState ?? null,
        shipToPostalCode: calc.salesTax?.shipToPostalCode ?? null,
        addressIncomplete: calc.salesTax?.addressIncomplete ?? false,
        subtotal: calc.subtotal,
        discountTotal: calc.discountTotal,
        taxTotal: calc.taxTotal,
        total: calc.total,
        lines: calc.processedItems.map((p, index) => ({
          index,
          id: items[index].id,
          lineTotal: p.lineTotal,
          taxAmount: p.taxAmount,
          lineTotalWithTax: p.lineTotalWithTax,
          taxRate: p.taxRate,
          taxRateId: p.taxRateId,
          taxCode: p.taxCode ?? null,
        })),
        jurisdictions: [...byJurisdiction.values()],
        taxBreakdown: calc.taxBreakdown,
      });
    } catch (err) {
      const handled = salesTaxErrorResponse(c, err);
      if (handled) return handled;
      if (err instanceof TaxCalculationError) return error.badRequest(c, err.message);
      if (err instanceof SalesTaxDocumentError) return error.badRequest(c, err.message);
      console.error('[books-api/sales-tax] calculate failed:', err);
      return error.internal(c, 'Failed to calculate tax');
    }
  },
);

const validateAddressSchema = z.object({ address: addressSchema });

// POST /validate-address — provider engines only
app.post('/validate-address', requirePermission('invoices:create', 'invoices:update', 'taxes:read'), zValidator('json', validateAddressSchema), async (c) => {
  const db = c.get('tenantDb');
  const { address } = c.req.valid('json');
  try {
    const entity = await requireSalesTaxEntity(c, db);
    const ctx = await loadSalesTaxContext(db, entity.id, { decrypt: salesTaxRuntimeFromEnv(c.env).decrypt, fetch: salesTaxRuntimeFromEnv(c.env).fetch });
    if (!ctx.engine.validateAddress) {
      throw new SalesTaxSetupError('Address validation needs a provider engine that offers it (Avalara). The manual engine and Stripe Tax do not validate addresses.');
    }
    const normalized = normalizePostalAddress(address);
    if (!normalized) throw new SalesTaxSetupError('Enter an address to validate');
    return success(c, { engine: ctx.engineId, ...(await ctx.engine.validateAddress(normalized)) });
  } catch (err) {
    const handled = salesTaxErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/sales-tax] validate address failed:', err);
    return error.internal(c, 'Failed to validate the address');
  }
});

export const salesTaxSettingsRoutes = app;
