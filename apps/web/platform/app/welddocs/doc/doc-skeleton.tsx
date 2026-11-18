import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { RoutePendingSkeleton } from '@/components/route-pending-skeleton';
import { usePathname } from '@/lib/router';

/** Widths of the toolbar's placeholder controls: icons, with the zoom, style and font pickers wider. */
const TOOL_WIDTHS = ['w-6', 'w-6', 'w-6', 'w-12', 'w-20', 'w-20', 'w-6', 'w-8', 'w-6', 'w-6', 'w-6', 'w-6', 'w-6', 'w-6', 'w-6', 'w-6'];
/** The page's placeholder lines, as a share of the text column. */
const LINE_WIDTHS = ['45%', '100%', '96%', '100%', '72%', '0', '100%', '92%', '64%'];

/** A WeldDocs path that opens one document (`…/welddocs/<id>`), not the list. */
export function isDocPath(pathname: string): boolean {
  return /\/welddocs\/[^/]+\/?$/.test(pathname);
}

/**
 * Pending UI of the `/welddocs` route, which loads first on a page load: a
 * document's shape on a document's URL, the generic skeleton on the list.
 */
export function WeldDocsPendingSkeleton() {
  const pathname = usePathname();
  return isDocPath(pathname) ? <DocSkeleton withAppHeader /> : <RoutePendingSkeleton />;
}

/**
 * A document while it loads: the editor's header row, toolbar, ruler and a
 * blank page, so it opens in place instead of jumping in from the generic
 * (dashboard-shaped) route skeleton. `withAppHeader` adds the app's
 * breadcrumb bar above it, for when the WeldDocs layout (which draws that
 * bar) has not loaded yet either.
 */
export function DocSkeleton({ withAppHeader = false }: { withAppHeader?: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-slot="doc-pending" aria-busy="true">
      {withAppHeader && (
        // The app header (h-[60px], desktop only), as in the WeldMail skeleton.
        <div className="hidden h-[60px] shrink-0 items-center gap-2 border-b border-border px-4 md:flex">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-32" />
        </div>
      )}
      <div className="flex h-[53px] shrink-0 items-center justify-between gap-3 border-b border-border px-3 md:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Skeleton className="size-[30px] shrink-0 rounded-md" />
          <Skeleton className="h-5 w-48 max-w-[40vw]" />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Skeleton className="size-7 rounded-[32%]" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-16" />
        </div>
      </div>
      <div className="flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b bg-muted/30 px-3">
        {TOOL_WIDTHS.map((width, i) => (
          <Skeleton key={i} className={`h-5 shrink-0 ${width}`} />
        ))}
      </div>
      <div className="h-6 shrink-0 border-b bg-muted/30" />
      <div className="min-h-0 flex-1 overflow-hidden bg-muted/60 px-4 pt-4">
        {/* An A4 page; always white, like the pages it stands in for. */}
        <div className="mx-auto aspect-[210/297] w-full max-w-[794px] bg-white px-[12%] pt-[12%] shadow-[0_1px_3px_rgba(60,64,67,0.3),0_4px_8px_3px_rgba(60,64,67,0.15)]">
          <div className="flex flex-col gap-3">
            {LINE_WIDTHS.map((width, i) => (
              <div key={i} className="h-3 animate-pulse rounded bg-neutral-200" style={{ width }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
