/**
 * Walk cursor pages of `GET /api/team-members`. The route caps each page at
 * 100 rows, so a single request cannot list a larger workspace.
 */

export interface MemberPage<T> {
  data: T[];
  pagination?: {
    hasMore?: boolean;
    cursor?: string | null;
  };
}

export async function collectWorkspaceMemberPages<T>(
  fetchPage: (cursor: string | null) => Promise<MemberPage<T>>,
  maxPages = 50,
): Promise<T[]> {
  const members: T[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const result = await fetchPage(cursor);
    members.push(...(result.data ?? []));
    const next = result.pagination?.hasMore ? result.pagination.cursor ?? null : null;
    if (!next || next === cursor) break;
    cursor = next;
  }

  return members;
}
