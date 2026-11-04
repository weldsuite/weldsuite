/**
 * WeldFlow approvals hooks (project-control slice A).
 *
 * Shell stub: slice A replaces this whole file. Keep `useMyReviewsCount`
 * exported with the same call shape; the WeldFlow sidebar reads it for the
 * "My reviews" badge, and it runs wherever the sidebar does, so the real hook
 * has to stay cheap.
 */

/** How many approvals wait for the current user. */
export function useMyReviewsCount(): { data: number } {
  return { data: 0 };
}
