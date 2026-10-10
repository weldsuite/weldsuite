import Link from 'next/link';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { adminCopy } from '@/lib/i18n';
import { actionLabel, formatDateTime } from '@/lib/billing-format';
import type { AuditEventRow } from '@/lib/billing-types';

/** Admin audit trail rows. `showTarget` adds a link to the workspace or plan. */
export function ActivityTable({
  events,
  showTarget = false,
}: Readonly<{ events: AuditEventRow[]; showTarget?: boolean }>) {
  const t = adminCopy();

  if (events.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t.activity.empty}</p>;
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-44">{t.activity.columns.when}</TableHead>
            <TableHead className="w-52">{t.activity.columns.who}</TableHead>
            <TableHead className="w-56">{t.activity.columns.action}</TableHead>
            {showTarget && <TableHead className="w-48">{t.activity.columns.target}</TableHead>}
            <TableHead>{t.activity.columns.reason}</TableHead>
            <TableHead className="w-24">{t.activity.columns.result}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => (
            <TableRow key={event.id} className="align-top">
              <TableCell className="text-xs tabular-nums text-muted-foreground">{formatDateTime(event.createdAt)}</TableCell>
              <TableCell className="truncate text-xs">
                {event.actorEmail === 'system' ? t.activity.system : event.actorEmail}
              </TableCell>
              <TableCell className="text-sm">{actionLabel(t, event.action)}</TableCell>
              {showTarget && (
                <TableCell className="font-mono text-xs">
                  <Link
                    className="underline-offset-2 hover:underline"
                    href={event.targetType === 'plan' ? `/plans/${event.targetId}` : `/workspaces/${event.targetId}`}
                  >
                    {event.targetId}
                  </Link>
                </TableCell>
              )}
              <TableCell className="text-xs">
                <div className="text-muted-foreground">{event.reason ?? '—'}</div>
                {event.error && <div className="mt-0.5 text-destructive">{event.error}</div>}
              </TableCell>
              <TableCell>
                <Badge variant={event.outcome === 'success' ? 'success' : 'destructive'}>
                  {event.outcome === 'success' ? t.activity.success : t.activity.failure}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
