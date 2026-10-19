import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { formatDateTime } from '@/lib/billing-format';
import { adminCopy } from '@/lib/i18n';
import type { MoveListRow } from '@/lib/databases-data';
import { Dash, WorkspaceLink } from './presentation';
import { MoveDestination, MoveStatusBadge, moveKindLabel } from './move-presentation';

/** Moves across workspaces, for the overview. A move is followed and managed from its workspace's Database tab. */
export function MovesTable({ rows, emptyText }: Readonly<{ rows: MoveListRow[]; emptyText: string }>) {
  const t = adminCopy().databases.moves;

  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader className="[&_tr]:border-border/70">
          <TableRow>
            <TableHead className="text-[13.5px]">{t.columns.workspace}</TableHead>
            <TableHead className="w-36 text-[13.5px]">{t.columns.status}</TableHead>
            <TableHead className="text-[13.5px]">{t.columns.move}</TableHead>
            <TableHead className="text-[13.5px]">{t.columns.startedBy}</TableHead>
            <TableHead className="w-44 text-[13.5px]">{t.columns.started}</TableHead>
            <TableHead className="w-44 text-[13.5px]">{t.columns.ended}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="[&_tr]:border-border/70">
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                {emptyText}
              </TableCell>
            </TableRow>
          )}
          {rows.map((row) => (
            <TableRow key={row.id} className="align-top hover:bg-muted/50">
              <TableCell className="min-w-0 py-2.5">
                <WorkspaceLink id={row.workspaceId} name={row.workspaceName} />
              </TableCell>
              <TableCell className="py-2.5">
                <MoveStatusBadge status={row.status} />
              </TableCell>
              <TableCell className="whitespace-normal py-2.5">
                <div className="text-sm">{moveKindLabel(row.kind)}</div>
                <MoveDestination requestedTarget={row.requestedTarget} targetShardId={row.targetSharedProjectId} />
                {row.error && <p className="mt-1 text-xs text-destructive">{row.error}</p>}
              </TableCell>
              <TableCell className="py-2.5 text-xs">{row.startedBy}</TableCell>
              <TableCell className="py-2.5 text-xs tabular-nums text-muted-foreground">
                {formatDateTime(row.createdAt)}
              </TableCell>
              <TableCell className="py-2.5 text-xs tabular-nums text-muted-foreground">
                {row.completedAt ? formatDateTime(row.completedAt) : <Dash />}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
