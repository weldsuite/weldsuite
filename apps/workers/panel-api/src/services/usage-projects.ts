/**
 * Events and recordings per project in one month, for the usage page. The
 * PanelUsage object counts per workspace only, so the split comes from the
 * Iceberg tables: events by `received_at`, recordings as the sessions whose
 * first chunk (seq 0) arrived, the same two things PanelUsage counts.
 *
 * Best effort: without Basin configured, or when a query fails, the page still
 * shows its totals and the project names with zeros.
 */

import { basinSql } from '@weldsuite/worker-kit/basin';
import { eventsTable, lit, normalizeRows, replayChunksTable, ts } from '@weldsuite/panel-domain/query';
import type { Env } from '../types';

export type ProjectCounts = Map<string, { events: number; recordings: number }>;

function monthBounds(month: string): { from: Date; to: Date } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
}

export async function projectUsage(
  env: Pick<Env, 'R2_SQL_API_TOKEN' | 'CF_ACCOUNT_ID' | 'PANEL_BASIN_BUCKET'>,
  workspaceId: string,
  month: string,
): Promise<ProjectCounts | null> {
  const { R2_SQL_API_TOKEN: token, CF_ACCOUNT_ID: accountId, PANEL_BASIN_BUCKET: bucket } = env;
  if (!token || !accountId || !bucket) return null;
  const config = { token, accountId, bucket };
  const { from, to } = monthBounds(month);
  const scope = (column: string) => `workspace_id = ${lit(workspaceId)} AND ${column} >= ${ts(from)} AND ${column} < ${ts(to)}`;

  try {
    const [events, recordings] = await Promise.all([
      basinSql(config, `SELECT project_id, COUNT(*) AS n FROM ${eventsTable} WHERE ${scope('received_at')} GROUP BY project_id`),
      basinSql(config, `SELECT project_id, COUNT(*) AS n FROM ${replayChunksTable} WHERE ${scope('ts_start')} AND seq = 0 GROUP BY project_id`),
    ]);
    const counts: ProjectCounts = new Map();
    const add = (rows: ReturnType<typeof normalizeRows>, key: 'events' | 'recordings') => {
      for (const row of rows) {
        const id = String(row.project_id ?? '');
        if (!id) continue;
        const entry = counts.get(id) ?? { events: 0, recordings: 0 };
        entry[key] = Number(row.n) || 0;
        counts.set(id, entry);
      }
    };
    add(normalizeRows(events.rows, ['project_id', 'n']), 'events');
    add(normalizeRows(recordings.rows, ['project_id', 'n']), 'recordings');
    return counts;
  } catch (error) {
    console.warn(`[panel-api] per-project usage lookup failed for workspace ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
