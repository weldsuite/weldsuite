import '@tanstack/react-start/server-only';

import { requireAdmin } from '@/lib/auth';
import {
  MAILBOX_TABLE_LIMIT,
  TREND_DAYS,
  getPlacementTrend,
  getPoolOverview,
  getTodayVolume,
  listPoolMailboxes,
  listProblemMailboxes,
} from '@/lib/warmup-network-data';

export type WarmupNetworkSearchParams = { q?: string };

/** The warmup pool, today's volume, the placement trend and the mailboxes matching the search. */
export async function loadWarmupNetworkPage(searchParams: WarmupNetworkSearchParams) {
  const identity = await requireAdmin();
  const q = (searchParams.q ?? '').trim().slice(0, 100);
  const canWrite = identity.role !== 'viewer';

  const [overview, today, trend, problems, mailboxes] = await Promise.all([
    getPoolOverview(),
    getTodayVolume(),
    getPlacementTrend(),
    listProblemMailboxes(),
    listPoolMailboxes(q),
  ]);

  return {
    q,
    canWrite,
    overview,
    today,
    trend,
    problems,
    mailboxes,
    mailboxTableLimit: MAILBOX_TABLE_LIMIT,
    trendDays: TREND_DAYS,
  };
}

export type WarmupNetworkPageData = NonNullable<Awaited<ReturnType<typeof loadWarmupNetworkPage>>>;
