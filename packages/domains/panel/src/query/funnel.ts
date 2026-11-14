/**
 * `funnel`: ordered steps with a conversion window.
 *
 * One scan reads the events of all steps into `seq` with a 0/1 flag per step
 * (`m1`..`mN`, the step's event name and filters). Each step is then a CTE
 * that joins the previous step's person-and-timestamp set to `seq`, never the
 * raw table again. A person's clock starts at their first step-1 event, and
 * every later step must happen within the window of it.
 *
 * `loose`: other events may happen between steps; a step is the person's first
 * matching event after the previous step. `strict`: a step must be the very
 * next event of the person (`seq` then holds every event, with `LEAD`).
 *
 * Breakdown: the property's value on the person's step-1 event; the top values
 * come from a first statement, the rest are `Other`.
 */

import type {
  PanelFunnelResult,
  PanelFunnelStepResult,
  ParsedFunnelSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import {
  breakdownExpr,
  breakdownLimit,
  breakdownLimitedExpr,
  breakdownNeedsProfiles,
  compileFilters,
  eventsScope,
  OTHER_LABEL,
  type EventsScope,
} from './scope';
import { eventName, int } from './sql';
import { resolveRange, type ResolvedRange } from './time';
import { toNumber, toText, type PanelSqlQuery, type Row } from './rows';
import { toResolvedRange } from './result-range';

type StepSpec = ParsedFunnelSpec['steps'][number];

function stepCondition(step: StepSpec, scope: EventsScope, ctx: PanelQueryContext, range: ResolvedRange): string {
  return `(${[`e.name = ${eventName(step.event)}`, ...compileFilters(step.filters, ctx, range, scope.person)].join(' AND ')})`;
}

function windowInterval(spec: ParsedFunnelSpec): string {
  const { value, unit } = spec.window;
  return `INTERVAL '${int(value, 366)} ${unit}s'`;
}

function needsProfiles(spec: ParsedFunnelSpec): boolean {
  return breakdownNeedsProfiles(spec.breakdown) || spec.steps.some((s) => s.filters.some((f) => f.source === 'person'));
}

function probeQuery(spec: ParsedFunnelSpec, ctx: PanelQueryContext, range: ResolvedRange): PanelSqlQuery | null {
  if (!spec.breakdown) return null;
  const first = spec.steps[0] as StepSpec;
  const scope = eventsScope(ctx, range, range, { filters: spec.filters, personProps: needsProfiles(spec) });
  const cond = stepCondition(first, scope, ctx, range);
  const expr = breakdownExpr(spec.breakdown);
  const sql =
    `SELECT ${expr} AS value, COUNT(DISTINCT ${scope.person}) AS n FROM ${scope.from} ${scope.where(cond)} ` +
    `GROUP BY ${expr} ORDER BY COUNT(DISTINCT ${scope.person}) DESC LIMIT ${int(breakdownLimit(spec.breakdown), 25)}`;
  return { name: 'funnel.breakdownValues', sql, columns: ['value', 'n'] };
}

/** The funnel statement. Exported for the snapshot tests. */
export function funnelQuery(spec: ParsedFunnelSpec, ctx: PanelQueryContext, range: ResolvedRange, values: readonly string[]): PanelSqlQuery {
  const strict = spec.order === 'strict';
  const scope = eventsScope(ctx, range, range, { filters: spec.filters, personProps: needsProfiles(spec) });
  const conds = spec.steps.map((step) => stepCondition(step, scope, ctx, range));
  const flags = conds.map((cond, i) => `CASE WHEN ${cond} THEN 1 ELSE 0 END AS m${i + 1}`);
  const bd = spec.breakdown ? breakdownLimitedExpr(spec.breakdown, values) : null;
  const w = windowInterval(spec);

  const seqSelect = [
    `${scope.person} AS person`,
    'e.ts AS ts',
    'e.event_id AS event_id',
    ...(bd ? [`${bd} AS bd`] : []),
    ...flags,
    ...(strict ? [`LEAD(e.event_id) OVER (PARTITION BY ${scope.person} ORDER BY e.ts, e.event_id) AS next_id`] : []),
  ];
  // Loose order only needs the step events; strict needs every event to know what came next.
  const seq = `seq AS (SELECT ${seqSelect.join(', ')} FROM ${scope.from} ${strict ? scope.where() : scope.where(`(${conds.join(' OR ')})`)})`;

  const ctes: string[] = [seq];
  const bdSelect = bd ? 'bd' : `'' AS bd`;
  ctes.push(
    strict
      ? `s1 AS (SELECT person, ts AS t1, ts AS t, ts AS tp, next_id, ${bdSelect} FROM seq WHERE m1 = 1)`
      : `s1 AS (SELECT person, MIN(ts) AS t1, MIN(ts) AS t, MIN(ts) AS tp, ${bd ? 'MIN(bd) AS bd' : `'' AS bd`} FROM seq WHERE m1 = 1 GROUP BY person)`,
  );
  for (let k = 2; k <= spec.steps.length; k += 1) {
    const prev = `s${k - 1}`;
    const sameEvent = (spec.steps[k - 1] as StepSpec).event === (spec.steps[k - 2] as StepSpec).event;
    if (strict) {
      ctes.push(
        `s${k} AS (SELECT p.person AS person, p.t1 AS t1, p.t AS tp, q.ts AS t, q.next_id AS next_id, p.bd AS bd FROM ${prev} p ` +
          `JOIN seq q ON q.event_id = p.next_id AND q.person = p.person WHERE q.m${k} = 1 AND q.ts <= p.t1 + ${w})`,
      );
    } else {
      ctes.push(
        `s${k} AS (SELECT p.person AS person, p.t1 AS t1, p.t AS tp, MIN(q.ts) AS t, MIN(p.bd) AS bd FROM ${prev} p ` +
          `JOIN seq q ON q.person = p.person WHERE q.m${k} = 1 AND q.ts ${sameEvent ? '>' : '>='} p.t AND q.ts <= p.t1 + ${w} ` +
          `GROUP BY p.person, p.t1, p.t)`,
      );
    }
  }

  const finals = spec.steps.map((_, i) => {
    const k = i + 1;
    return (
      `SELECT ${k} AS step, bd AS bd, COUNT(DISTINCT person) AS persons, AVG(to_unixtime(t) - to_unixtime(tp)) AS avg_secs ` +
      `FROM s${k} GROUP BY bd`
    );
  });
  return { name: 'funnel.steps', sql: `WITH ${ctes.join(', ')} ${finals.join(' UNION ALL ')}`, columns: ['step', 'bd', 'persons', 'avg_secs'] };
}

function stepsFrom(spec: ParsedFunnelSpec, rows: Row[]): { steps: PanelFunnelStepResult[]; overall: number } {
  const counts = spec.steps.map((_, i) => rows.filter((r) => toNumber(r.step) === i + 1));
  const first = counts[0]?.reduce((sum, r) => sum + toNumber(r.persons), 0) ?? 0;
  let previousCount = first;
  const steps = spec.steps.map((step, i): PanelFunnelStepResult => {
    const stepRows = counts[i] ?? [];
    const count = stepRows.reduce((sum, r) => sum + toNumber(r.persons), 0);
    // Weighted by people: the average over the breakdown groups.
    const secs = count > 0 ? stepRows.reduce((sum, r) => sum + toNumber(r.avg_secs) * toNumber(r.persons), 0) / count : null;
    const result: PanelFunnelStepResult = {
      index: i,
      event: step.event,
      label: step.label?.trim() || step.event,
      count,
      conversionFromPrevious: i === 0 ? 1 : previousCount > 0 ? count / previousCount : 0,
      conversionFromFirst: first > 0 ? count / first : 0,
      droppedOff: i === 0 ? 0 : Math.max(previousCount - count, 0),
      avgSecondsFromPrevious: i === 0 || count === 0 || secs === null ? null : Math.round(secs),
    };
    previousCount = count;
    return result;
  });
  const last = steps[steps.length - 1];
  return { steps, overall: last && first > 0 ? last.count / first : 0 };
}

export async function runFunnel(
  spec: ParsedFunnelSpec,
  ctx: PanelQueryContext,
  run: (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>,
): Promise<PanelFunnelResult> {
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);
  const probe = probeQuery(spec, ctx, range);
  const values = probe ? ((await run([probe]))[0] ?? []).map((r) => toText(r.value)) : [];

  const query = funnelQuery(spec, ctx, range, values);
  const rows = (await run([query]))[0] ?? [];

  const overall = stepsFrom(spec, rows);
  let breakdowns: PanelFunnelResult['breakdowns'] = null;
  if (spec.breakdown) {
    const seen = [...new Set(rows.map((r) => toText(r.bd)))];
    const order = [...values.filter((v) => seen.includes(v)), ...(seen.includes(OTHER_LABEL) && !values.includes(OTHER_LABEL) ? [OTHER_LABEL] : [])];
    breakdowns = order.map((value) => {
      const part = stepsFrom(spec, rows.filter((r) => toText(r.bd) === value));
      return { value, steps: part.steps, overallConversion: part.overall };
    });
  }
  return { range: toResolvedRange(range, null), steps: overall.steps, overallConversion: overall.overall, breakdowns };
}

