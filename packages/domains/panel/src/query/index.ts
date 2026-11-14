/**
 * The WeldPanel query layer (ADR PANEL-003): typed spec in, Basin SQL out,
 * typed result back. `runPanelQuery` is what panel-api calls; the SQL builders
 * and `eventsScope` are exported for the tests and for routes that read raw
 * events (activity feeds, timelines, the lexicon).
 *
 * The workspace and project come from the authenticated {@link PanelQueryContext},
 * never from the spec; see ./scope for where they, the time bound, the erased
 * ids and the identity join are applied.
 */

import type {
  PanelQueryResult,
  ParsedPanelQuerySpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelQueryContext } from './context';
import { runFlows } from './flows';
import { runFunnel } from './funnel';
import { runHeatmap } from './heatmap';
import { runRetention } from './retention';
import { runSessions } from './sessions';
import { runTrends } from './trends';
import { runWeb } from './web';
import { PanelQueryError } from './sql';
import { createRunner, type PanelSqlExecutor, type RunStats } from './rows';

export * from './activity';
export { BASIN_NAMESPACE, MAX_RETENTION_DAYS, type PanelQueryContext } from './context';
export { flowsQuery } from './flows';
export { funnelQuery } from './funnel';
export { heatmapQueries, resolveUrlPattern } from './heatmap';
export { retentionQueries } from './retention';
export {
  eventsScope,
  identitiesLatest,
  peopleLatest,
  scopeConds,
  eventsTable,
  identitiesTable,
  peopleTable,
  replayChunksTable,
  type EventsScope,
} from './scope';
export { chunkCountsQuery, MAX_SESSIONS_REACH, parseSessionsCursor, sessionRowFrom, sessionsQuery } from './sessions';
export { PanelQueryError, lit, num, ts } from './sql';
export { bucketLabel, bucketLabels, resolveRange, retentionFloor, type ResolvedRange } from './time';
export {
  createRunner,
  normalizeRows,
  type PanelSqlExecutor,
  type PanelSqlQuery,
  type PanelSqlResult,
  type RawRow,
  type Row,
  type RunStats,
} from './rows';
export { specCacheKey, stableStringify } from './cache-key';
export { requiredPanelPermissions } from './permissions';
export { eventRetentionDays } from './plan-retention';

export interface PanelQueryOutput {
  result: PanelQueryResult;
  stats: RunStats;
}

/**
 * Compiles and runs a parsed spec. Throws {@link PanelQueryError} for a spec
 * the compiler refuses (unknown cohort, bad value) and whatever the executor
 * throws for an engine failure.
 */
export async function runPanelQuery(
  spec: ParsedPanelQuerySpec,
  ctx: PanelQueryContext,
  execute: PanelSqlExecutor,
): Promise<PanelQueryOutput> {
  if (spec.projectId !== ctx.projectId) throw new PanelQueryError('The query names a different project than the one it runs for');
  const runner = createRunner(execute);
  const run = (queries: Parameters<typeof runner.run>[0]) => runner.run(queries);

  let result: PanelQueryResult;
  switch (spec.kind) {
    case 'web':
      result = { kind: 'web', result: await runWeb(spec, ctx, run) };
      break;
    case 'trends':
      result = { kind: 'trends', result: await runTrends(spec, ctx, run) };
      break;
    case 'funnel':
      result = { kind: 'funnel', result: await runFunnel(spec, ctx, run) };
      break;
    case 'retention':
      result = { kind: 'retention', result: await runRetention(spec, ctx, run) };
      break;
    case 'flows':
      result = { kind: 'flows', result: await runFlows(spec, ctx, run) };
      break;
    case 'sessions':
      result = { kind: 'sessions', result: await runSessions(spec, ctx, run) };
      break;
    case 'heatmap':
      result = { kind: 'heatmap', result: await runHeatmap(spec, ctx, run) };
      break;
  }
  return { result, stats: runner.stats };
}
