/**
 * Nango record → WeldSuite entity mappers.
 *
 * Nango normalises each provider into a sync model, but the exact field names
 * differ between integration templates (and change when a template is
 * customised). Every field is therefore read through an ordered list of
 * candidate paths rather than a single hard-coded key: the first non-empty
 * match wins. A template rename degrades one field to null instead of breaking
 * the whole import.
 *
 * Mappers are pure — no database, no Hono context — so they are unit-testable
 * against captured payloads. Writes happen in `ingest.ts`.
 */

import type { ConnectorEntity } from '@weldsuite/nango';

// ============================================================================
// Result shapes
// ============================================================================

export interface MappedCompany {
  entity: 'company';
  externalId: string;
  values: Record<string, unknown>;
}

export interface MappedPerson {
  entity: 'person';
  externalId: string;
  values: Record<string, unknown>;
  /** External id of the account/company this person works at, when supplied. */
  accountExternalId: string | null;
}

export interface MappedOpportunity {
  entity: 'opportunity';
  externalId: string;
  values: Record<string, unknown>;
  /** External id of the owning account — an opportunity needs a customer. */
  accountExternalId: string | null;
}

export type MappedRecord = MappedCompany | MappedPerson | MappedOpportunity;

// ============================================================================
// Field access helpers
// ============================================================================

/** Read a dotted path out of an arbitrary record. */
function readPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, segment) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[segment];
  }, source);
}

/** First candidate path that yields a non-empty scalar, as a trimmed string. */
function pickString(
  source: Record<string, unknown>,
  paths: string[],
  maxLength?: number,
): string | null {
  for (const path of paths) {
    const value = readPath(source, path);
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    const str = String(value).trim();
    if (str === '' || str === 'null' || str === 'undefined') continue;
    return maxLength !== undefined && str.length > maxLength ? str.slice(0, maxLength) : str;
  }
  return null;
}

