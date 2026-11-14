/**
 * The seam between the compiler and Basin: an executor runs SQL, the compiler
 * only ever sees normalised rows (objects keyed by the aliases it selected).
 */

export type RawRow = unknown[] | Record<string, unknown>;

/** Runs one SQL statement. `name` is for logs and test fakes; `columns` are the aliases selected, in order. */
export interface PanelSqlQuery {
  name: string;
  sql: string;
  columns: readonly string[];
}

export interface PanelSqlResult {
  rows: RawRow[];
  /** Bytes the engine scanned, when it says. */
  bytesScanned?: number | null;
}

export type PanelSqlExecutor = (query: PanelSqlQuery) => Promise<PanelSqlResult>;

export type Row = Record<string, unknown>;

/** Rows as objects keyed by `columns`, whether Basin answered with arrays or objects. */
export function normalizeRows(rows: readonly RawRow[], columns: readonly string[]): Row[] {
  return rows.map((raw) => {
    if (Array.isArray(raw)) {
      const row: Row = {};
      columns.forEach((name, index) => {
        row[name] = raw[index];
      });
      return row;
    }
    // Object rows: keep only what was selected, tolerate other-cased keys.
    const lower = new Map(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
    const row: Row = {};
    for (const name of columns) row[name] = name in raw ? raw[name] : lower.get(name.toLowerCase());
    return row;
  });
}

/** A number from a Basin value (numbers, numeric strings, bigint); 0 when it is none. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function toText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

export function toNullableText(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

/** An ISO 8601 string from a Basin timestamp (string, Date or epoch millis). */
export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  const text = toText(value);
  if (text === '') return '';
  // `2026-11-01 10:00:00` or `2026-11-01T10:00:00` without a zone is UTC.
  const normalised = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const date = new Date(normalised);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

/** Runs `tasks` with at most `limit` in flight, keeping the order of the results. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/** How many statements run at once for one spec. Basin's concurrency limits are not documented; stay modest. */
export const QUERY_CONCURRENCY = 6;

/** What one spec's run reports besides the result. */
export interface RunStats {
  queries: number;
  bytesScanned: number | null;
}

/** A runner for one spec: runs statements through the executor and totals what they scanned. */
export function createRunner(execute: PanelSqlExecutor): {
  run(queries: readonly PanelSqlQuery[]): Promise<Row[][]>;
  stats: RunStats;
} {
  const stats: RunStats = { queries: 0, bytesScanned: null };
  return {
    stats,
    async run(queries) {
      return mapLimit(queries, QUERY_CONCURRENCY, async (query) => {
        const result = await execute(query);
        stats.queries += 1;
        if (typeof result.bytesScanned === 'number') stats.bytesScanned = (stats.bytesScanned ?? 0) + result.bytesScanned;
        return normalizeRows(result.rows, query.columns);
      });
    },
  };
}
