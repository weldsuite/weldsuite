import { ArrowRightLeft, Boxes, Database, Layers, Server } from 'lucide-react';
import { shardFill } from '@/lib/databases';
import { adminCopy, fill } from '@/lib/i18n';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { SectionHeading, StatCard } from '@/components/databases/presentation';
import { LiveStateNotice } from '@/components/databases/move-presentation';
import { MovesTable } from '@/components/databases/moves-table';
import { ShardsTable } from '@/components/databases/shards-table';
import { DedicatedTable } from '@/components/databases/dedicated-table';
import { PoolSlotsTable, PoolSummaryTable } from '@/components/databases/pool-tables';
import type { DatabasesPageData } from './data';

/**
 * Where workspace databases live: shared shards, dedicated Neon projects and the
 * warm pool, and the moves between them (task 1150). Every admin role may look,
 * viewers included; moves start from a workspace.
 */
export function DatabasesPage({
  summary,
  shards,
  dedicated,
  pool,
  moves,
  live,
  compute,
}: Readonly<DatabasesPageData>) {
  const t = adminCopy().databases;

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

        <LiveStateNotice state={live} />

        <section className="space-y-3">
          <SectionHeading
            icon={ArrowRightLeft}
            title={t.moves.overviewTitle}
            count={moves.active.length}
            description={t.moves.overviewDescription}
          />
          <MovesTable rows={moves.active} emptyText={t.moves.noActive} />
          {moves.recent.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t.moves.recentTitle}
              </h3>
              <MovesTable rows={moves.recent} emptyText={t.moves.noRecent} />
            </div>
          )}
        </section>

        <section className="space-y-3">
          <SectionHeading icon={Layers} title={t.shards.title} count={shards.length} description={t.shards.description} />
          <ShardsTable shards={shards} compute={compute} />
        </section>

        <section className="space-y-3">
          <SectionHeading
            icon={Server}
            title={t.dedicated.title}
            count={dedicated.total}
            description={t.dedicated.description}
          />
          <DedicatedTable dedicated={dedicated} compute={compute} />
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
