/**
 * The heatmap column's AI summary: AI reads up to 20 recent recorded visits to
 * the page group's pages (on the device and in the period the heatmap shows)
 * and groups what visitors do there into themes, each with an example to
 * watch. It is the recordings list's "Summarise these sessions"
 * (`insights.summarise`) with a sessions filter for these pages. Charged, so
 * it runs only on a click, and says plainly when it can't run.
 */

import { useEffect, useMemo } from 'react';
import { Sparkles } from 'lucide-react';
import type { PanelHeatmapSpec, PanelSessionsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { useSummariseWeldPanelSet } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { aiFailure } from '../../lib/api-errors';
import { failureText, failureVariant } from '../../recordings/summary-panel';

/**
 * The part of a page group's pattern the sessions filter can match: it
 * matches paths that contain a text, so `/products/*` becomes `/products/`
 * (everything before the first star) and `/pricing` stays `/pricing`.
 */
export function visitedPath(urlPattern: string): string {
  const head = urlPattern.split('*')[0] ?? '';
  return head === '' ? '/' : head;
}

interface HeatmapAiSummaryProps {
  /** The heatmap's question: project, period and device. */
  spec: PanelHeatmapSpec;
  urlPattern: string;
  /** The project's AI switch; off means no call is made. */
  aiEnabled: boolean;
}

export function HeatmapAiSummary({ spec, urlPattern, aiEnabled }: Readonly<HeatmapAiSummaryProps>) {
  const { t, format } = useI18n();
  const th = t.weldpanel.observe.heatmaps;
  const ts = t.weldpanel.observe.recordings.summariseSet;
  const summarise = useSummariseWeldPanelSet();
  const { reset } = summarise;
  const result = summarise.data;
  const failure = summarise.error ? aiFailure(summarise.error) : null;

  const sessions = useMemo<PanelSessionsSpec>(
    () => ({
      kind: 'sessions',
      projectId: spec.projectId,
      dateRange: spec.dateRange,
      timezone: spec.timezone,
      pagesVisited: [visitedPath(urlPattern)],
      devices: [spec.deviceClass],
      hasRecording: true,
      sort: 'started_desc',
      limit: 20,
    }),
    [spec.projectId, spec.dateRange, spec.timezone, spec.deviceClass, urlPattern],
  );

  // Another page group, device or period: the summary on screen no longer fits it.
  useEffect(() => {
    reset();
  }, [sessions, reset]);

  const run = () => summarise.mutate({ projectId: spec.projectId, source: { type: 'sessions', spec: sessions }, limit: 20 });

  return (
    <div className="grid gap-4 p-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="size-4 text-primary" aria-hidden />
          {th.ai.title}
        </h3>
        <p className="text-sm text-muted-foreground">{th.ai.description}</p>
      </div>

      {!aiEnabled && <InfoBanner variant="neutral">{ts.aiDisabled}</InfoBanner>}

      {failure && (
        <InfoBanner
          variant={failureVariant(failure)}
          action={
            failure.kind === 'credits' ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/settings/billing">{t.weldpanel.observe.session.summary.topUp}</Link>
              </Button>
            ) : undefined
          }
        >
          {failureText(failure, {
            noCredits: ts.noCredits,
            noCreditsGeneric: ts.noCreditsGeneric,
            aiDisabled: ts.aiDisabled,
            noSessions: th.ai.noSessions,
            failed: ts.failed,
          })}
        </InfoBanner>
      )}

      {summarise.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <InlineSpinner />
          {th.ai.running}
        </p>
      )}

      {result && (
        <div className="grid gap-4" data-testid="heatmap-ai-summary">
          <div className="grid gap-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{ts.overview}</p>
            <p className="text-sm leading-relaxed">{result.summary.overview}</p>
            <p className="text-xs text-muted-foreground">
              {format(th.ai.readN, { count: result.summary.sessionsRead })} ·{' '}
              {result.cached || result.creditsCharged === 0 ? ts.cached : format(ts.credits, { credits: result.creditsCharged })}
            </p>
          </div>
          <div className="grid gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{ts.themes}</p>
            <ul className="grid gap-3">
              {result.summary.themes.map((theme) => (
                <li key={theme.title} className="grid gap-1 rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium">{theme.title}</p>
                    <span className="shrink-0 text-xs text-muted-foreground">{format(th.ai.themeVisits, { count: theme.sessionCount })}</span>
                  </div>
                  <p className="text-sm text-muted-foreground">{theme.description}</p>
                  {theme.sessionIds[0] && (
                    <div>
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/weldpanel/recordings/${encodeURIComponent(theme.sessionIds[0])}?project=${encodeURIComponent(spec.projectId)}`}>
                          {ts.watch}
                        </Link>
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {aiEnabled && !result && (
        <div className="grid gap-2">
          <div>
            <Button type="button" size="sm" disabled={summarise.isPending} onClick={run}>
              {summarise.isPending ? <InlineSpinner /> : <Sparkles />}
              {summarise.isPending ? th.ai.running : th.ai.run}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{th.ai.costHint}</p>
        </div>
      )}
    </div>
  );
}
