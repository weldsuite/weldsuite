/** Small SQL helpers shared by the cron jobs and queue consumers. */

import { sql, type SQL } from 'drizzle-orm';

/**
 * A timestamptz literal for a `sql` template. Dates are passed as ISO text and
 * cast, so every driver (neon-http, pglite) sends the same thing.
 */
export function timestamptz(at: Date): SQL {
  return sql`${at.toISOString()}::timestamptz`;
}

/** At most `max` characters, for error text stored on a row. */
export function clip(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
