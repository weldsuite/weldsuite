import '@tanstack/react-start/server-only';

import { requireAdmin } from '@/lib/auth';

/** The new plan page reads nothing; it only needs to know whether the form is writable. */
export async function loadNewPlanPage() {
  const identity = await requireAdmin();

  return {
    canWrite: identity.role !== 'viewer',
  };
}

export type NewPlanPageData = NonNullable<Awaited<ReturnType<typeof loadNewPlanPage>>>;
