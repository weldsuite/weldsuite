import 'server-only';

import { requireAdmin } from '@/lib/auth';
import { getDatabasesOverview } from '@/lib/databases-data';
import { computeMap } from '@/lib/database-moves-data';
import { MAX_LIVE_PROJECT_IDS } from '@/lib/database-moves';
import { loadLiveDatabases } from '@/lib/workspace-worker';

/**
 * Everything the databases overview shows. Placement and moves come from the
 * master database; the compute columns come live from the workspace worker,
 * which only asks the Neon API, so loading this page wakes nothing.
 */
export async function loadDatabasesPage() {
  const identity = await requireAdmin();
  const { summary, shards, dedicated, pool, moves } = await getDatabasesOverview();
  const live = await loadLiveDatabases(
    identity,
    dedicated.rows.slice(0, MAX_LIVE_PROJECT_IDS).map((row) => row.neonProjectId),
  );

  return { summary, shards, dedicated, pool, moves, live, compute: computeMap(live) };
}

export type DatabasesPageData = NonNullable<Awaited<ReturnType<typeof loadDatabasesPage>>>;
