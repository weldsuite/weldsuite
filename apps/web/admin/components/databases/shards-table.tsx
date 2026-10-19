import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { formatDate } from '@/app/workspaces/workspace-presentation';
import { adminCopy } from '@/lib/i18n';
import type { ShardSummary } from '@/lib/databases-data';
import { DriftBadge, FillBar, Mono, ShardLink, ShardStatusBadge } from './presentation';

export function ShardsTable({ shards }: Readonly<{ shards: ShardSummary[] }>) {
  const t = adminCopy().databases;

  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader className="[&_tr]:border-border/70">
          <TableRow>
            <TableHead className="text-[13.5px]">{t.shards.columns.shard}</TableHead>
            <TableHead className="w-36 text-[13.5px]">{t.shards.columns.region}</TableHead>
            <TableHead className="w-28 text-[13.5px]">{t.shards.columns.status}</TableHead>
            <TableHead className="w-80 text-[13.5px]">{t.shards.columns.fill}</TableHead>
            <TableHead className="w-28 text-right text-[13.5px]">{t.shards.columns.workspaces}</TableHead>
            <TableHead className="w-28 text-right text-[13.5px]">{t.shards.columns.warmSlots}</TableHead>
            <TableHead className="w-32 text-[13.5px]">{t.shards.columns.created}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="[&_tr]:border-border/70">
          {shards.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="py-12 text-center text-sm text-muted-foreground">
                {t.shards.empty}
              </TableCell>
            </TableRow>
          )}
          {shards.map((shard) => (
            <TableRow key={shard.id} className="align-top hover:bg-muted/50">
              <TableCell className="min-w-0 py-2.5">
                <ShardLink id={shard.id} name={shard.neonProjectName} />
                <div className="truncate">
                  <Mono className="text-muted-foreground">{shard.neonProjectId}</Mono>
                </div>
              </TableCell>
              <TableCell className="py-2.5 text-xs">{shard.region}</TableCell>
              <TableCell className="py-2.5">
                <ShardStatusBadge status={shard.status} />
              </TableCell>
              <TableCell className="whitespace-normal py-2.5">
                <div className="space-y-1.5">
                  <FillBar fill={shard.fill} count={shard.databaseCount} max={shard.maxDatabases} />
                  <DriftBadge drift={shard.drift} />
                </div>
              </TableCell>
              <TableCell className="py-2.5 text-right text-sm tabular-nums">{shard.liveWorkspaces}</TableCell>
              <TableCell className="py-2.5 text-right text-sm tabular-nums">{shard.warmSlots}</TableCell>
              <TableCell className="py-2.5 text-xs tabular-nums text-muted-foreground">
                {formatDate(shard.createdAt, false)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
