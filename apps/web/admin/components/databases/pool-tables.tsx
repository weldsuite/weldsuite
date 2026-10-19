import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { formatDate } from '@/app/workspaces/workspace-presentation';
import { adminCopy } from '@/lib/i18n';
import type { PoolGroup, PoolSlotRow } from '@/lib/databases-data';
import { Dash, Mono, PoolStatusBadge, ShardLink, WorkspaceLink, lookup } from './presentation';

/** Pool slots by kind and status, with how many sit at each schema version. */
export function PoolSummaryTable({ groups }: Readonly<{ groups: PoolGroup[] }>) {
  const t = adminCopy().databases;

  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader className="[&_tr]:border-border/70">
          <TableRow>
            <TableHead className="w-40 text-[13.5px]">{t.pool.summaryColumns.kind}</TableHead>
            <TableHead className="w-40 text-[13.5px]">{t.pool.summaryColumns.status}</TableHead>
            <TableHead className="w-28 text-right text-[13.5px]">{t.pool.summaryColumns.slots}</TableHead>
            <TableHead className="text-[13.5px]">{t.pool.summaryColumns.schema}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="[&_tr]:border-border/70">
          {groups.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="py-12 text-center text-sm text-muted-foreground">
                {t.pool.empty}
              </TableCell>
            </TableRow>
          )}
          {groups.map((group) => (
            <TableRow key={`${group.kind}:${group.status}`} className="align-top hover:bg-muted/50">
              <TableCell className="py-2.5 text-sm">{lookup(t.pool.kind, group.kind)}</TableCell>
              <TableCell className="py-2.5">
                <PoolStatusBadge status={group.status} />
              </TableCell>
              <TableCell className="py-2.5 text-right text-sm tabular-nums">{group.count}</TableCell>
              <TableCell className="whitespace-normal py-2.5">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {group.schemaVersions.map((entry) => (
                    <span key={entry.version ?? 'unknown'} className="text-xs">
                      {entry.version ? <Mono>{entry.version}</Mono> : t.pool.schemaUnknown}
                      <span className="ml-1 tabular-nums text-muted-foreground">×{entry.count}</span>
                    </span>
                  ))}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Individual pool slots. The overview lists the unassigned ones with their
 * location; a shard's own page already says where they are, so it drops the
 * kind and location and shows who got the assigned ones.
 */
export function PoolSlotsTable({
  slots,
  showKind,
  showLocation,
  showWorkspace,
  emptyText,
}: Readonly<{
  slots: PoolSlotRow[];
  showKind: boolean;
  showLocation: boolean;
  showWorkspace: boolean;
  emptyText: string;
}>) {
  const t = adminCopy().databases;
  const columns = 5 + Number(showKind) + Number(showLocation) + Number(showWorkspace);

  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader className="[&_tr]:border-border/70">
          <TableRow>
            <TableHead className="text-[13.5px]">{t.pool.columns.slot}</TableHead>
            {showKind && <TableHead className="w-28 text-[13.5px]">{t.pool.columns.kind}</TableHead>}
            <TableHead className="w-32 text-[13.5px]">{t.pool.columns.status}</TableHead>
            {showLocation && <TableHead className="text-[13.5px]">{t.pool.columns.location}</TableHead>}
            <TableHead className="w-36 text-[13.5px]">{t.pool.columns.region}</TableHead>
            <TableHead className="w-48 text-[13.5px]">{t.pool.columns.schema}</TableHead>
            {showWorkspace && <TableHead className="text-[13.5px]">{t.pool.columns.workspace}</TableHead>}
            <TableHead className="w-32 text-[13.5px]">{t.pool.columns.created}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="[&_tr]:border-border/70">
          {slots.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns} className="py-12 text-center text-sm text-muted-foreground">
                {emptyText}
              </TableCell>
            </TableRow>
          )}
          {slots.map((slot) => (
            <TableRow key={slot.id} className="align-top hover:bg-muted/50">
              <TableCell className="py-2.5">
                <Mono>{slot.id}</Mono>
              </TableCell>
              {showKind && <TableCell className="py-2.5 text-sm">{lookup(t.pool.kind, slot.kind)}</TableCell>}
              <TableCell className="py-2.5">
                <PoolStatusBadge status={slot.status} />
              </TableCell>
              {showLocation && (
                <TableCell className="min-w-0 py-2.5">
                  {slot.shardId ? (
                    <ShardLink id={slot.shardId} name={slot.shardName ?? slot.shardId} />
                  ) : (
                    <Mono>{slot.neonProjectId}</Mono>
                  )}
                </TableCell>
              )}
              <TableCell className="py-2.5 text-xs">{slot.region}</TableCell>
              <TableCell className="py-2.5 text-xs">
                {slot.schemaVersion ? <Mono>{slot.schemaVersion}</Mono> : t.pool.schemaUnknown}
              </TableCell>
              {showWorkspace && (
                <TableCell className="min-w-0 py-2.5">
                  {slot.assignedWorkspaceId ? (
                    <WorkspaceLink
                      id={slot.assignedWorkspaceId}
                      name={slot.assignedWorkspaceName ?? slot.assignedWorkspaceId}
                    />
                  ) : (
                    <Dash />
                  )}
                </TableCell>
              )}
              <TableCell className="py-2.5 text-xs tabular-nums text-muted-foreground">
                {formatDate(slot.createdAt, false)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
