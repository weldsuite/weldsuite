/**
 * The AI summary of one recording: the cached summary when there is one (free
 * to read), a button to generate it (charged), and plain explanations for the
 * ways it can fail: no credits, AI off for the project, nothing to summarise.
 */

import { Sparkles } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { useGenerateWeldPanelSessionSummary, useWeldPanelSessionSummary } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { aiFailure, type AiFailure } from '../lib/api-errors';

const OUTCOME_TONES: Record<'succeeded' | 'abandoned' | 'unclear', SoftTone> = { succeeded: 'success', abandoned: 'warning', unclear: 'neutral' };

interface SummaryPanelProps {
  projectId: string;
  sessionId: string;
  /** The project's AI switch; off means no call is made. */
  aiEnabled: boolean;
}

export function failureVariant(failure: AiFailure): 'danger' | 'warning' | 'neutral' {
  if (failure.kind === 'failed') return 'danger';
  return failure.kind === 'credits' ? 'warning' : 'neutral';
}

export function failureText(failure: AiFailure, text: { noCredits: string; noCreditsGeneric: string; aiDisabled: string; noSessions: string; failed: string }): string {
  switch (failure.kind) {
    case 'credits':
      return failure.required !== null && failure.available !== null
        ? text.noCredits.replace('{required}', String(failure.required)).replace('{available}', String(failure.available))
        : text.noCreditsGeneric;
    case 'disabled':
      return text.aiDisabled;
    case 'no-sessions':
      return text.noSessions;
    default:
      return text.failed;
  }
}

export function SummaryPanel({ projectId, sessionId, aiEnabled }: Readonly<SummaryPanelProps>) {
  const { t, format } = useI18n();
  const ts = t.weldpanel.observe.session.summary;
  const { data: saved, isLoading, isError, refetch } = useWeldPanelSessionSummary(projectId, sessionId, aiEnabled);
  const generate = useGenerateWeldPanelSessionSummary(projectId);
  const failure = generate.error ? aiFailure(generate.error) : null;
  const summary = saved?.summary;
  let generateLabel = ts.generate;
  if (generate.isPending) generateLabel = ts.generating;
  else if (summary) generateLabel = ts.regenerate;

  return (
    <div className="grid gap-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="size-4 text-primary" aria-hidden />
          {ts.title}
        </h3>
        <p className="text-sm text-muted-foreground">{ts.description}</p>
      </div>

      {!aiEnabled && <InfoBanner variant="neutral">{ts.aiDisabled}</InfoBanner>}

      {aiEnabled && isLoading && <Skeleton className="h-32 w-full" />}
      {aiEnabled && isError && <ErrorState message={ts.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />}

      {summary && saved && (
        <div className="grid gap-3 rounded-lg border bg-card p-4" data-testid="session-summary">
          <div className="grid gap-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{ts.goal}</p>
            <p className="text-sm">{summary.goal}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{ts.outcome}</span>
            <SoftBadge tone={OUTCOME_TONES[summary.outcome]}>{ts.outcomes[summary.outcome]}</SoftBadge>
          </div>
          <div className="grid gap-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{ts.friction}</p>
            {summary.frictionPoints.length === 0 ? (
              <p className="text-sm text-muted-foreground">{ts.noFriction}</p>
            ) : (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {summary.frictionPoints.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="grid gap-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{ts.story}</p>
            <p className="text-sm leading-relaxed">{summary.narrative}</p>
          </div>
          <p className="text-xs text-muted-foreground">{format(ts.model, { model: saved.modelId, credits: saved.creditsCharged })}</p>
        </div>
      )}

      {failure && (
        <InfoBanner
          variant={failureVariant(failure)}
          action={
            failure.kind === 'credits' ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/settings/billing">{ts.topUp}</Link>
              </Button>
            ) : undefined
          }
        >
          {failureText(failure, ts)}
        </InfoBanner>
      )}

      {aiEnabled && !isLoading && (
        <div className="grid gap-2">
          <div>
            <Button type="button" variant={summary ? 'outline' : 'default'} size="sm" disabled={generate.isPending} onClick={() => generate.mutate({ sessionId, regenerate: !!summary })}>
              {generate.isPending ? <InlineSpinner /> : <Sparkles />}
              {generateLabel}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{summary ? ts.regenerateHint : ts.costHint}</p>
        </div>
      )}
    </div>
  );
}
