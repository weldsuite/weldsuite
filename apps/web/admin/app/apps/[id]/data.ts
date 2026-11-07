import 'server-only';

import { requireAdmin } from '@/lib/auth';
import { getAppById } from '@/lib/apps-data';

/** Everything the edit app page shows; null when there is no such catalog entry. */
export async function loadEditAppPage(input: { id: string }) {
  await requireAdmin();
  const app = await getAppById(input.id);
  if (!app) return null;

  return { app };
}

export type EditAppPageData = NonNullable<Awaited<ReturnType<typeof loadEditAppPage>>>;
