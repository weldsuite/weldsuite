import { Database } from 'lucide-react';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { formatDate } from '@/app/workspaces/workspace-presentation';
import { adminCopy, fill } from '@/lib/i18n';
import type { ComputeState } from '@/lib/database-moves';
import type { WorkspaceDatabase } from '@/lib/databases-data';
import { ComputeBadge } from './move-presentation';
import { Dash, FillBar, Mono, Notice, PlacementBadge, ProvisioningBadge, ShardLink } from './presentation';

/**
 * Where this workspace's database lives, on its Database tab, with the live
 * state of the compute it runs on when the workspace worker could tell.
 */
export function WorkspaceDatabaseCard({
  database,
  compute,
}: Readonly<{ database: WorkspaceDatabase; compute: ComputeState | null }>) {
  const t = adminCopy().databases;
  const w = t.workspace;

  const mono = (value: string | null) => (value ? <Mono>{value}</Mono> : <Dash />);

  const rows: Array<[string, React.ReactNode]> = [[w.placement, <PlacementBadge key="placement" placement={database.placement} />]];
  if (database.shard) {
    rows.push([w.shard, <ShardLink key="shard" id={database.shard.id} name={database.shard.name} />]);
    rows.push([
      w.shardFill,
      <FillBar
        key="fill"
        fill={database.shard.fill}
        count={database.shard.databaseCount}
        max={database.shard.maxDatabases}
      />,
    ]);
  }
  rows.push(
    [w.neonProject, mono(database.neonProjectId)],
    [w.databaseName, mono(database.databaseName)],
    [w.roleName, mono(database.roleName)],
    [w.branch, mono(database.branchId)],
    [w.region, database.region ?? <Dash />],
    [w.provisioning, <ProvisioningBadge key="provisioning" status={database.provisioningStatus} />],
    [w.provisionedAt, database.provisionedAt ? formatDate(database.provisionedAt, true) : <Dash />],
  );
  if (database.neonProjectId)
    rows.push([w.compute, compute ? <ComputeBadge key="compute" state={compute} /> : <Dash />]);
  if (database.sharedProjectId) rows.push([w.shardLink, mono(database.sharedProjectId)]);

  return (
    <Card className="py-4">
      <CardContent className="space-y-4 px-4">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">{w.title}</h2>
        </div>

        <p className="text-sm text-muted-foreground">{w.hint[database.placement]}</p>

        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-4 border-b border-border/50 pb-1.5">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-all text-right">{value}</dd>
            </div>
          ))}
        </dl>

        {database.shardLinkDrift && database.sharedProjectId && (
          <Notice tone="warning">{fill(w.shardLinkDrift, { id: database.sharedProjectId })}</Notice>
        )}
      </CardContent>
    </Card>
  );
}
