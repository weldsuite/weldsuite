import { Skeleton } from '@weldsuite/ui/components/skeleton';

/**
 * WeldMail-specific route pending UI. Set as the `pendingComponent` on the
 * `/weldmail` route so entering the module shows a mail-shaped skeleton instead
 * of the generic dashboard skeleton (`RoutePendingSkeleton`), which reads as a
 * title + summary cards + table and looks nothing like the inbox.
 *
 * Mirrors the real layout: a module header band, a fixed-width conversation list
 * (see `MailSplitLayout` / `ConversationList` — 420px column, 53px toolbar,
 * `ConversationListItem` rows) and an empty detail pane on desktop.
 */
export function MailPendingSkeleton() {
  return (
    <div
      className="flex h-full flex-col overflow-hidden bg-white dark:bg-background"
      data-slot="mail-pending"
    >
      {/* Module header band — matches MailHeader / BreadcrumbHeader (h-[60px]) */}
      <div className="hidden md:flex h-[60px] shrink-0 items-center justify-between gap-2 px-4">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 w-8 rounded-md" />
        </div>
      </div>

      {/* Split layout: conversation list + detail pane */}
      <div className="flex flex-1 overflow-hidden">
        {/* Conversation list column (fixed width on desktop) */}
        <div className="flex w-full flex-col overflow-hidden border-gray-200 dark:border-border md:w-[420px] md:flex-shrink-0 md:border-r">
          {/* List toolbar — matches ConversationList header (h-[53px]) */}
          <div className="flex h-[53px] flex-shrink-0 items-center justify-between gap-2 border-b border-border px-4">
            <Skeleton className="h-8 w-20 rounded-md" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-8 rounded-md" />
              <Skeleton className="h-8 w-24 rounded-md" />
            </div>
          </div>

          {/* Conversation rows — matches ConversationListItem */}
          <div className="flex-1 overflow-hidden">
            {Array.from({ length: 9 }).map((_, i) => (
              <div
                key={i}
                className="border-b border-gray-100 px-4 py-3 dark:border-border"
              >
                <div className="flex items-start gap-2.5">
                  <Skeleton className="mt-[3px] h-7 w-7 shrink-0 rounded-[10px]" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Skeleton className="h-3.5 w-32" />
                      <Skeleton className="h-3 w-10 shrink-0" />
                    </div>
                    <Skeleton className="h-3.5 w-48 max-w-full" />
                    <Skeleton className="h-3 w-full max-w-[260px]" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Detail pane (desktop only) — empty/centred, like EmptyDetailState */}
        <div className="hidden flex-1 items-center justify-center bg-white dark:bg-background md:flex">
          <div className="flex flex-col items-center gap-3">
            <Skeleton className="h-[120px] w-[120px] rounded-2xl" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-64" />
          </div>
        </div>
      </div>
    </div>
  );
}
