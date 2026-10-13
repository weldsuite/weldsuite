/**
 * WeldReach (cold email) uses WeldHost domains. While a domain is connected to
 * it, host-api marks the domain (`usedByWeldReach`), marks the mail records
 * Mailpool writes (`managedBy: 'weldreach'`, read-only) and answers a delete, an
 * auth code, a nameserver change or a record edit with a 409 and one of the
 * codes below. See apps/workers/host-api/src/lib/weldreach.ts.
 */

import { isApiError } from '@weldsuite/api-client';

export const WELDREACH_DOMAIN_IN_USE = 'DOMAIN_IN_USE_BY_WELDREACH';
export const WELDREACH_RECORD_MANAGED = 'DNS_RECORD_MANAGED_BY_WELDREACH';

/** The two 409 messages, from `t.host.weldReach`. */
export interface WeldReachErrorTranslations {
  domainInUse: string;
  recordManagedError: string;
}

/** True for a DNS record Mailpool manages on a domain connected to WeldReach. */
export function isManagedByWeldReach(record: { managedBy?: string | null }): boolean {
  return record.managedBy === 'weldreach';
}

function errorCode(err: unknown): string | null {
  if (!isApiError(err)) return null;
  const body = err.body as { error?: { code?: unknown } } | null | undefined;
  const code = body?.error?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * Message for a failed WeldHost request. The two WeldReach 409s read in the
 * user's language; anything else keeps the server's message, or `fallback`.
 */
export function hostErrorMessage(err: unknown, fallback: string, tw: WeldReachErrorTranslations): string {
  if (isApiError(err) && err.status === 409) {
    const code = errorCode(err);
    if (code === WELDREACH_DOMAIN_IN_USE) return tw.domainInUse;
    if (code === WELDREACH_RECORD_MANAGED) return tw.recordManagedError;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}
