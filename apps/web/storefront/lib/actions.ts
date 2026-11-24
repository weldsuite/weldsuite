/**
 * What a form's server function answers. With page script the form shows
 * the message in place; without it (a plain form post) the server function
 * redirects instead: back with `?error=CODE` on a failure, on to the next
 * page on success (lib/server/actions/respond.ts).
 */

export interface ProblemRow {
  id: string;
  /** The line number in what the shopper pasted; null for a reorder. */
  row: number | null;
  sku: string | null;
  message: string;
  /** Added anyway (fewer in stock than asked); the other problems were not added. */
  added: boolean;
}

export type ActionResult =
  | { ok: true; message?: string; problems?: ProblemRow[] }
  | {
      ok: false;
      code: string;
      message: string;
      /** Field name → message, for the fields to mark. */
      fieldErrors?: Record<string, string>;
      problems?: ProblemRow[];
      /** Checkout: the key the next attempt sends (the same one when the outcome is unknown). */
      idempotencyKey?: string;
    };

export function isActionResult(value: unknown): value is ActionResult {
  return typeof value === 'object' && value !== null && 'ok' in value && typeof (value as { ok: unknown }).ok === 'boolean';
}
