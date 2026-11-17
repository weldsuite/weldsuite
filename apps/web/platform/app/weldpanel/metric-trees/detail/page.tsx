/**
 * One metric tree: every node's value for the period, its change against the
 * period before, how it drives its parent and (for influences) how closely
 * its daily values follow the parent's. Owners can edit it.
 */

import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Pencil } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelMetricTreeNodeValue } from '@weldsuite/app-api-client/schemas/weldpanel-analysis';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { DetailHeader, DetailPage } from '@weldsuite/ui/components/page-layout';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { cn } from '@weldsuite/ui/lib/utils';
import { useWeldPanelMetricTree, useWeldPanelMetricTreeValues } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { ChartCard } from '../../components/chart-card';
import { DateRangePicker } from '../../components/date-range-picker';
import { PanelDefinitionsProvider } from '../../components/definitions';
import { FreshnessBadge } from '../../components/freshness-badge';
import { QueryErrorState } from '../../components/query-error-state';
import { isNotFoundError } from '../../lib/api-errors';
import { csvFilename } from '../../lib/csv';
import { browserTimezone, useDateRange } from '../../lib/date-range';
import { metricTreeCsvRows } from '../../lib/explore-csv';
import { formatNumber, formatSignedPercent } from '../../lib/format';
import { MetricTreeEditor } from '../editor';
import { treeOrder } from '../tree-draft';

function NodeCard({ node, depth, parentLabel }: Readonly<{ node: PanelMetricTreeNodeValue; depth: number; parentLabel: string | null }>) {
  const { t, language, format } = useI18n();
  const tx = t.weldpanel.explore.metricTrees;
  const relation = node.relation ? tx.editor.relations[node.relation] : null;
  const errorText = node.error ? (tx.view.errors[node.error as keyof typeof tx.view.errors] ?? tx.view.errors.other) : null;
  let tone = 'text-muted-foreground';
  if (node.changePercent !== null && node.changePercent > 0) tone = 'text-emerald-600 dark:text-emerald-400';
  else if (node.changePercent !== null && node.changePercent < 0) tone = 'text-destructive';
  const value = (v: number | null) => (v === null ? tx.view.noValue : new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(v));

  return (
    <li className="relative" style={{ paddingLeft: `${Math.min(depth, 5) * 1.5}rem` }}>
      {depth > 0 && <span className="absolute top-0 bottom-1/2 w-3 border-b border-l border-border" style={{ left: `${(Math.min(depth, 5) - 1) * 1.5 + 0.5}rem` }} aria-hidden />}
      <div className={cn('grid gap-1 rounded-lg border bg-card p-3', depth === 0 && 'border-primary/40 bg-primary/5')}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="min-w-0 truncate text-sm font-medium" title={node.label}>
            {node.label}
            {relation && parentLabel && <span className="ml-2 text-xs font-normal text-muted-foreground">{relation} · {parentLabel}</span>}
          </p>
          <div className="flex items-baseline gap-3">
            <span className="text-xl font-semibold tabular-nums">{errorText ? '–' : value(node.value)}</span>
            {node.changePercent !== null && !errorText && <span className={cn('text-sm tabular-nums', tone)}>{formatSignedPercent(node.changePercent, language)}</span>}
          </div>
        </div>
        {errorText ? (
          <p className="text-xs text-destructive">{errorText}</p>
        ) : (
          <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
            <span>{format(tx.view.previous, { value: value(node.previous) })}</span>
            {node.correlationWithParent !== null && <span>{format(tx.view.correlation, { value: formatNumber(Math.round(node.correlationWithParent * 100) / 100, language) })}</span>}
          </div>
        )}
      </div>
    </li>
  );
}

function TreeView({ treeId }: Readonly<{ treeId: string }>) {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.metricTrees;
  const router = useRouter();
  const { userId } = useAuth();
  const canUpdate = useCan('panel_reports:update');
  const [range, setRange] = useDateRange();
  const [editing, setEditing] = useState(false);
  const { data: tree, isLoading, error, refetch } = useWeldPanelMetricTree(treeId);
  const values = useWeldPanelMetricTreeValues(treeId, { dateRange: range, timezone: browserTimezone() }, tree !== undefined);

  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;
  if (error && isNotFoundError(error)) return <EmptyState title={tx.view.notFound} />;
  if (error || !tree) return <ErrorState message={tx.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;

  const ordered = treeOrder(values.data?.nodes ?? []);
  const labelOf = new Map((values.data?.nodes ?? []).map((n) => [n.id, n.label]));

  return (
    <PanelDefinitionsProvider projectId={tree.projectId}>
      <DetailPage className="mx-auto w-full max-w-5xl">
        <div className="space-y-4 p-4 sm:p-6">
          <DetailHeader
            onBack={() => router.push('/weldpanel/metric-trees')}
            backLabel={tx.view.back}
            title={tree.name}
            subtitle={tree.description ?? undefined}
            actions={
              <>
                <DateRangePicker value={range} onChange={setRange} />
                {canUpdate && tree.ownerUserId === userId && (
                  <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                    <Pencil />
                    {tx.view.edit}
                  </Button>
                )}
              </>
            }
          />

          <ChartCard
            title={tree.name}
            loading={values.isLoading}
            error={values.error}
            onRetry={() => void values.refetch()}
            csv={values.data ? () => ({ filename: csvFilename(tree.name), rows: metricTreeCsvRows(values.data!) }) : undefined}
          >
            {values.data && (
              <div className="grid gap-3">
                <ol className="grid gap-2" aria-label={tree.name}>
                  {ordered.map(({ node, depth }) => (
                    <NodeCard key={node.id} node={node} depth={depth} parentLabel={node.parentId ? (labelOf.get(node.parentId) ?? null) : null} />
                  ))}
                </ol>
                <FreshnessBadge dataAsOf={values.data.dataAsOf} fetching={values.isFetching} onRefresh={() => void values.refetch()} clampedToRetention={values.data.range?.clampedToRetention} />
              </div>
            )}
          </ChartCard>
        </div>
        <MetricTreeEditor projectId={tree.projectId} tree={tree} open={editing} onOpenChange={setEditing} />
      </DetailPage>
    </PanelDefinitionsProvider>
  );
}

export default function MetricTreePage() {
  const { treeId = '' } = useParams({ strict: false });
  if (!treeId) return <QueryErrorState error={new Error('Missing metric tree')} />;
  return <TreeView key={treeId} treeId={decodeURIComponent(treeId)} />;
}
