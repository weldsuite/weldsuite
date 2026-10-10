/**
 * Reading the machine-readable code off an API failure.
 *
 * The transport throws `ApiError` carrying the parsed JSON body. Most routes
 * answer `{ error: { code, message, details } }`; a few billing guards answer
 * `{ code }` at the top level, so both are read.
 */

import { isApiError } from '@weldsuite/api-client';
import type { PartnerTerritoryErrorDetails } from '@weldsuite/app-api-client/schemas/partners';

interface ErrorBody {
  code?: unknown;
  error?: { code?: unknown; message?: unknown; details?: unknown } | string;
}

function bodyOf(err: unknown): ErrorBody | null {
  if (!isApiError(err)) return null;
  const body = err.body;
  return body && typeof body === 'object' ? (body as ErrorBody) : null;
}

export function apiErrorCode(err: unknown): string | null {
  const body = bodyOf(err);
  if (!body) return null;
  if (body.error && typeof body.error === 'object' && typeof body.error.code === 'string') {
    return body.error.code;
  }
  return typeof body.code === 'string' ? body.code : null;
}

export function apiErrorDetails<T>(err: unknown): T | undefined {
  const body = bodyOf(err);
  if (body?.error && typeof body.error === 'object') return body.error.details as T | undefined;
  return undefined;
}

export function isNotLicensedError(err: unknown): boolean {
  return apiErrorCode(err) === 'APP_NOT_LICENSED';
}

export function isReadOnlyError(err: unknown): boolean {
  return apiErrorCode(err) === 'WORKSPACE_READ_ONLY';
}

export function isPartnerManagedError(err: unknown): boolean {
  return apiErrorCode(err) === 'PARTNER_MANAGED';
}

/** The partner a territory country belongs to, when the failure is `409 PARTNER_TERRITORY`. */
export function territoryErrorDetails(err: unknown): PartnerTerritoryErrorDetails | null {
  if (apiErrorCode(err) !== 'PARTNER_TERRITORY') return null;
  const details = apiErrorDetails<PartnerTerritoryErrorDetails>(err);
  return details?.partner ? details : null;
}
