/**
 * Runs a saved report and draws it compactly: the body of a dashboard tile.
 * The stored spec is parsed with the contract's schema first, so a report
 * whose spec no longer fits shows an error instead of failing the request.
 */

import { useMemo } from 'react';
import { panelReportSpecSchema, type PanelFunnelSpec, type PanelQuerySpec, type ParsedTrendsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useWeldPanelQuery } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { FlowsResultView } from './results/flows-result';
import { FunnelResultView } from './results/funnel-result';
import { RetentionResultView } from './results/retention-result';
import { TrendsResultView } from './results/trends-result';
import { WebChart, WebKpis } from './results/web-result';
import { QueryErrorState } from './query-error-state';
import { FreshnessBadge } from './freshness-badge';

interface ReportViewProps {
  report: PanelReportDto;
  className?: string;
}

export function ReportView({ report, className }: Readonly<ReportViewProps>) {
  const { t } = useI18n();
  const parsed = useMemo(() => panelReportSpecSchema.safeParse({ ...report.spec, projectId: report.projectId }), [report.spec, report.projectId]);
  const spec = (parsed.success ? parsed.data : { kind: 'web', projectId: '' }) as PanelQuerySpec;
  const { data, error, isLoading, isFetching, refetch } = useWeldPanelQuery(spec, { enabled: parsed.success });

  if (!parsed.success) return <QueryErrorState error={new Error('Invalid report')} onRetry={undefined} className={className} />;
  if (error) return <QueryErrorState error={error} onRetry={() => void refetch()} className={className} />;
  if (isLoading || !data) return <Skeleton className="h-40 w-full" />;

  let body: React.ReactNode = null;
  switch (data.kind) {
    case 'web':
      body = (
        <div className="grid gap-3">
          <WebKpis result={data.result} />
          <WebChart result={data.result} className="h-48" />
        </div>
      );
      break;
    case 'trends':
      body = <TrendsResultView result={data.result} chartType={(parsed.data as ParsedTrendsSpec).display ?? 'line'} className="h-48" />;
      break;
    case 'funnel':
      body = <FunnelResultView result={data.result} spec={parsed.data as PanelFunnelSpec} projectId={report.projectId} compact />;
      break;
    case 'retention':
      body = <RetentionResultView result={data.result} />;
      break;
    case 'flows':
      body = <FlowsResultView result={data.result} compact />;
      break;
    default:
      body = <p className="text-sm text-muted-foreground">{t.weldpanel.analytics.common.noData}</p>;
  }

  return (
    <div className={className}>
      {body}
      <div className="mt-2">
        <FreshnessBadge dataAsOf={data.dataAsOf} cached={data.cached} fetching={isFetching} />
      </div>
    </div>
  );
}
