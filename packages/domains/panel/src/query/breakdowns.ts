/**
 * Breakdowns for trends and funnels: up to three at once (values joined with
 * ` / `), numeric buckets, and the top N picked in a first, cheap statement
 * (never a subquery: 6.7 s against 1.2 s in the Basin spike).
 *
 * The steps, each a statement only when needed:
 *   1. `auto` buckets: the range of the values (`MIN` / `MAX`), to cut equal parts.
 *   2. The top combined values by count.
 *   3. The caller's main statement folds everything else into `Other` with a `CASE`.
 */

import {
  PANEL_BREAKDOWN_JOINER,
  type PanelBreakdown,
  type PanelBreakdownBucket,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import { breakdownExpr, breakdownLimit, breakdownNumberExpr, bucketLabelsFor, limitedExpr, NONE_LABEL, OTHER_LABEL, type EventsScope } from './scope';
import { int, lit } from './sql';
import { toNumber, toText, type PanelSqlQuery, type Row } from './rows';

export type QueryRun = (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>;

const DEFAULT_AUTO_BUCKETS = 5;

/** Round step sizes: 1, 2, 2.5, 5 times a power of ten. */
function niceStep(raw: number): number {
  if (raw <= 0 || !Number.isFinite(raw)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const nice = [1, 2, 2.5, 5, 10].find((f) => fraction <= f) ?? 10;
  return nice * power;
}

/** `count` equal, round buckets over `[min, max]`: the `count - 1` inner edges. */
export function autoEdges(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (max <= min) return [min];
  const step = niceStep((max - min) / count);
  const start = Math.floor(min / step) * step;
  const edges: number[] = [];
  for (let i = 1; i < count; i += 1) {
    const edge = Number((start + step * i).toPrecision(12));
    if (edge > min && edge <= max) edges.push(edge);
  }
  return edges.length > 0 ? edges : [Number((start + step).toPrecision(12))];
}

export interface PreparedBreakdowns {
  list: readonly PanelBreakdown[];
  /** SQL of each breakdown's (bucketed) value. */
  parts: string[];
  /** The value the statements group by: the parts joined with ` / `. */
  combined: string;
  /** Bucket labels in order for each bucketed part (null for the others). */
  bucketLabels: (string[] | null)[];
  /** Top combined values in rank order (bucket order for a single bucketed breakdown). */
  values: string[];
  /** Each top value split into its parts. */
  partsOf: Map<string, string[]>;
}

export interface BreakdownProbe {
  ctx: PanelQueryContext;
  scope: EventsScope;
  /** Conditions the probe reads (the events of the report). */
  where: readonly string[];
  /** What a row counts: `COUNT(*)` (events) or `COUNT(DISTINCT person)`. */
  measure: string;
  /** Statement name prefix: `trends`, `funnel`. */
  name: string;
  cleanPaths?: boolean;
}

function combine(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0] as string;
  const joiner = ' || ' + lit(PANEL_BREAKDOWN_JOINER) + ' || ';
  return `(${parts.join(joiner)})`;
}

function bucketOf(b: PanelBreakdown): PanelBreakdownBucket | undefined {
  return b.source === 'column' ? undefined : b.bucket;
}

/** Runs steps 1 and 2 for `list`; null without breakdowns. */
export async function prepareBreakdowns(list: readonly PanelBreakdown[], probe: BreakdownProbe, run: QueryRun): Promise<PreparedBreakdowns | null> {
  if (list.length === 0) return null;
  const { ctx, scope } = probe;

  // 1. Auto buckets need the range of the values first.
  const autos = list.map((b, i) => ({ b, i, bucket: bucketOf(b) })).filter((x) => x.bucket?.kind === 'auto');
  const edges: (number[] | undefined)[] = list.map((b) => {
    const bucket = bucketOf(b);
    return bucket?.kind === 'custom' ? [...bucket.edges] : undefined;
  });
  if (autos.length > 0) {
    const selects = autos.flatMap(({ b, i }) => {
      const value = breakdownNumberExpr(b, ctx);
      return [`MIN(${value}) AS min${i}`, `MAX(${value}) AS max${i}`];
    });
    const sql = `SELECT ${selects.join(', ')} FROM ${scope.from} ${scope.where(...probe.where)}`;
    const columns = autos.flatMap(({ i }) => [`min${i}`, `max${i}`]);
    const [row = {}] = (await run([{ name: `${probe.name}.breakdownRange`, sql, columns }]))[0] ?? [];
    for (const { i, bucket } of autos) {
      const count = bucket?.kind === 'auto' ? (bucket.count ?? DEFAULT_AUTO_BUCKETS) : DEFAULT_AUTO_BUCKETS;
      const min = row[`min${i}`];
      const max = row[`max${i}`];
      edges[i] = min === null || min === undefined ? [0] : autoEdges(toNumber(min), toNumber(max), count);
    }
  }

  const parts = list.map((b, i) => breakdownExpr(b, ctx, { cleanPaths: probe.cleanPaths, edges: edges[i] }));
  const bucketLabels = list.map((b, i) => (bucketOf(b) && edges[i] ? [...bucketLabelsFor(edges[i] as number[]), NONE_LABEL] : null));
  const combined = combine(parts);

  // 2. The top values. A single bucketed breakdown shows every bucket.
  const single = list.length === 1 ? bucketLabels[0] : null;
  const limit = single ? single.length : Math.min(25, Math.max(...list.map(breakdownLimit)));
  const partSelects = parts.map((p, i) => `${p} AS v${i}`);
  const groupBy = parts.join(', ');
  const sql =
    `SELECT ${combined} AS value, ${partSelects.join(', ')}, ${probe.measure} AS n FROM ${scope.from} ${scope.where(...probe.where)} ` +
    `GROUP BY ${groupBy} ORDER BY ${probe.measure} DESC LIMIT ${int(limit, 25)}`;
  const rows = (await run([{ name: `${probe.name}.breakdownValues`, sql, columns: ['value', ...parts.map((_, i) => `v${i}`), 'n'] }]))[0] ?? [];

  const partsOf = new Map<string, string[]>();
  let values = rows.map((r) => {
    const value = toText(r.value);
    partsOf.set(value, parts.map((_, i) => (r[`v${i}`] === undefined ? value : toText(r[`v${i}`]))));
    return value;
  });
  if (single) values = [...values].sort((a, b) => single.indexOf(a) - single.indexOf(b));
  return { list, parts, combined, bucketLabels, values, partsOf };
}

/** The combined value with everything outside the top values folded into `Other`. */
export function limitedBreakdown(prepared: PreparedBreakdowns): string {
  return limitedExpr(prepared.combined, prepared.values);
}

/** Line order: the top values that have data, `Other` last. */
export function orderedValues(prepared: PreparedBreakdowns, seen: ReadonlySet<string>): string[] {
  const out = prepared.values.filter((v) => seen.has(v));
  if (seen.has(OTHER_LABEL) && !prepared.values.includes(OTHER_LABEL)) out.push(OTHER_LABEL);
  return out;
}

/** The parts of a line's value; null for `Other` or without breakdowns. */
export function partsFor(prepared: PreparedBreakdowns | null, value: string | null): string[] | null {
  if (!prepared || value === null) return null;
  return prepared.partsOf.get(value) ?? null;
}
