/**
 * Loads what the sales tax engines need from the tenant DB: the entity's
 * engine and (decrypted) credentials, its agencies as registrations, and for
 * the manual engine its jurisdictions, rates, zones and taxability rules.
 * books-api and commerce-api both call it.
 */

import { and, eq, inArray, isNull, max } from 'drizzle-orm';
import type {
  ExemptionCertificate,
  SalesTaxAgency,
  SalesTaxJurisdiction,
  SalesTaxJurisdictionRate,
  SalesTaxTaxabilityRule,
  SalesTaxZone,
} from '@weldsuite/db/schema';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createSalesTaxEngine } from './index';
import {
  SalesTaxEngineError,
  type ExemptionCertificateRef,
  type ExemptReason,
  type JurisdictionLevel,
  type ManualEngineData,
  type SalesTaxEngine,
  type SalesTaxEngineConfig,
  type SalesTaxEngineId,
  type SalesTaxRegistration,
} from './types';

export interface LoadedSalesTaxContext {
  engine: SalesTaxEngine;
  engineId: SalesTaxEngineId;
  registrations: SalesTaxRegistration[];
  agencies: SalesTaxAgency[];
}

export interface LoadOptions {
  /** Decrypts `entities.sales_tax_credentials_encrypted`. */
  decrypt: (blob: string) => Promise<string>;
  /** Injected for tests; the engines default to the global fetch. */
  fetch?: typeof fetch;
}

const ENGINE_IDS: readonly SalesTaxEngineId[] = ['manual', 'stripe_tax', 'avalara'];
const LEVELS: readonly JurisdictionLevel[] = ['state', 'county', 'city', 'district'];
const REASONS: readonly ExemptReason[] = ['resale', 'nonprofit', 'government', 'manufacturing', 'agricultural', 'other'];

