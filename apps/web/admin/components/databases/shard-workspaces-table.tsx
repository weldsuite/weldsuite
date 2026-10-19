import { AlertTriangle } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { DotBadge, formatDate } from '@/app/workspaces/workspace-presentation';
import { adminCopy } from '@/lib/i18n';
import type { ShardWorkspaceRow } from '@/lib/databases-data';
import { Dash, Mono, ProvisioningBadge, WorkspaceLink } from './presentation';

/** The state column: scheduled for deletion, suspended, or plain active. Deleted workspaces never reach this table. */
function WorkspaceState({ workspace: w }: Readonly<{ workspace: ShardWorkspaceRow }>) {
  const t = adminCopy().databases;

  if (w.scheduledDeletionAt) {
    return (
      <div>
        <DotBadge tone="warning">{t.workspaceState.scheduled}</DotBadge>
        <div className="mt-1 text-[11px] text-muted-foreground">{formatDate(w.scheduledDeletionAt, true)}</div>
      </div>
    );
  }
  if (!w.isActive) return <DotBadge tone="secondary">{t.workspaceState.inactive}</DotBadge>;
  return <DotBadge tone="success">{t.workspaceState.active}</DotBadge>;
}

export function ShardWorkspacesTable({ workspaces }: Readonly<{ workspaces: ShardWorkspaceRow[] }>) {
  const t = adminCopy().databases;
  const columns = t.shard.workspaces.columns;

  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader className="[&_tr]:border-border/70">
          <TableRow>
            <TableHead className="text-[13.5px]">{columns.workspace}</TableHead>
            <TableHead className="w-28 text-[13.5px]">{columns.plan}</TableHead>
            <TableHead className="text-[13.5px]">{columns.database}</TableHead>
            <TableHead className="w-36 text-[13.5px]">{columns.provisioning}</TableHead>
            <TableHead className="w-44 text-[13.5px]">{columns.provisioned}</TableHead>
            <TableHead className="w-52 text-[13.5px]">{columns.state}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="[&_tr]:border-border/70">
          {workspaces.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-12 text-center text-sm text-muted-foreground">
                {t.shard.workspaces.empty}
              </TableCell>
            </TableRow>
          )}
          {workspaces.map((w) => (
            <TableRow key={w.id} className="align-top hover:bg-muted/50">
              <TableCell className="min-w-0 py-2.5">
                <WorkspaceLink id={w.id} name={w.name} />
                <div className="truncate text-muted-foreground">
                  <Mono>{w.id}</Mono>
                  {w.clerkOrgId && (
                    <>
                      {' · '}
                      <Mono>{w.clerkOrgId}</Mono>
                    </>
                  )}
                </div>
              </TableCell>
              <TableCell className="py-2.5 text-xs">{w.planName ?? <Dash />}</TableCell>
              <TableCell className="py-2.5">{w.databaseName ? <Mono>{w.databaseName}</Mono> : <Dash />}</TableCell>
              <TableCell className="py-2.5">
                <ProvisioningBadge status={w.provisioningStatus} />
              </TableCell>
              <TableCell className="py-2.5 text-xs tabular-nums text-muted-foreground">
                {w.provisionedAt ? formatDate(w.provisionedAt, true) : <Dash />}
              </TableCell>
              <TableCell className="whitespace-normal py-2.5">
                <div className="space-y-1.5">
                  <WorkspaceState workspace={w} />
                  {w.shardLinkDrift && (
                    <Badge variant="warning">
                      <AlertTriangle />
                      {t.shard.workspaces.shardLinkDrift}
                    </Badge>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