function pickNumber(source: Record<string, unknown>, paths: string[]): number | null {
  const raw = pickString(source, paths);
  if (raw === null) return null;
  const parsed = Number(raw.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function pickDate(source: Record<string, unknown>, paths: string[]): Date | null {
  const raw = pickString(source, paths);
  if (raw === null) return null;
  // HubSpot hands out epoch milliseconds as often as ISO strings.
  const asEpoch = Number(raw);
  const parsed = Number.isFinite(asEpoch) && raw.length >= 10 ? new Date(asEpoch) : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Build an address object, or null when the provider gave us nothing usable. */
function pickAddress(source: Record<string, unknown>): Record<string, string> | null {
  const address = {
    line1: pickString(source, ['address', 'street', 'billing_street', 'properties.address']),
    city: pickString(source, ['city', 'billing_city', 'properties.city']),
    state: pickString(source, ['state', 'billing_state', 'properties.state']),
    postalCode: pickString(source, ['zip', 'postal_code', 'billing_postal_code', 'properties.zip']),
    country: pickString(source, ['country', 'billing_country', 'properties.country']),
  };
  const entries = Object.entries(address).filter(([, v]) => v !== null) as Array<[string, string]>;
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/** Drop nulls so an absent provider field never overwrites a curated value. */
function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined));
}

// ============================================================================
// Stage normalisation
// ============================================================================

/**
 * Provider deal stages → WeldCRM opportunity stages.
 *
 * Unknown stages fall back to `prospecting` rather than being dropped: an
 * opportunity in the wrong column is recoverable, a missing one is not.
 */
const STAGE_LOOKUP: Record<string, string> = {
  // HubSpot default pipeline
  appointmentscheduled: 'prospecting',
  qualifiedtobuy: 'qualification',
  presentationscheduled: 'needs_analysis',
  decisionmakerboughtin: 'proposal',
  contractsent: 'negotiation',
  closedwon: 'closed_won',
  closedlost: 'closed_lost',
  // Salesforce standard stages
  prospecting: 'prospecting',
  qualification: 'qualification',
  needsanalysis: 'needs_analysis',
  valueproposition: 'needs_analysis',
  iddecisionmakers: 'proposal',
  perceptionanalysis: 'proposal',
  proposalpricequote: 'proposal',
  negotiationreview: 'negotiation',
  proposal: 'proposal',
  negotiation: 'negotiation',
  closedwon2: 'closed_won',
};

export function normaliseStage(raw: string | null): string {
  if (!raw) return 'prospecting';
  const key = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (STAGE_LOOKUP[key]) return STAGE_LOOKUP[key];
  if (key.includes('won')) return 'closed_won';
  if (key.includes('lost')) return 'closed_lost';
  return 'prospecting';
}

/** Derived open/won/lost status — the UI filters on this, not on `stage`. */
export function statusForStage(stage: string): string {
  if (stage === 'closed_won') return 'won';
  if (stage === 'closed_lost') return 'lost';
  return 'open';
}

// ============================================================================
// Entity mappers
// ============================================================================

function mapCompany(record: Record<string, unknown>, externalId: string): MappedCompany | null {
  const name = pickString(record, ['name', 'company_name', 'companyName', 'properties.name'], 255);
  // A company row without a name is unusable in every grid and export.
  if (!name) return null;

  const employeeCount = pickString(
    record,
    ['no_employees', 'number_of_employees', 'numberOfEmployees', 'properties.numberofemployees'],
    50,
  );

  return {
    entity: 'company',
    externalId,
    values: compact({
      name,
      displayName: name,
      website: pickString(record, ['website', 'domain', 'properties.website', 'properties.domain'], 500),
      phone: pickString(record, ['phone', 'properties.phone'], 50),
      email: pickString(record, ['email', 'properties.email'], 255),
      industry: pickString(record, ['industry', 'properties.industry'], 100),
      employeeCount,
      notes: pickString(record, ['description', 'properties.description']),
      primaryAddress: pickAddress(record),
      linkedinUrl: pickString(record, ['linkedin_url', 'linkedinUrl', 'properties.linkedin_company_page'], 500),
    }),
  };
}

function mapPerson(record: Record<string, unknown>, externalId: string): MappedPerson | null {
  const firstName = pickString(record, ['first_name', 'firstName', 'properties.firstname'], 100);
  const lastName = pickString(record, ['last_name', 'lastName', 'properties.lastname'], 100);
  const email = pickString(record, ['email', 'properties.email'], 255);
  const explicitFullName = pickString(record, ['name', 'full_name', 'fullName'], 255);

  const composedName = [firstName, lastName].filter(Boolean).join(' ').trim();
  const fullName = explicitFullName ?? (composedName === '' ? null : composedName);
  // Fall back to the email so the row still has a usable label; a person with
  // neither a name nor an email carries no identity worth importing.
  const displayName = fullName ?? email;
  if (!displayName) return null;

  return {
    entity: 'person',
    externalId,
    accountExternalId: pickString(record, [
      'account_id',
      'accountId',
      'company_id',
      'companyId',
      'associated_company_id',
      'properties.associatedcompanyid',
    ]),
    values: compact({
      firstName,
      lastName,
      fullName,
      displayName: displayName.slice(0, 255),
      email,
      directPhone: pickString(record, ['phone', 'direct_phone', 'properties.phone'], 50),
      mobilePhone: pickString(record, ['mobile_phone', 'mobilephone', 'properties.mobilephone'], 50),
      title: pickString(record, ['job_title', 'jobTitle', 'title', 'properties.jobtitle'], 100),
      department: pickString(record, ['department', 'properties.department'], 100),
      primaryAddress: pickAddress(record),
      linkedinUrl: pickString(record, ['linkedin_url', 'linkedinUrl'], 500),
    }),
  };
}

function mapOpportunity(record: Record<string, unknown>, externalId: string): MappedOpportunity | null {
  const name = pickString(record, ['name', 'deal_name', 'dealname', 'properties.dealname'], 255);
  if (!name) return null;

  const stage = normaliseStage(
    pickString(record, ['stage', 'deal_stage', 'dealstage', 'stage_name', 'properties.dealstage']),
  );
  const amount = pickNumber(record, ['amount', 'properties.amount']);
  const closeDate = pickDate(record, ['close_date', 'closedate', 'expected_close_date', 'properties.closedate']);

  return {
    entity: 'opportunity',
    externalId,
    accountExternalId: pickString(record, [
      'account_id',
      'accountId',
      'company_id',
      'companyId',
      'associated_company_id',
      'properties.associatedcompanyid',
    ]),
    values: compact({
      name,
      description: pickString(record, ['description', 'properties.description']),
      amount: amount === null ? '0' : String(amount),
      currency: pickString(record, ['currency', 'deal_currency_code', 'properties.deal_currency_code'], 3) ?? 'EUR',
      stage,
      status: statusForStage(stage),
      pipeline: pickString(record, ['pipeline', 'properties.pipeline'], 100) ?? 'default',
      probability: pickNumber(record, ['probability', 'properties.hs_deal_stage_probability']),
      // `closeDate` is NOT NULL on crm_opportunities — default 30 days out, the
      // same convention the manual create route uses.
      closeDate: closeDate ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }),
  };
}

// ============================================================================
// Entry point
// ============================================================================

/** Nango stamps `_nango_metadata.last_action: 'DELETED'` on removed records. */
export function isDeletedRecord(record: Record<string, unknown>): boolean {
  const meta = record._nango_metadata as { last_action?: string; deleted_at?: string | null } | undefined;
  return meta?.last_action === 'DELETED' || Boolean(meta?.deleted_at);
}

/** External id — Nango guarantees `id`, providers sometimes echo their own. */
export function externalIdOf(record: Record<string, unknown>): string | null {
  return pickString(record, ['id', 'external_id', 'properties.hs_object_id'], 255);
}

/**
 * Map one Nango record onto a WeldSuite entity.
 *
 * Returns null when the record cannot produce a usable row — the caller counts
 * it as skipped rather than failing the whole run.
 */
export function mapNangoRecord(
  entity: ConnectorEntity,
  record: Record<string, unknown>,
): MappedRecord | null {
  const externalId = externalIdOf(record);
  if (!externalId) return null;

  switch (entity) {
    case 'company':
      return mapCompany(record, externalId);
    case 'person':
      return mapPerson(record, externalId);
    case 'opportunity':
      return mapOpportunity(record, externalId);
    default:
      return null;
  }
}
