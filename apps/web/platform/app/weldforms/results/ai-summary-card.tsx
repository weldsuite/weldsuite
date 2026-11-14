/**
 * An AI summary of one open-text question (or of the whole form when `blockId`
 * is null): an overview, themes with counts and example quotes, sentiment. The
 * card is hidden when the backend answers 503 `ai_unavailable` (Kubernetes
 * editions) and says when the summary was made from fewer responses than there
 * are now.
 */

import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { useI18n } from '@/lib/i18n/provider';
import { useAiSummary, useCreateAiSummary } from '@/hooks/queries/use-weldforms-results-queries';
import { percentOf } from './summary-cards';

export function AiSummaryCard({
  formId,
  blockId,
  title,
  canGenerate,
  responseCount,
}: Readonly<{ formId: string; blockId: string | null; title: string; canGenerate: boolean; responseCount: number }>) {
  const { t, format } = useI18n();
  const ta = t.weldformsResults.results.ai;
  const query = useAiSummary(formId, blockId, responseCount > 0);
  const create = useCreateAiSummary(formId);

  if (query.unavailable || responseCount === 0) return null;

  const summary = query.data?.summary ?? null;
  const stale = query.data?.stale === true;

  async function generate() {
    try {
      await create.mutateAsync(blockId);
    } catch {
      toast.error(ta.failed);
    }
  }

  const sentiment = summary?.sentiment ?? null;
  const sentimentTotal = sentiment ? sentiment.positive + sentiment.neutral + sentiment.negative : 0;
  let buttonLabel = summary ? ta.regenerate : ta.generate;
  if (create.isPending) buttonLabel = ta.generating;

  let content: ReactNode;
  if (query.isLoading) content = <InlineSpinner />;
  else if (!summary) content = <p className="text-sm text-muted-foreground">{ta.empty}</p>;
  else {
    content = (
      <>
        <p className="text-sm">{summary.overview}</p>
        {stale && query.data && (
          <p className="text-xs text-muted-foreground">{format(ta.staleHint, { count: query.data.responseCount })}</p>
        )}
        {summary.themes.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">{ta.themes}</p>
            <ul className="space-y-3">
              {summary.themes.map((theme) => (
                <li key={theme.label} className="space-y-1">
                  <p className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="font-medium">{theme.label}</span>
                    <span className="tabular-nums text-muted-foreground">{theme.count}</span>
                  </p>
                  {theme.quotes.length > 0 && (
                    <ul className="space-y-1 border-l-2 pl-3">
                      {theme.quotes.map((quote, index) => (
                        <li key={index} className="text-sm italic text-muted-foreground">
                          “{quote}”
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {sentiment && sentimentTotal > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">{ta.sentiment}</p>
            <div
              className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`${ta.positive} ${percentOf(sentiment.positive, sentimentTotal)}%, ${ta.neutral} ${percentOf(sentiment.neutral, sentimentTotal)}%, ${ta.negative} ${percentOf(sentiment.negative, sentimentTotal)}%`}
            >
              <div className="bg-emerald-500" style={{ width: `${percentOf(sentiment.positive, sentimentTotal)}%` }} />
              <div className="bg-muted-foreground/40" style={{ width: `${percentOf(sentiment.neutral, sentimentTotal)}%` }} />
              <div className="bg-red-500" style={{ width: `${percentOf(sentiment.negative, sentimentTotal)}%` }} />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{ta.positive}: {sentiment.positive}</span>
              <span>{ta.neutral}: {sentiment.neutral}</span>
              <span>{ta.negative}: {sentiment.negative}</span>
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{format(ta.basedOn, { count: query.data?.responseCount ?? 0 })}</p>
      </>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden />
          {title}
          {stale && <SoftBadge tone="warning">{ta.stale}</SoftBadge>}
        </CardTitle>
        {canGenerate && (
          <Button type="button" variant="outline" size="sm" disabled={create.isPending} onClick={() => void generate()}>
            {buttonLabel}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {content}
      </CardContent>
    </Card>
  );
}
