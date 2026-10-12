import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@/lib/utils';
import { STATUS_LABELS, type AppAccessStatus } from '@/lib/app-access';

const TONE: Record<AppAccessStatus, { variant: 'success' | 'warning' | 'secondary' | 'destructive'; dot: string }> = {
  requested: { variant: 'warning', dot: 'bg-amber-500' },
  approved: { variant: 'success', dot: 'bg-emerald-500' },
  rejected: { variant: 'destructive', dot: 'bg-white' },
  suspended: { variant: 'warning', dot: 'bg-amber-500' },
  revoked: { variant: 'secondary', dot: 'bg-muted-foreground/40' },
};

/** The state of a workspace's access to an app, as a pill with a leading dot. */
export function AccessStatusBadge({ status }: Readonly<{ status: AppAccessStatus | 'none' }>) {
  if (status === 'none') {
    return (
      <Badge variant="outline" className="gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
        No request
      </Badge>
    );
  }
  const tone = TONE[status];
  return (
    <Badge variant={tone.variant} className="gap-1.5">
      <span className={cn('h-1.5 w-1.5 rounded-full', tone.dot)} />
      {STATUS_LABELS[status]}
    </Badge>
  );
}
