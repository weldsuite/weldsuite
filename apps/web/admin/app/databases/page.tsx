import { Boxes, Database, Layers, Server } from 'lucide-react';
import { requireAdmin } from '@/lib/auth';
import { getDatabasesOverview } from '@/lib/databases-data';
import { shardFill } from '@/lib/databases';
import { adminCopy, fill } from '@/lib/i18n';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { SectionHeading, StatCard } from '@/components/databases/presentation';
import { ShardsTable } from '@/components/databases/shards-table';
import { DedicatedTable } from '@/components/databases/dedicated-table';
import { PoolSlotsTable, PoolSummaryTable } from '@/components/databases/pool-tables';

export const dynamic = 'force-dynamic';

/**
 * Where workspace databases live: shared shards, dedicated Neon projects and the
 * warm pool. Read-only, and read from the master database only (task 1150,
 * phase 1). Every admin role may look, viewers included.
 */
export default async function DatabasesPage() {
  await requireAdmin();
  const t = adminCopy().databases;
  const { summary, shards, dedicated, pool } = await getDatabasesOverview();

  let withoutDatabaseHint: string | undefined;
  if (summary.withoutDatabase > 0) {
    withoutDatabaseHint =
      summary.withoutDatabaseFailed > 0
        ? fill(t.summary.withoutDatabaseFailed, { count: summary.withoutDatabaseFailed })
        : t.summary.withoutDatabaseNoneFailed;
  }

  return (
    <PageContent>
      <PageBody className="space-y-8">
        <PageHeading
          title={
            <span className="flex items-center gap-2">
              <Database className="h-6 w-6 text-primary" />
              {t.title}
            </span>
          }
          description={t.description}
        />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <StatCard label={t.summary.shards} value={summary.shardCount} />
          <StatCard
            label={t.summary.capacity}
            value={`${summary.used} / ${summary.capacity}`}
            hint={`${shardFill(summary.used, summary.capacity).percent}%`}
          />
          <StatCard label={t.summary.dedicated} value={summary.dedicatedProjects} />
          <StatCard label={t.summary.warmShared} value={summary.warmShared} />
          <StatCard label={t.summary.warmDedicated} value={summary.warmDedicated} />
          <StatCard label={t.summary.withoutDatabase} value={summary.withoutDatabase} hint={withoutDatabaseHint} />
        </div>

        <section className="space-y-3">
          <SectionHeading icon={Layers} title={t.shards.title} count={shards.length} description={t.shards.description} />
          <ShardsTable shards={shards} />
        </section>

        <section className="space-y-3">
          <SectionHeading
            icon={Server}
            title={t.dedicated.title}
            count={dedicated.total}
            description={t.dedicated.description}
          />
          <DedicatedTable dedicated={dedicated} />
        </section>

        <section className="space-y-3">
          <SectionHeading icon={Boxes} title={t.pool.title} description={t.pool.description} />
          <PoolSummaryTable groups={pool.groups} />
          <PoolSlotsTable
            slots={pool.slots}
            showKind
            showLocation
            showWorkspace={false}
            emptyText={t.pool.noUnassigned}
          />
          <p className="text-xs text-muted-foreground">
            {fill(t.pool.listedNote, { assigned: pool.assignedTotal })}
            {pool.unassignedTotal > pool.slots.length && (
              <>
                {' '}
                {fill(t.pool.truncated, { shown: pool.slots.length, total: pool.unassignedTotal })}
              </>
            )}
          </p>
        </section>
      </PageBody>
    </PageContent>
  );
}
