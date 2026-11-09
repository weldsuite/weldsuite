import { useMemo, useState } from 'react';
import { BarChart3, Gauge, ListChecks } from 'lucide-react';
import type { FormDetail } from '@weldsuite/app-api-client/schemas/weldforms';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useFormSummary } from '@/hooks/queries/use-weldforms-results-queries';
import { AiSummaryCard } from './ai-summary-card';
import { RangeFilters, rangeQuery, type RangeValue } from './range-filters';
import { SummaryCard } from './summary-card';
import { toSummaryCard } from './summary-cards';

const NO_RANGE: RangeValue = { from: '', to: '', versionId: '' };

export function SummaryTab({ form }: Readonly<{ form: FormDetail }>) {
  const { t, language } = useI18n();
  const tr = t.weldformsResults.results;
  const [range, setRange] = useState<RangeValue>(NO_RANGE);
  const query = useFormSummary(form.id, rangeQuery(range));
  const summary = query.data;
  const cards = useMemo(() => (summary?.fields ?? []).map(toSummaryCard), [summary]);
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });

  return (
    <div className="space-y-6">
      <RangeFilters formId={form.id} value={range} onChange={setRange} />

      {query.isLoading ? (
        <PageLoader fullScreen={false} className="min-h-60" />
      ) : query.error || !summary ? (
        <ErrorState onRetry={() => void query.refetch()} message={t.weldformsResults.common.loadFailed} />
      ) : (
        <>
          <KpiGrid className="lg:grid-cols-3">
            <KpiCard label={tr.summary.totalResponses} value={number.format(summary.totalResponses)} icon={ListChecks} />
            {summary.averageScore !== null && (
              <KpiCard label={tr.summary.averageScore} value={number.format(summary.averageScore)} icon={Gauge} />
            )}
          </KpiGrid>

          {summary.totalResponses === 0 ? (
            <EmptyState icon={BarChart3} title={tr.summary.emptyTitle} description={tr.summary.emptyDescription} />
          ) : (
            <>
              <AiSummaryCard
                formId={form.id}
                blockId={null}
                title={tr.ai.titleForm}
                canGenerate
                responseCount={summary.totalResponses}
              />
              <div className="grid gap-4 lg:grid-cols-2">
                {cards.map((card) => (
                  <SummaryCard key={card.blockId} model={card} formId={form.id} responseCount={summary.totalResponses} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
