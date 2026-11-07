import 'server-only';

import { requireAdmin } from '@/lib/auth';
import { listApps } from '@/lib/apps-data';
import { listPlanOptions } from '@/lib/billing-data';
import { getPartnerDetail } from '@/lib/partners-data';

/**
 * Everything the partner detail page shows; null when the worker says there is
 * no such partner. Any other worker failure comes back in `result` for the page
 * to show.
 */
export async function loadPartnerDetailPage(input: { id: string; tab?: string }) {
  const identity = await requireAdmin();

  const result = await getPartnerDetail(identity, input.id);
  if (!result.ok && result.code === 'NOT_FOUND') return null;

  const [plans, apps] = result.ok ? await Promise.all([listPlanOptions(), listApps()]) : [[], []];

  return {
    result,
    canWrite: identity.role !== 'viewer',
    planOptions: plans,
    appOptions: apps.map((a) => ({ code: a.code, name: a.name })),
    initialTab: input.tab,
    nowIso: new Date().toISOString(),
  };
}

export type PartnerDetailPageData = NonNullable<Awaited<ReturnType<typeof loadPartnerDetailPage>>>;
