import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@/lib/utils';
import type { WorkspaceRow } from '@/lib/workspaces-data';

/**
 * Shared between the workspaces list and the workspace detail screen.
 *
 * Pinned to UTC on purpose. These strings are rendered by client components
 * that Next server-renders first: without an explicit zone the server formats
 * in its own zone (UTC) and the browser in the viewer's, so times — and dates
 * near midnight — differ between the SSR HTML and hydration. Deletion deadlines
 * are also the kind of value that shouldn't silently mean something different
 * depending on who's looking, hence the explicit "UTC" suffix on times.
 */
export function formatDate(iso: string, withTime: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const formatted = d.toLocaleString('en-GB', {
    timeZone: 'UTC',
    dateStyle: 'medium',
    ...(withTime ? { timeStyle: 'short' } : {}),
  });
  return withTime ? `${formatted} UTC` : formatted;
}

const DOT_TONE = {
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  secondary: 'bg-muted-foreground/40',
} as const;

/** Badge with a leading status dot, matching the platform's status pills. */
export function DotBadge({
  tone,
  children,
}: {
  tone: keyof typeof DOT_TONE;
  children: React.ReactNode;
}) {
  return (
    <Badge variant={tone} className="gap-1.5">
      <span className={cn('h-1.5 w-1.5 rounded-full', DOT_TONE[tone])} />
      {children}
    </Badge>
  );
}

/** Deletion lifecycle cell — the state pill plus its supporting detail lines. */
export function StatusBadge({ workspace: w }: { workspace: WorkspaceRow }) {
  if (w.deletionState === 'deleted') {
    return (
      <div>
        <DotBadge tone="secondary">Deleted</DotBadge>
        {w.deletedAt && (
          <div className="mt-1 text-[11px] text-muted-foreground">
            {formatDate(w.deletedAt, true)}
          </div>
        )}
      </div>
    );
  }

  if (w.deletionState === 'scheduled') {
    return (
      <div>
        <DotBadge tone="warning">Scheduled</DotBadge>
        {w.scheduledDeletionAt && (
          <div className="mt-1 text-[11px] text-muted-foreground">
            deletes {formatDate(w.scheduledDeletionAt, true)}
          </div>
        )}
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {w.adminInitiated ? `by ${w.deletionRequestedBy}` : 'trial-expiry policy'}
        </div>
        {w.deletionReason && (
          <div className="mt-0.5 truncate text-[11px] italic text-muted-foreground">
            “{w.deletionReason}”
          </div>
        )}
      </div>
    );
  }

  return <DotBadge tone="success">Active</DotBadge>;
}
