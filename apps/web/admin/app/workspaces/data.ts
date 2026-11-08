import '@tanstack/react-start/server-only';

import { requireAdmin } from '@/lib/auth';
import { listWorkspaces } from '@/lib/workspaces-data';

export type WorkspacesSearchParams = { search?: string };

/** The workspaces matching the search. */
export async function loadWorkspacesPage(searchParams: WorkspacesSearchParams) {
  await requireAdmin();
  const search = (searchParams.search ?? '').trim();

  const workspaces = await listWorkspaces({ search });

  return { workspaces, search };
}

export type WorkspacesPageData = NonNullable<Awaited<ReturnType<typeof loadWorkspacesPage>>>;
