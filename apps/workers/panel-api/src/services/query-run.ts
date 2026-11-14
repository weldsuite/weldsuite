/**
 * Runs a parsed query spec the way `POST /api/panel/query` does: KV cache for
 * two minutes per workspace, project and spec hash, else compile and run on
 * Basin. The recordings and people routes call it too (a person's sessions, the
 * sessions an AI summary reads), so one function owns the cache and the scope.
 *
 * Throws `PanelQueryError` (a spec the compiler refuses), `QueryUnavailableError`
 * (a binding or secret missing here) or whatever Basin's call throws; the
 * routes map them with `queryFailure` (../http).
 */

import { getMasterDb, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import type { PanelQueryResult, ParsedPanelQuerySpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { runPanelQuery, specCacheKey } from '@weldsuite/panel-domain/query';
import type { Env } from '../types';
import { basinExecutor, buildQueryContext } from './query-engine';

export const QUERY_CACHE_SECONDS = 120;

export interface QueryRunDeps {
  env: Env;
  tenantDb: Database;
  masterDb: AnyMasterDatabase;
  /** `workspaces.id`. */
  workspaceId: string;
}

export function queryRunDeps(env: Env, tenantDb: Database, workspaceId: string): QueryRunDeps {
  return { env, tenantDb, masterDb: getMasterDb(env), workspaceId };
}

export interface CachedQuery {
  result: PanelQueryResult;
  /** When Basin was read (ISO); older when the answer came from the cache. */
  dataAsOf: string;
  cached: boolean;
}

interface CacheEntry {
  result: PanelQueryResult;
  dataAsOf: string;
}

export async function runCachedQuery(deps: QueryRunDeps, spec: ParsedPanelQuerySpec): Promise<CachedQuery> {
  const { env, tenantDb, masterDb, workspaceId } = deps;
  const kv = env.WORKSPACE_CACHE;
  const key = await specCacheKey(workspaceId, spec.projectId, spec);

  try {
    const hit = await kv.get(key, 'json');
    if (hit && typeof hit === 'object') {
      const entry = hit as CacheEntry;
      return { result: entry.result, dataAsOf: entry.dataAsOf, cached: true };
    }
  } catch (err) {
    console.warn('[panel-api] query cache read failed', err);
  }

  const execute = basinExecutor(env);
  const ctx = await buildQueryContext({ env, tenantDb, masterDb, workspaceId, projectId: spec.projectId, spec });
  const { result, stats } = await runPanelQuery(spec, ctx, execute);
  // What the query scanned, to watch the cost of project mixing (docs/plans/weldpanel.md "Risks").
  if (stats.bytesScanned !== null) {
    console.warn(`[panel-api] basin kind=${spec.kind} statements=${stats.queries} bytes_scanned=${stats.bytesScanned}`);
  }
  const entry: CacheEntry = { result, dataAsOf: new Date().toISOString() };
  try {
    await kv.put(key, JSON.stringify(entry), { expirationTtl: QUERY_CACHE_SECONDS });
  } catch (err) {
    console.warn('[panel-api] query cache write failed', err);
  }
  return { ...entry, cached: false };
}
