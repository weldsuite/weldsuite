import '@tanstack/react-start/server-only';

import { requireAdmin } from '@/lib/auth';
import { getShard } from '@/lib/databases-data';
import { loadLiveDatabases } from '@/lib/workspace-worker';

/** Everything the shard page shows; null when there is no such shard. */
export async function loadShardPage(input: { id: string }) {
  const identity = await requireAdmin();

  const [shard, live] = await Promise.all([getShard(input.id), loadLiveDatabases(identity)]);
  if (!shard) return null;

  return {
    shard,
    live,
    // Measuring sizes wakes the shard; viewers never get the button.
    canWrite: identity.role !== 'viewer',
  };
}

export type ShardPageData = NonNullable<Awaited<ReturnType<typeof loadShardPage>>>;
