import { AlertTriangle } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { formatDate } from '@/app/workspaces/workspace-presentation';
import { adminCopy, fill } from '@/lib/i18n';
import type { DedicatedProjects } from '@/lib/databases-data';
import { Dash, Mono, ProvisioningBadge, WorkspaceLink } from './presentation';

export function DedicatedTable({ dedicated }: Readonly<{ dedicated: DedicatedProjects }>) {
  const t = adminCopy().databases;

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader className="[&_tr]:border-border/70">
            <TableRow>
              <TableHead className="text-[13.5px]">{t.dedicated.columns.workspace}</TableHead>
              <TableHead className="text-[13.5px]">{t.dedicated.columns.project}</TableHead>
              <TableHead className="w-36 text-[13.5px]">{t.dedicated.columns.region}</TableHead>
              <TableHead className="w-44 text-[13.5px]">{t.dedicated.columns.provisioned}</TableHead>
              <TableHead className="w-44 text-[13.5px]">{t.dedicated.columns.status}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr]:border-border/70">
            {dedicated.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-12 text-center text-sm text-muted-foreground">
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
          {fill(t.dedicated.truncated, { shown: dedicated.rows.length, total: dedicated.total })}
        </p>
      )}
    </div>
  );
}