function num(value: string | number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function level(value: string): JurisdictionLevel {
  return (LEVELS as readonly string[]).includes(value) ? (value as JurisdictionLevel) : 'district';
}

export function toRegistration(agency: SalesTaxAgency): SalesTaxRegistration {
  return {
    agencyId: agency.id,
    stateCode: agency.stateCode.toUpperCase(),
    level: agency.level === 'local' ? 'local' : 'state',
    localJurisdictionCode: agency.localJurisdictionCode,
    status: (['registered', 'pending', 'monitoring', 'closed'] as const).find((s) => s === agency.status) ?? 'monitoring',
    registeredFrom: agency.registeredFrom,
    registeredUntil: agency.registeredUntil,
  };
}

export function buildManualEngineData(rows: {
  jurisdictions: SalesTaxJurisdiction[];
  rates: SalesTaxJurisdictionRate[];
  zones: SalesTaxZone[];
  rules: SalesTaxTaxabilityRule[];
}): ManualEngineData {
  const ratesByJurisdiction = new Map<string, SalesTaxJurisdictionRate[]>();
  for (const rate of rows.rates) {
    const list = ratesByJurisdiction.get(rate.jurisdictionId);
    if (list) list.push(rate);
    else ratesByJurisdiction.set(rate.jurisdictionId, [rate]);
  }
  return {
    jurisdictions: rows.jurisdictions.map((j) => ({
      id: j.id,
      agencyId: j.agencyId,
      stateCode: j.stateCode.toUpperCase(),
      level: level(j.level),
      code: j.code,
      name: j.name,
      reportingCode: j.reportingCode,
      rates: (ratesByJurisdiction.get(j.id) ?? []).map((r) => ({
        rate: num(r.rate),
        effectiveFrom: r.effectiveFrom,
        effectiveTo: r.effectiveTo,
      })),
    })),
    zones: rows.zones.map((z) => ({
      id: z.id,
      agencyId: z.agencyId,
      stateCode: z.stateCode.toUpperCase(),
      name: z.name,
      jurisdictionIds: z.jurisdictionIds ?? [],
      postalCodes: z.postalCodes ?? [],
      isOrigin: z.isOrigin,
      priority: z.priority,
    })),
    rules: rows.rules.map((r) => ({
      agencyId: r.agencyId,
      taxCode: r.taxCode,
      taxable: r.taxable,
      taxablePercent: num(r.taxablePercent, 100),
      appliesToUse: r.appliesToUse === 'business' || r.appliesToUse === 'personal' ? r.appliesToUse : 'any',
      rateOverride: r.rateOverride === null ? null : num(r.rateOverride),
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
    })),
  };
}

export function toCertificateRef(row: ExemptionCertificate, lastUsedOn?: string | null): ExemptionCertificateRef {
  return {
    id: row.id,
    states: (row.states ?? []).map((s) => s.toUpperCase()),
    reason: (REASONS as readonly string[]).includes(row.reason) ? (row.reason as ExemptReason) : 'other',
    certificateNumber: row.certificateNumber,
    form: row.form,
    issuedOn: row.issuedOn,
    expiresOn: row.expiresOn,
    blanket: row.blanket,
    invoiceId: row.invoiceId,
    status: (['valid', 'expired', 'pending', 'revoked'] as const).find((s) => s === row.status) ?? 'pending',
    lastUsedOn: lastUsedOn ?? null,
  };
}

function notConfigured(message: string): SalesTaxEngineError {
  return new SalesTaxEngineError(message, 'not_configured');
}

async function readCredentials(
  blob: string | null,
  decrypt: LoadOptions['decrypt'],
  engine: string,
): Promise<Record<string, unknown>> {
  if (!blob) throw notConfigured(`The ${engine} engine has no credentials; add them in the sales tax settings`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await decrypt(blob));
  } catch {
    throw notConfigured(`The ${engine} credentials could not be read; enter them again`);
  }
  if (!parsed || typeof parsed !== 'object') throw notConfigured(`The ${engine} credentials are not valid`);
  return parsed as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function loadSalesTaxContext(
  db: Database,
  entityId: string,
  opts: LoadOptions,
): Promise<LoadedSalesTaxContext> {
  const [entity] = await db
    .select({
      engine: schema.entities.salesTaxEngine,
      config: schema.entities.salesTaxEngineConfig,
      credentials: schema.entities.salesTaxCredentialsEncrypted,
    })
    .from(schema.entities)
    .where(eq(schema.entities.id, entityId))
    .limit(1);
  if (!entity) throw new SalesTaxEngineError(`Accounting entity ${entityId} was not found`, 'not_configured');

  const requested = entity.engine ?? 'manual';
  if (!(ENGINE_IDS as readonly string[]).includes(requested)) {
    throw notConfigured(`Unknown sales tax engine "${requested}"`);
  }
  const engineId = requested as SalesTaxEngineId;

  const agencies = await db
    .select()
    .from(schema.salesTaxAgencies)
    .where(and(eq(schema.salesTaxAgencies.entityId, entityId), isNull(schema.salesTaxAgencies.deletedAt)));
  const registrations = agencies.map(toRegistration);

  const config: SalesTaxEngineConfig = { engine: engineId, fetch: opts.fetch };
  if (engineId === 'manual') {
    const [jurisdictions, rates, zones, rules] = await Promise.all([
      db
        .select()
        .from(schema.salesTaxJurisdictions)
        .where(
          and(
            eq(schema.salesTaxJurisdictions.entityId, entityId),
            isNull(schema.salesTaxJurisdictions.deletedAt),
            eq(schema.salesTaxJurisdictions.isActive, true),
          ),
        ),
      db
        .select()
        .from(schema.salesTaxJurisdictionRates)
        .where(
          and(eq(schema.salesTaxJurisdictionRates.entityId, entityId), isNull(schema.salesTaxJurisdictionRates.deletedAt)),
        ),
      db
        .select()
        .from(schema.salesTaxZones)
        .where(and(eq(schema.salesTaxZones.entityId, entityId), isNull(schema.salesTaxZones.deletedAt))),
      db
        .select()
        .from(schema.salesTaxTaxabilityRules)
        .where(
          and(eq(schema.salesTaxTaxabilityRules.entityId, entityId), isNull(schema.salesTaxTaxabilityRules.deletedAt)),
        ),
    ]);
    config.manual = buildManualEngineData({ jurisdictions, rates, zones, rules });
  } else if (engineId === 'stripe_tax') {
    const creds = await readCredentials(entity.credentials, opts.decrypt, 'Stripe Tax');
    const apiKey = text(creds.apiKey);
    if (!apiKey) throw notConfigured('The Stripe Tax engine needs an API key');
    config.stripeTax = { apiKey };
  } else {
    const creds = await readCredentials(entity.credentials, opts.decrypt, 'Avalara');
    const accountId = text(creds.accountId);
    const licenseKey = text(creds.licenseKey);
    const settings = (entity.config ?? {}) as Record<string, unknown>;
    const companyCode = text(settings.companyCode);
    if (!accountId || !licenseKey) throw notConfigured('The Avalara engine needs an account id and a license key');
    if (!companyCode) throw notConfigured('The Avalara engine needs a company code');
    config.avalara = {
      accountId,
      licenseKey,
      companyCode,
      environment: settings.environment === 'sandbox' ? 'sandbox' : 'production',
    };
  }

  return { engine: createSalesTaxEngine(config), engineId, registrations, agencies };
}

/** The customer's certificates, each with the tax date of its last use (SST blanket validity). */
export async function loadCustomerCertificates(
  db: Database,
  entityId: string,
  partyId: string,
): Promise<ExemptionCertificateRef[]> {
  const rows = await db
    .select()
    .from(schema.exemptionCertificates)
    .where(
      and(
        eq(schema.exemptionCertificates.entityId, entityId),
        eq(schema.exemptionCertificates.partyId, partyId),
        isNull(schema.exemptionCertificates.deletedAt),
      ),
    );
  if (rows.length === 0) return [];

  const used = await db
    .select({ certificateId: schema.taxLines.certificateId, lastUsedOn: max(schema.taxLines.taxDate) })
    .from(schema.taxLines)
    .where(
      and(
        eq(schema.taxLines.entityId, entityId),
        inArray(
          schema.taxLines.certificateId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .groupBy(schema.taxLines.certificateId);
  const lastUsed = new Map(used.map((u) => [u.certificateId, u.lastUsedOn]));
  return rows.map((row) => toCertificateRef(row, lastUsed.get(row.id)));
}
