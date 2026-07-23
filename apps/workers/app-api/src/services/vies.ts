/**
 * VIES (EU VAT Information Exchange System) validation.
 *
 * A 0%-rated intracommunautaire levering or reverse-charge invoice is only
 * compliant when the buyer's VAT number is VIES-valid at the time of supply —
 * "the customer gave us a string that looks like a VAT number" is not enough
 * (an invalid number shifts the VAT liability back to the seller).
 *
 * Results are cached in `vies_checks` (tenant DB): valid results for 30 days,
 * invalid for 1 day (registrations appear with delay). When VIES itself is
 * unavailable we return `available: false` so callers can warn-and-proceed
 * instead of hard-blocking on EU infrastructure downtime.
 */

import { eq } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

const VIES_API_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';

const VALID_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const INVALID_TTL_MS = 24 * 3600 * 1000; // 1 day

export interface ViesResult {
  /** Whether VIES could be consulted (cache hit counts as available). */
  available: boolean;
  valid: boolean;
  vatNumber: string;
  countryCode: string;
  traderName?: string | null;
  traderAddress?: string | null;
  consultationNumber?: string | null;
  checkedAt: Date;
  fromCache: boolean;
}

export function normalizeVatNumber(raw: string): { countryCode: string; number: string; full: string } | null {
  const full = raw.replace(/[\s.-]/g, '').toUpperCase();
  const match = /^([A-Z]{2})([A-Z0-9+*]{2,15})$/.exec(full);
  if (!match) return null;
  return { countryCode: match[1], number: match[2], full };
}

/**
 * Validate an EU VAT number against VIES, with tenant-DB caching.
 */
export async function checkVatNumber(db: Database, rawVatNumber: string): Promise<ViesResult> {
  const normalized = normalizeVatNumber(rawVatNumber);
  const now = new Date();

  if (!normalized) {
    return {
      available: true,
      valid: false,
      vatNumber: rawVatNumber,
      countryCode: '',
      checkedAt: now,
      fromCache: false,
    };
  }

  // Cache lookup
  const [cached] = await db
    .select()
    .from(schema.viesChecks)
    .where(eq(schema.viesChecks.vatNumber, normalized.full))
    .limit(1);

  if (cached) {
    const age = now.getTime() - cached.checkedAt.getTime();
    const ttl = cached.valid ? VALID_TTL_MS : INVALID_TTL_MS;
    if (age < ttl) {
      return {
        available: true,
        valid: cached.valid,
        vatNumber: normalized.full,
        countryCode: cached.countryCode,
        traderName: cached.traderName,
        traderAddress: cached.traderAddress,
        consultationNumber: cached.consultationNumber,
        checkedAt: cached.checkedAt,
        fromCache: true,
      };
    }
  }

  // Live VIES consultation
  let body: {
    valid?: boolean;
    name?: string;
    address?: string;
    requestIdentifier?: string;
    actionSucceed?: boolean;
    userError?: string;
  };
  try {
    const response = await fetch(VIES_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        countryCode: normalized.countryCode,
        vatNumber: normalized.number,
      }),
    });
    if (!response.ok) throw new Error(`VIES HTTP ${response.status}`);
    body = (await response.json()) as typeof body;
    // VIES reports member-state outages via userError (e.g. MS_UNAVAILABLE)
    if (body.userError && body.userError !== 'VALID' && body.userError !== 'INVALID') {
      throw new Error(`VIES userError: ${body.userError}`);
    }
  } catch (err) {
    console.warn('[vies] lookup failed:', err);
    // Fall back to a stale cache entry if we have one — better than nothing
    if (cached) {
      return {
        available: true,
        valid: cached.valid,
        vatNumber: normalized.full,
        countryCode: cached.countryCode,
        traderName: cached.traderName,
        traderAddress: cached.traderAddress,
        consultationNumber: cached.consultationNumber,
        checkedAt: cached.checkedAt,
        fromCache: true,
      };
    }
    return {
      available: false,
      valid: false,
      vatNumber: normalized.full,
      countryCode: normalized.countryCode,
      checkedAt: now,
      fromCache: false,
    };
  }

  const valid = body.valid === true;
  const traderName = body.name && body.name !== '---' ? body.name.slice(0, 255) : null;
  const traderAddress = body.address && body.address !== '---' ? body.address.slice(0, 500) : null;
  const consultationNumber = body.requestIdentifier?.slice(0, 50) ?? null;

  // Upsert cache row
  await db
    .insert(schema.viesChecks)
    .values({
      id: generateId('vies'),
      vatNumber: normalized.full,
      countryCode: normalized.countryCode,
      valid,
      traderName,
      traderAddress,
      consultationNumber,
      checkedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.viesChecks.vatNumber,
      set: {
        valid,
        traderName,
        traderAddress,
        consultationNumber,
        checkedAt: now,
        updatedAt: now,
      },
    });

  return {
    available: true,
    valid,
    vatNumber: normalized.full,
    countryCode: normalized.countryCode,
    traderName,
    traderAddress,
    consultationNumber,
    checkedAt: now,
    fromCache: false,
  };
}
