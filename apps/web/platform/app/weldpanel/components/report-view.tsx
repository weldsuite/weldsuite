/**
 * Runs a saved report and draws it compactly: the body of a dashboard tile.
 * The spec (the tile's, with the dashboard's filters applied, or the
 * report's own) is parsed with the contract's schema first, so a report
 * whose spec no longer fits shows an error instead of failing the request.
 *
 * `ReportResultBody` draws a result that is already there; the public share
 * page uses it with the results of its own (session-less) API.
 */

import { useMemo, type ReactNode } from 'react';
import {
  panelReportSpecSchema,
  type PanelFunnelSpec,
  type PanelQueryResponse,
  type PanelQuerySpec,
  type ParsedImpactSpec,
  type ParsedTrendsSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useWeldPanelQuery } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { ChartAnnotationsProvider } from './charts/annotations-context';
import { FlowsResultView } from './results/flows-result';
import { FunnelResultView } from './results/funnel-result';
import { ImpactResultView } from './results/impact-result';
import { LifecycleResultView } from './results/lifecycle-result';
import { RetentionResultView } from './results/retention-result';
import { SignalResultView } from './results/signal-result';
import { StickinessResultView } from './results/stickiness-result';
import { TrendsResultView } from './results/trends-result';
import { VitalsSummaryView } from './results/vitals-result';
import { WebChart, WebKpis } from './results/web-result';
import { QueryErrorState } from './query-error-state';
import { FreshnessBadge } from './freshness-badge';

/** A stored spec as the query schema reads it today, or null when it no longer fits. */
export function parseReportSpec(spec: Record<string, unknown>, projectId: string): PanelQuerySpec | null {
  const parsed = panelReportSpecSchema.safeParse({ ...spec, projectId });
  return parsed.success ? (parsed.data as PanelQuerySpec) : null;
}

interface ReportResultBodyProps {
  data: PanelQueryResponse;
  /** The parsed spec the result answers (display and funnel steps come from it). */
  spec: PanelQuerySpec;
  projectId: string;
}

/** A report result, drawn small. */
export function ReportResultBody({ data, spec, projectId }: Readonly<ReportResultBodyProps>): ReactNode {
  const { t } = useI18n();
  switch (data.kind) {
    case 'web':
      return (
        <div className="grid gap-3">
          <WebKpis result={data.result} />
          <WebChart result={data.result} className="h-48" />
        </div>
      );
    case 'trends':
      return <TrendsResultView result={data.result} chartType={(spec as ParsedTrendsSpec).display ?? 'line'} className="h-48" />;
    case 'funnel':
      return <FunnelResultView result={data.result} spec={spec as PanelFunnelSpec} projectId={projectId} compact />;
    case 'retention':
      return <RetentionResultView result={data.result} />;
    case 'flows':
      return <FlowsResultView result={data.result} compact />;
    case 'stickiness':
      return <StickinessResultView result={data.result} compact />;
    case 'lifecycle':
      return <LifecycleResultView result={data.result} compact />;
    case 'vitals':
      return <VitalsSummaryView result={data.result} />;
    case 'impact':
      return <ImpactResultView result={data.result} math={(spec as ParsedImpactSpec).metric?.math} compact />;
    case 'signal':
      return <SignalResultView result={data.result} />;
    default:
      return <p className="text-sm text-muted-foreground">{t.weldpanel.analytics.common.noData}</p>;
  }
}

interface ReportViewProps {
  report: PanelReportDto;
  /** What to run instead of the report's own spec: a dashboard tile's spec, with the dashboard's filters applied. */
  spec?: Record<string, unknown> | null;
  className?: string;
}

export function ReportView({ report, spec: override, className }: Readonly<ReportViewProps>) {
  const spec = useMemo(() => parseReportSpec(override ?? report.spec, report.projectId), [override, report.spec, report.projectId]);
  const { data, error, isLoading, isFetching, refetch } = useWeldPanelQuery(spec ?? { kind: 'web', projectId: '' }, { enabled: spec !== null });

  if (!spec) return <QueryErrorState error={new Error('Invalid report')} onRetry={undefined} className={className} />;
  if (error) return <QueryErrorState error={error} onRetry={() => void refetch()} className={className} />;
  if (isLoading || !data) return <Skeleton className="h-40 w-full" />;

  return (
    <div className={className}>
      {/* The tile's charts show the project's annotations and this report's own. */}
      <ChartAnnotationsProvider projectId={report.projectId} reportId={report.id}>
        <ReportResultBody data={data} spec={spec} projectId={report.projectId} />
      </ChartAnnotationsProvider>
      <div className="mt-2">
        <FreshnessBadge dataAsOf={data.dataAsOf} cached={data.cached} fetching={isFetching} />
      </div>
    </div>
  );
}
