/**
 * External record → WeldSuite entity mappers.
 *
 * Every field is read through an ordered list of candidate paths rather than a
 * single hard-coded key: the first non-empty match wins. Providers rename fields
 * between API versions and expose the same value under different names per
 * endpoint, and this degrades one field to null instead of breaking the import.
 *
 * Mappers are pure — no database, no Hono context — so they are unit-testable
 * against captured payloads. Writes happen in `ingest.ts`.
 */

import type { SyncEntityType } from '@weldsuite/connectors';

// ============================================================================
// Result shapes
// ============================================================================

export interface MappedEntity {
  entity: SyncEntityType;
  externalId: string;
  values: Record<string, unknown>;
  /**
   * A record this one depends on, when the target table has a NOT NULL reference
   * to it — a CRM opportunity needs its customer, an invoice needs its contact.
   *
   * The ingest resolves `parentExternalId` through `integration_entity_mappings`
   * using the external entity type the catalog declares for `parentEntity`, then
   * writes the resolved internal id to `parentColumn`. When it cannot resolve,
   * the record is skipped rather than failed: sync order across entities is not
   * guaranteed, so an unresolved parent is normal on a first run and links on the
   * next one.
   *
   * All three travel together — a mapper sets all of them or none.
   */
  parentEntity?: SyncEntityType;
  parentExternalId?: string | null;
  parentColumn?: string;
}

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

/** Drop nulls so an absent provider field never overwrites a curated value. */
function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined));
}

/**
 * First address in a comma-separated list.
 *
 * Moneybird's `email` holds several addresses on a contact that invoices go to
 * more than one person. The columns here take one, and the first is the one the
 * provider treats as primary.
 */
function firstEmail(raw: string | null): string | null {
  if (!raw) return null;
  const first = raw.split(',')[0]?.trim();
  return first && first.includes('@') ? first.slice(0, 255) : null;
}

/**
 * Keep only IBAN-shaped values — Moneybird's `bank_account` is free text and in
 * practice holds things like "ask Jan in accounts".
 *
 * The two check digits at positions 3–4 are what make this useful: without them
 * the pattern is "any alphanumeric string of roughly the right length", which
 * accepts a stripped English sentence. A non-IBAN sitting in the `iban` column
 * would then break any SEPA export that trusts it.
 *
 * Not a mod-97 validation — that rejects real typos too, and a wrong-but-shaped
 * IBAN is the tenant's data to correct, not ours to discard.
 */
function ibanOrNull(raw: string | null): string | null {
  if (!raw) return null;
  const compacted = raw.replace(/[\s.-]+/g, '').toUpperCase();
  return /^[A-Z]{2}\d{2}[0-9A-Z]{8,30}$/.test(compacted) ? compacted.slice(0, 34) : null;
}

// ============================================================================
// Moneybird
// ============================================================================

/**
 * Moneybird contact → `accounting_contacts`.
 *
 * `type` is `'customer'` rather than derived: the only Moneybird data we import
 * today is sales-side, so every contact we see is someone the tenant invoices.
 * A contact that is also a supplier is corrected by hand rather than guessed —
 * flipping it to `'both'` on a hunch would change which ledger accounts default.
 */
function mapMoneybirdContact(record: Record<string, unknown>, externalId: string): MappedEntity | null {
  const companyName = pickString(record, ['company_name'], 255);
  const firstName = pickString(record, ['firstname', 'first_name'], 100);
  const lastName = pickString(record, ['lastname', 'last_name'], 100);
  const email = firstEmail(pickString(record, ['email']));

  const personName = [firstName, lastName].filter(Boolean).join(' ').trim();
  // `name` is NOT NULL. Fall back through company → person → email; a contact
  // with none of the three carries no identity worth importing.
  const name = companyName ?? (personName === '' ? null : personName) ?? email;
  if (!name) return null;

  const address = compact({
    street: pickString(record, ['address1'], 255),
    houseNumber: pickString(record, ['address2'], 50),
    postalCode: pickString(record, ['zipcode'], 20),
    city: pickString(record, ['city'], 100),
    country: pickString(record, ['country'], 100),
  });

  return {
    entity: 'customer',
    externalId,
    values: compact({
      type: 'customer',
      name: name.slice(0, 255),
      companyName,
      firstName,
      lastName,
      email,
      phone: pickString(record, ['phone'], 50),
      taxNumber: pickString(record, ['tax_number'], 50),
      kvkNumber: pickString(record, ['chamber_of_commerce'], 20),
      iban: ibanOrNull(pickString(record, ['bank_account'])),
      billingAddress: Object.keys(address).length > 0 ? address : null,
      // Moneybird exposes no per-contact currency on the base record, and the
      // column already defaults to EUR — do not write a guess over it.
      metadata: compact({
        moneybirdCustomerId: pickString(record, ['customer_id'], 100),
        moneybirdSepaMandateId: pickString(record, ['sepa_mandate_id'], 100),
      }),
    }),
  };
}

// ============================================================================
// Entry point
// ============================================================================

/** External id, as the provider reports it. */
export function externalIdOf(record: Record<string, unknown>): string | null {
  return pickString(record, ['id', 'external_id'], 255);
}

/**
 * Map one external record onto a WeldSuite entity.
 *
 * Keyed on `(connectorId, entity)` because the same entity type is shaped
 * differently per provider — a Moneybird contact and a HubSpot company both land
 * in accounting or CRM tables but share no field names.
 *
 * Returns null when the record cannot produce a usable row; the caller counts it
 * as skipped rather than failing the whole run.
 */
export function mapExternalRecord(
  connectorId: string,
  entity: SyncEntityType,
  record: Record<string, unknown>,
): MappedEntity | null {
  const externalId = externalIdOf(record);
  if (!externalId) return null;

  if (connectorId === 'moneybird' && entity === 'customer') {
    return mapMoneybirdContact(record, externalId);
  }

  return null;
}

/** True when a mapper exists for the pair — the catalog must not declare others. */
export function hasMapper(connectorId: string, entity: SyncEntityType): boolean {
  return connectorId === 'moneybird' && entity === 'customer';
}
