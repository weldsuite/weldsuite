import { Database } from 'lucide-react';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { formatDate } from '@/app/workspaces/workspace-presentation';
import { adminCopy, fill } from '@/lib/i18n';
import type { WorkspaceDatabase } from '@/lib/databases-data';
import { Dash, FillBar, Mono, Notice, PlacementBadge, ProvisioningBadge, ShardLink } from './presentation';

/**
 * The workspace detail's Database tab: where this workspace's database lives.
 * Read-only: moving a workspace is a later release, and the note says so.
 */
export function WorkspaceDatabaseCard({ database }: Readonly<{ database: WorkspaceDatabase }>) {
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
  if (database.sharedProjectId) rows.push([w.shardLink, mono(database.sharedProjectId)]);

  return (
    <div className="space-y-3">
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

      <p className="text-xs text-muted-foreground">{w.moveNote}</p>
    </div>
  );
}
