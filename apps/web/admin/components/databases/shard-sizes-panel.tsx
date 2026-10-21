'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { HardDrive } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { measureShardSizesAction } from '@/actions/databases';
import { formatBytes, type ShardSizes } from '@/lib/database-moves';
import { adminCopy, fill } from '@/lib/i18n';
import { Mono, WorkspaceLink } from './presentation';

/**
 * The size of every database on a shard, measured on request only: it runs a
 * query on the shard and so wakes its compute. Viewers get the explanation
 * instead of the button.
 */
export function ShardSizesPanel({
  shardId,
  canMeasure,
  workspaceNames,
}: Readonly<{
  shardId: string;
  canMeasure: boolean;
  /** Names of the workspaces on the shard, by id, to label the databases. */
  workspaceNames: Readonly<Record<string, string>>;
}>) {
  const t = adminCopy().databases.sizes;
  const [sizes, setSizes] = useState<ShardSizes | null>(null);
  const [isPending, startTransition] = useTransition();

  const measure = () =>
    startTransition(async () => {
      const result = await measureShardSizesAction(shardId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setSizes(result.data);
    });

  const rows = sizes ? [...sizes.databases].sort((a, b) => b.sizeBytes - a.sizeBytes) : [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">{t.title}</h2>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">{t.description}</p>
        </div>
        {canMeasure ? (
          <Button size="sm" variant="outline" disabled={isPending} onClick={measure}>
            {isPending ? t.measuring : t.measure}
          </Button>
        ) : (
          <p className="max-w-xs text-xs text-muted-foreground sm:text-right">{t.viewerNote}</p>
        )}
      </div>

      {sizes && (
        <div className="space-y-2">
          <p className="text-xs tabular-nums text-muted-foreground">
            {fill(t.total, {
              size: formatBytes(sizes.totalBytes),
              count: sizes.databases.length,
            })}
          </p>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader className="[&_tr]:border-border/70">
                <TableRow>
                  <TableHead className="text-[13.5px]">{t.columns.database}</TableHead>
                  <TableHead className="text-[13.5px]">{t.columns.workspace}</TableHead>
                  <TableHead className="w-32 text-right text-[13.5px]">{t.columns.size}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr]:border-border/70">
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                      {t.empty}
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((row) => (
                  <TableRow key={row.databaseName}>
                    <TableCell className="py-2.5">
                      <Mono>{row.databaseName}</Mono>
                    </TableCell>
                    <TableCell className="py-2.5">
                      {row.workspaceId ? (
                        <WorkspaceLink id={row.workspaceId} name={workspaceNames[row.workspaceId] ?? row.workspaceId} />
                      ) : (
                        <span className="text-xs text-muted-foreground">{t.noWorkspace}</span>
                      )}
                    </TableCell>
                    <TableCell className="py-2.5 text-right text-sm tabular-nums">
                      {formatBytes(row.sizeBytes)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </section>
  );
}
