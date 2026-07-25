import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@/lib/utils';
import type { WorkspaceRow } from '@/lib/workspaces-data';

/** Shared between the workspaces list and the workspace detail screen. */
export function formatDate(iso: string, withTime: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    dateStyle: 'medium',
    ...(withTime ? { timeStyle: 'short' } : {}),
  });
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
