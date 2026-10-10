/**
 * The order pipelines are listed in the CRM sidebar: oldest first, ties broken
 * by id. A pipeline created in-session is appended at the end of the sidebar,
 * so the list a reload fetches has to be in the same order, or the sidebar
 * reshuffles on every refresh (TASK-1087). The API (`GET /api/pipelines`)
 * returns this order already; sorting again here keeps the sidebar stable even
 * against a response that was not ordered (an older deploy, a cached payload).
 */
export function sortPipelines<T extends { id: string; createdAt?: string | null }>(
  pipelines: readonly T[],
): T[] {
  const time = (value: string | null | undefined): number => {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  };
  return [...pipelines].sort((a, b) => {
    const byTime = time(a.createdAt) - time(b.createdAt);
    // `Infinity - Infinity` is NaN: two pipelines without a usable date tie.
    if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
    if (a.id < b.id) return -1;
    return a.id > b.id ? 1 : 0;
  });
}
