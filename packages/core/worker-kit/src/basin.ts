/**
 * Basin SQL over REST (Cloudflare's R2 SQL): the one call every reader of the
 * Iceberg tables shares. `@weldsuite/core-domain/analytics-query` (module
 * analytics) and `@weldsuite/panel-domain` (WeldPanel) both go through it.
 *
 * Basin SQL has no bind parameters and one token that sees every workspace
 * (EVT-014), so callers build SQL only from validated values and always scope
 * it to a workspace themselves.
 */

/** A row as Basin returns it: positional or keyed by column name, depending on the query. */
export type BasinRow = unknown[] | Record<string, unknown>;

export interface BasinConfig {
  /** Bearer token for the Cloudflare R2 SQL REST API. */
  token: string;
  accountId: string;
  /** The R2 bucket whose Iceberg catalog holds the tables. */
  bucket: string;
}

export interface BasinResult {
  rows: BasinRow[];
  /** The API's `bytes_scanned` metric for this query, when it reports one. */
  bytesScanned: number | null;
}

export function basinEndpoint(config: Pick<BasinConfig, 'accountId' | 'bucket'>): string {
  return `https://api.sql.cloudflarestorage.com/api/v1/accounts/${config.accountId}/r2-sql/query/${config.bucket}`;
}

interface BasinResponseBody {
  result?: { rows?: BasinRow[]; metrics?: { bytes_scanned?: unknown } };
}

/** Runs one query. Throws on a non-2xx answer with the API's message. */
export async function basinSql(config: BasinConfig, sql: string): Promise<BasinResult> {
  const response = await fetch(basinEndpoint(config), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`R2 SQL API error ${response.status}: ${text}`);
  }

  const raw = (await response.json()) as BasinResponseBody;
  const scanned = raw.result?.metrics?.bytes_scanned;
  return {
    rows: raw.result?.rows ?? [],
    bytesScanned: typeof scanned === 'number' && Number.isFinite(scanned) ? scanned : null,
  };
}
