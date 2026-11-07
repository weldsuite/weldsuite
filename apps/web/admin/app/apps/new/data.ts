import '@tanstack/react-start/server-only';

import { requireAdmin } from '@/lib/auth';

/** The new app page reads nothing; the loader only holds the admin check. */
export async function loadNewAppPage() {
  await requireAdmin();
  return {};
}

export type NewAppPageData = NonNullable<Awaited<ReturnType<typeof loadNewAppPage>>>;
