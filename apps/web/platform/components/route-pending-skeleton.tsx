import { Skeleton } from '@weldsuite/ui/components/skeleton';

/**
 * Global route-level pending UI. Rendered by the router (`defaultPendingComponent`)
 * in place of a route's component while its code chunk and/or loader data are
 * still resolving. The persistent app shell (sidebar, top bar) stays mounted —
 * only this inner content area swaps — so navigation commits instantly to a
 * page-shaped skeleton instead of freezing on the previous page for ~1s.
 *
 * Deliberately generic: a header band + a content band that reads as either a
 * table or a set of cards. Individual routes that want a closer match can still
 * set their own `pendingComponent`.
 */
export function RoutePendingSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-6 p-6" data-slot="route-pending">
      {/* Header: title + subtitle on the left, an action on the right */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-28 shrink-0" />
      </div>

      {/* A row of summary cards (collapses to fewer columns on small screens) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-3 rounded-lg border p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-16" />
          </div>
        ))}
      </div>

      {/* A content panel that approximates a table / list */}
      <div className="rounded-lg border">
        <div className="border-b p-4">
          <Skeleton className="h-5 w-40" />
        </div>
        <div className="divide-y">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 p-4">
              <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-32 shrink-0" />
              <Skeleton className="h-4 w-20 shrink-0" />
              <Skeleton className="h-4 w-16 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
