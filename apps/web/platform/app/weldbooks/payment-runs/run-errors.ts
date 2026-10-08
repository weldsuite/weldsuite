/**
 * Turning a failed payment-run call into something to show: the translated
 * message of a known error code, else the server's message, plus the details
 * some errors carry (NACHA issues, missing ACH settings, vendors whose bank
 * details changed).
 */
import { errorDetails, isWeldbooksRequestError } from '@/lib/api/domains/weldbooks-banking';
import type { FileIssue } from '@/lib/api/domains/weldbooks-payment-runs';

/** The text for an error: `known` maps error codes to translated messages. */
export function describeRunError(err: unknown, known: Readonly<Record<string, string>>, fallback: string): string {
  if (isWeldbooksRequestError(err)) {
    const translated = err.code ? known[err.code] : undefined;
    return translated ?? (err.message || fallback);
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

export function errorCodeOf(err: unknown): string | null {
  return isWeldbooksRequestError(err) ? err.code : null;
}

function issueList(value: unknown): FileIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const issue = item as Partial<FileIssue>;
    return typeof issue.message === 'string' ? [{ ...issue, code: issue.code ?? '', message: issue.message } as FileIssue] : [];
  });
}

/** The `errors` and `warnings` of a NACHA (422) or Positive Pay error. */
export function fileIssuesOf(err: unknown): { errors: FileIssue[]; warnings: FileIssue[] } {
  const details = errorDetails(err);
  return { errors: issueList(details?.errors), warnings: issueList(details?.warnings) };
}

/** The settings an ACH file still needs (`ACH_SETTINGS_INCOMPLETE`), as the server names them. */
export function missingSettingsOf(err: unknown): string[] {
  const missing = errorDetails(err)?.missing;
  return Array.isArray(missing) ? missing.filter((m): m is string => typeof m === 'string') : [];
}

/** Vendors whose bank details changed after approval (`BANK_DETAILS_CHANGED`). */
export function changedVendorsOf(err: unknown): Array<{ partyId: string; name: string | null }> {
  const vendors = errorDetails(err)?.vendors;
  if (!Array.isArray(vendors)) return [];
  return vendors.flatMap((v) => {
    if (!v || typeof v !== 'object') return [];
    const row = v as { partyId?: unknown; name?: unknown };
    return typeof row.partyId === 'string' ? [{ partyId: row.partyId, name: typeof row.name === 'string' ? row.name : null }] : [];
  });
}
