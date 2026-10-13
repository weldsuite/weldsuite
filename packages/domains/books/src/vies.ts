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
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

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

export interface ViesErrorWrapper {
  error?: string;
  message?: string;
}

export interface ViesResponseBody {
  valid?: boolean;
  name?: string;
  address?: string;
  requestIdentifier?: string;
  actionSucceed?: boolean;
  userError?: string;
  /** Member-state / service errors the REST API reports with HTTP 200. */
  errorWrappers?: ViesErrorWrapper[];
}

/** Project a cached `vies_checks` row into a result. */
function resultFromCache(
  cached: typeof schema.viesChecks.$inferSelect,
  vatNumber: string,
): ViesResult {
  return {
    available: true,
    valid: cached.valid,
    vatNumber,
    countryCode: cached.countryCode,
    traderName: cached.traderName,
    traderAddress: cached.traderAddress,
    consultationNumber: cached.consultationNumber,
    checkedAt: cached.checkedAt,
    fromCache: true,
  };
}

/** VIES gave no verdict on the number: an outage, not "invalid". */
export class ViesUnavailableError extends Error {
  constructor(
    message: string,
    /** Worth one quick retry (the member state is throttling, not down). */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ViesUnavailableError';
  }
}

/** Errors that mean "too many concurrent requests, try again in a moment". */
const RETRYABLE_VIES_ERRORS = new Set(['MS_MAX_CONCURRENT_REQ', 'GLOBAL_MAX_CONCURRENT_REQ']);

/** `userError` values that are an answer about the number, not a failure. */
const VERDICT_USER_ERRORS = new Set(['VALID', 'INVALID']);

/** Error codes that are a definitive "this is not a valid VAT number" (malformed input). */
const DEFINITIVE_INVALID_ERRORS = new Set(['INVALID_INPUT']);

export type ViesVerdict =
  | { kind: 'verdict'; valid: boolean }
  | { kind: 'unavailable'; reason: string; retryable: boolean };

/**
 * Read a VIES REST response body. The REST endpoint reports member-state and
 * service failures as HTTP 200, either with `actionSucceed: false` and
 * `errorWrappers: [{ error: 'MS_MAX_CONCURRENT_REQ' }]` or, on older paths,
 * `userError`. Both come with `valid: false`, which is NOT a verdict on the
 * number. Only a body with a real boolean `valid` and no failure marker is.
 */
export function interpretViesBody(body: ViesResponseBody | null | undefined): ViesVerdict {
  if (!body || typeof body !== 'object') {
    return { kind: 'unavailable', reason: 'empty response', retryable: false };
  }

  const wrapperCodes = (Array.isArray(body.errorWrappers) ? body.errorWrappers : [])
    .map((w) => w?.error ?? w?.message ?? 'UNKNOWN')
    .filter(Boolean);
  if (wrapperCodes.length > 0) {
    if (wrapperCodes.every((code) => DEFINITIVE_INVALID_ERRORS.has(code))) {
      return { kind: 'verdict', valid: false };
    }
    return {
      kind: 'unavailable',
      reason: wrapperCodes.join(', '),
      retryable: wrapperCodes.some((code) => RETRYABLE_VIES_ERRORS.has(code)),
    };
  }

  if (body.userError && !VERDICT_USER_ERRORS.has(body.userError)) {
    return {
      kind: 'unavailable',
      reason: body.userError,
      retryable: RETRYABLE_VIES_ERRORS.has(body.userError),
    };
  }

  if (body.actionSucceed === false) {
    return { kind: 'unavailable', reason: 'actionSucceed=false', retryable: false };
  }

  if (typeof body.valid !== 'boolean') {
    return { kind: 'unavailable', reason: 'response has no validity flag', retryable: false };
  }

  return { kind: 'verdict', valid: body.valid };
}

export interface ConsultViesOptions {
  fetchFn?: typeof fetch;
  /** Delay before the single retry on a throttling error. */
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
}

/**
 * Call the VIES REST API. Returns the response body together with its
 * verdict; throws `ViesUnavailableError` on an HTTP failure or any outage
 * the body reports (after one retry when VIES says it is throttling).
 */
export async function consultVies(
  normalized: { countryCode: string; number: string },
  opts: ConsultViesOptions = {},
): Promise<{ body: ViesResponseBody; valid: boolean }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; ; attempt++) {
    const response = await fetchFn(VIES_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        countryCode: normalized.countryCode,
        vatNumber: normalized.number,
      }),
    });
    if (!response.ok) throw new ViesUnavailableError(`VIES HTTP ${response.status}`);

    let body: ViesResponseBody;
    try {
      body = (await response.json()) as ViesResponseBody;
    } catch {
      throw new ViesUnavailableError('VIES returned an unreadable response');
    }

    const verdict = interpretViesBody(body);
    if (verdict.kind === 'verdict') return { body, valid: verdict.valid };
    if (verdict.retryable && attempt === 0) {
      await sleep(opts.retryDelayMs ?? 1500);
      continue;
    }
    throw new ViesUnavailableError(`VIES unavailable: ${verdict.reason}`, verdict.retryable);
  }
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
    if (age < ttl) return resultFromCache(cached, normalized.full);
  }

  // Live VIES consultation
  let body: ViesResponseBody;
  let valid: boolean;
  try {
    ({ body, valid } = await consultVies(normalized));
  } catch (err) {
    console.warn('[vies] lookup failed:', err);
    // A stale positive answer beats nothing; a stale "invalid" does not, since
    // it may predate the number's registration. An outage is never cached.
    if (cached?.valid) return resultFromCache(cached, normalized.full);
    return {
      available: false,
      valid: false,
      vatNumber: normalized.full,
      countryCode: normalized.countryCode,
      checkedAt: now,
      fromCache: false,
    };
  }

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
