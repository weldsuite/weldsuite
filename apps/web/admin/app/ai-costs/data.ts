import 'server-only';

import { requireAdmin } from '@/lib/auth';
import { getGatewayCredits, getSpendByGatewayMonth, getTopModelsByCost } from '@/lib/ai-costs-data';

/** A rollup older than this means the cron is wedged and the numbers are stale. */
const ROLLUP_STALE_MS = 10 * 60 * 1000;

/** Everything the AI gateway costs page shows. */
export async function loadAiCostsPage() {
  await requireAdmin();

  const [credits, byMonth, topModels] = await Promise.all([
    getGatewayCredits(),
    getSpendByGatewayMonth(),
    getTopModelsByCost(),
  ]);

  const now = Date.now();
  const stale = credits.filter(
    (c) => !c.lastRolledUpAt || now - c.lastRolledUpAt.getTime() > ROLLUP_STALE_MS,
  );

  return { credits, byMonth, topModels, stale };
}

export type AiCostsPageData = NonNullable<Awaited<ReturnType<typeof loadAiCostsPage>>>;
