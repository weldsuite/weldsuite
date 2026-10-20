import { AlertTriangle } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { formatDate } from '@/app/workspaces/workspace-presentation';
import { adminCopy, fill } from '@/lib/i18n';
import type { ComputeState } from '@/lib/database-moves';
import type { DedicatedProjects } from '@/lib/databases-data';
import { ComputeBadge } from './move-presentation';
import { Dash, Mono, ProvisioningBadge, WorkspaceLink } from './presentation';

/** `compute` is the live state per Neon project id; without it the Compute column is left out. */
export function DedicatedTable({
  dedicated,
  compute = null,
}: Readonly<{
  dedicated: DedicatedProjects;
  compute?: ReadonlyMap<string, ComputeState> | null;
}>) {
  const t = adminCopy().databases;
  const columns = compute ? 6 : 5;

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader className="[&_tr]:border-border/70">
            <TableRow>
              <TableHead className="text-[13.5px]">{t.dedicated.columns.workspace}</TableHead>
              <TableHead className="text-[13.5px]">{t.dedicated.columns.project}</TableHead>
              <TableHead className="w-36 text-[13.5px]">{t.dedicated.columns.region}</TableHead>
              {compute && <TableHead className="w-28 text-[13.5px]">{t.compute.column}</TableHead>}
              <TableHead className="w-44 text-[13.5px]">{t.dedicated.columns.provisioned}</TableHead>
              <TableHead className="w-44 text-[13.5px]">{t.dedicated.columns.status}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr]:border-border/70">
            {dedicated.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={columns} className="py-12 text-center text-sm text-muted-foreground">
                  {t.dedicated.empty}
                </TableCell>
              </TableRow>
            )}
            {dedicated.rows.map((row) => (
              <TableRow key={row.workspaceId} className="align-top hover:bg-muted/50">
                <TableCell className="min-w-0 py-2.5">
                  <WorkspaceLink id={row.workspaceId} name={row.name} />
                  <div className="truncate text-xs text-muted-foreground">
                    <Mono>{row.slug}</Mono>
                    {row.planName ? ` · ${row.planName}` : ''}
                  </div>
                </TableCell>
                <TableCell className="py-2.5">
                  <Mono>{row.neonProjectId}</Mono>
                </TableCell>
                <TableCell className="py-2.5 text-xs">{row.region ?? <Dash />}</TableCell>
                {compute && (
                  <TableCell className="py-2.5">
                    {compute.has(row.neonProjectId) ? (
                      <ComputeBadge state={compute.get(row.neonProjectId) ?? 'unknown'} />
                    ) : (
                      <Dash />
                    )}
                  </TableCell>
                )}
                <TableCell className="py-2.5 text-xs tabular-nums text-muted-foreground">
                  {row.provisionedAt ? formatDate(row.provisionedAt, true) : <Dash />}
                </TableCell>
                <TableCell className="whitespace-normal py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <ProvisioningBadge status={row.provisioningStatus} />
                    {row.shardLinkDrift && (
                      <Badge variant="warning">
                        <AlertTriangle />
                        {t.dedicated.shardLinkDrift}
                      </Badge>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {dedicated.total > dedicated.rows.length && (
        <p className="text-xs text-muted-foreground">
          {fill(t.dedicated.truncated, {
            shown: dedicated.rows.length,
            total: dedicated.total,
          })}
        </p>
      )}
    </div>
  );
}
