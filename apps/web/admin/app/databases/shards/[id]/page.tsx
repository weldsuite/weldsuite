import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Boxes, Building2, Layers } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { formatDate } from '@/app/workspaces/workspace-presentation';
import { requireAdmin } from '@/lib/auth';
import { getShard } from '@/lib/databases-data';
import { adminCopy, fill } from '@/lib/i18n';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import {
  Dash,
  DriftNotice,
  FillBar,
  Mono,
  SectionHeading,
  ShardStatusBadge,
} from '@/components/databases/presentation';
import { PoolSlotsTable } from '@/components/databases/pool-tables';
import { ShardWorkspacesTable } from '@/components/databases/shard-workspaces-table';

export const dynamic = 'force-dynamic';

/** One shared shard: how full it is, the workspaces on it and its pool slots. Read-only. */
export default async function ShardPage(props: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  await requireAdmin();
  const { id } = await props.params;

  const shard = await getShard(id);
  if (!shard) notFound();

  const t = adminCopy().databases;

  const mono = (value: string | null) => (value ? <Mono>{value}</Mono> : <Dash />);
  const details: Array<[string, React.ReactNode]> = [
    [t.shard.neonProject, mono(shard.neonProjectId)],
    [t.shard.projectName, shard.neonProjectName],
    [t.shard.region, shard.region],
    [t.shard.mainBranch, mono(shard.mainBranchId)],
    [t.shard.host, mono(shard.connectionHost)],
    [t.shard.adminRole, mono(shard.adminRole)],
    [t.shard.created, formatDate(shard.createdAt, true)],
    [t.shard.updated, formatDate(shard.updatedAt, true)],
    [t.shard.fill, <FillBar key="fill" fill={shard.fill} count={shard.databaseCount} max={shard.maxDatabases} />],
  ];

  return (
    <PageContent>
      <PageBody className="space-y-6">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2 text-muted-foreground">
            <Link href="/databases">
              <ArrowLeft className="h-4 w-4" />
              {t.back}
            </Link>
          </Button>

          <PageHeading
            title={
              <span className="flex items-center gap-2">
                <Layers className="h-6 w-6 text-primary" />
                {shard.neonProjectName}
              </span>
            }
            description={
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Mono>{shard.neonProjectId}</Mono>
                <span aria-hidden>·</span>
                <span className="text-xs">{shard.region}</span>
              </span>
            }
            actions={<ShardStatusBadge status={shard.status} />}
          />
        </div>

        <DriftNotice
          drift={shard.drift}
          liveWorkspaces={shard.liveWorkspaces}
          pendingTeardown={shard.pendingTeardown}
          warmSlots={shard.warmSlots}
        />

        <Card className="py-4">
          <CardContent className="space-y-4 px-4">
            <h2 className="text-sm font-medium">{t.shard.details}</h2>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
              {details.map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-4 border-b border-border/50 pb-1.5">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 break-all text-right">{value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <section className="space-y-3">
          <SectionHeading icon={Building2} title={t.shard.workspaces.title} count={shard.workspaces.length} />
          <ShardWorkspacesTable workspaces={shard.workspaces} />
          {shard.pendingTeardown > 0 && (
            <p className="text-xs text-muted-foreground">
              {fill(t.shard.workspaces.pendingTeardown, { count: shard.pendingTeardown })}
            </p>
          )}
        </section>

        <section className="space-y-3">
          <SectionHeading icon={Boxes} title={t.shard.slots.title} count={shard.slots.length} />
          <PoolSlotsTable
            slots={shard.slots}
            showKind={false}
            showLocation={false}
            showWorkspace
            emptyText={t.shard.slots.empty}
          />
        </section>
      </PageBody>
    </PageContent>
  );
}
