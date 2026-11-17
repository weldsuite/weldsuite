/**
 * `signal`: which events go with reaching a goal. For everyone active in the
 * range: did they do the candidate event within `windowDays` of their first
 * event in the range? People who did reach the goal when they do it after
 * their first candidate event; people who didn't, when they do it at all in
 * the range. Per candidate: goal rate with and without, lift and the phi
 * correlation of that 2×2 table.
 *
 * Candidates are the spec's, or the `topN` most common events (a first,
 * cheap statement). The main statement reads the table once: a window
 * `MIN(ts)` gives each person's start, then one row per person, then one row.
 * Correlation is not causation; the result says how strongly they go together.
 */

import type { PanelSignalCandidate, PanelSignalResult, ParsedSignalSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import { eventMatch, eventNamesOf, eventsScope, eventWithFilters, scopeNeeds } from './scope';
import { inList, int, isEventName } from './sql';
import { resolveRange, type ResolvedRange } from './time';
import { toNumber, toText, type PanelSqlQuery, type Row } from './rows';
import { toResolvedRange } from './result-range';

const NOISE_EVENTS = ['$pageleave', '$identify', '$webvitals', '$autocapture'];

function signalScope(spec: ParsedSignalSpec, ctx: PanelQueryContext, range: ResolvedRange, candidates: readonly string[]) {
  const needs = scopeNeeds(ctx, { filters: [spec.goal.filters], events: [spec.goal.event, ...candidates] });
  return eventsScope(ctx, range, range, { filters: spec.filters, ...needs });
}

/** The most common events besides the goal (by people), when the spec names no candidates. */
export function signalCandidatesQuery(spec: ParsedSignalSpec, ctx: PanelQueryContext, range: ResolvedRange): PanelSqlQuery {
  const scope = signalScope(spec, ctx, range, []);
  const skip = [...eventNamesOf(spec.goal.event, ctx), ...NOISE_EVENTS];
  const notSkipped = 'e.name NOT IN ' + inList(skip);
  const sql =
    `SELECT e.name AS name, COUNT(DISTINCT ${scope.person}) AS n FROM ${scope.from} ${scope.where(notSkipped)} ` +
    `GROUP BY e.name ORDER BY COUNT(DISTINCT ${scope.person}) DESC LIMIT ${int(spec.topN, 20)}`;
  return { name: 'signal.candidates', sql, columns: ['name', 'n'] };
}

export function signalQuery(spec: ParsedSignalSpec, ctx: PanelQueryContext, range: ResolvedRange, candidates: readonly string[]): PanelSqlQuery {
  const scope = signalScope(spec, ctx, range, candidates);
  const goal = eventWithFilters(spec.goal.event, spec.goal.filters, ctx, range, scope.person);
  const flags = candidates.map((c, i) => `CASE WHEN ${eventMatch(c, ctx, range, scope.person)} THEN 1 ELSE 0 END AS m${i}`);
  const innerColumns = [
    `${scope.person} AS u`,
    'e.ts AS ts',
    `MIN(e.ts) OVER (PARTITION BY ${scope.person}) AS t0`,
    `CASE WHEN ${goal} THEN 1 ELSE 0 END AS gm`,
    ...flags,
  ];
  const inner = `SELECT ${innerColumns.join(', ')} FROM ${scope.from} ${scope.where()}`;
  const window = `INTERVAL '${int(spec.windowDays, 90)} days'`;
  // Per person: reached the goal at all (g), the last goal time (lg), and per
  // candidate the first time they did it inside the window (f<i>, null if not).
  const perPersonColumns = [
    'MAX(gm) AS g',
    'MAX(CASE WHEN gm = 1 THEN ts END) AS lg',
    ...candidates.map((_, i) => `MIN(CASE WHEN m${i} = 1 AND ts < t0 + ${window} THEN ts END) AS f${i}`),
  ];
  const perPerson = `SELECT u, ${perPersonColumns.join(', ')} FROM (${inner}) AS ev GROUP BY u`;
  const sums = [
    'COUNT(*) AS users',
    'SUM(g) AS goal_users',
    ...candidates.flatMap((_, i) => [
      `SUM(CASE WHEN f${i} IS NOT NULL THEN 1 ELSE 0 END) AS c${i}_n`,
      // Did the candidate, then reached the goal after it.
      `SUM(CASE WHEN f${i} IS NOT NULL AND lg > f${i} THEN 1 ELSE 0 END) AS c${i}_g`,
      // Didn't do the candidate, reached the goal.
      `SUM(CASE WHEN f${i} IS NULL THEN g ELSE 0 END) AS c${i}_ng`,
    ]),
  ];
  const sql = `SELECT ${sums.join(', ')} FROM (${perPerson}) AS per`;
  return {
    name: 'signal.main',
    sql,
    columns: ['users', 'goal_users', ...candidates.flatMap((_, i) => [`c${i}_n`, `c${i}_g`, `c${i}_ng`])],
  };
}

/**
 * One candidate's numbers from the 2×2 table: people who did it (and of
 * those, who reached the goal after it) against people who didn't (and of
 * those, who reached the goal).
 */
export function signalCandidate(event: string, users: number, did: number, didAndGoal: number, didNotAndGoal: number): PanelSignalCandidate {
  const didNot = Math.max(users - did, 0);
  const goalWithout = Math.min(Math.max(didNotAndGoal, 0), didNot);
  const didGoalRate = did > 0 ? didAndGoal / did : 0;
  const didNotGoalRate = didNot > 0 ? goalWithout / didNot : 0;
  const n11 = didAndGoal;
  const n10 = did - didAndGoal;
  const n01 = goalWithout;
  const n00 = Math.max(didNot - goalWithout, 0);
  const reached = n11 + n01;
  const denominator = Math.sqrt(did * didNot * reached * (users - reached));
  const phi = denominator > 0 ? (n11 * n00 - n10 * n01) / denominator : null;
  const round = (v: number) => Math.round(v * 10000) / 10000;
  return {
    event,
    didUsers: did,
    didGoalRate: round(didGoalRate),
    didNotUsers: didNot,
    didNotGoalRate: round(didNotGoalRate),
    lift: didNotGoalRate > 0 ? round(didGoalRate / didNotGoalRate) : null,
    correlation: phi === null || !Number.isFinite(phi) ? null : round(phi),
  };
}

export async function runSignal(
  spec: ParsedSignalSpec,
  ctx: PanelQueryContext,
  run: (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>,
): Promise<PanelSignalResult> {
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);
  let candidates = [...new Set(spec.candidates ?? [])].filter((c) => c !== spec.goal.event);
  if (!spec.candidates) {
    const [rows = []] = await run([signalCandidatesQuery(spec, ctx, range)]);
    candidates = rows.map((r) => toText(r.name)).filter(isEventName);
  }
  const base = { range: toResolvedRange(range, null), goal: spec.goal.event, windowDays: spec.windowDays };
  if (candidates.length === 0) return { ...base, users: 0, goalUsers: 0, goalRate: 0, candidates: [] };

  const [[row = {}] = []] = await run([signalQuery(spec, ctx, range, candidates)]);
  const users = toNumber(row.users);
  const goalUsers = toNumber(row.goal_users);
  const results = candidates
    .map((event, i) =>
      signalCandidate(event, users, toNumber(row[`c${i}_n`]), toNumber(row[`c${i}_g`]), toNumber(row[`c${i}_ng`])),
    )
    .sort((a, b) => Math.abs(b.correlation ?? 0) - Math.abs(a.correlation ?? 0));
  return { ...base, users, goalUsers, goalRate: users > 0 ? goalUsers / users : 0, candidates: results };
}
