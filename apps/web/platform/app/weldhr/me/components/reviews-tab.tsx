/** My HR → Reviews: coaching sessions and evaluations, with an Acknowledge action for the open ones. */

import { toast } from 'sonner';
import { Square, SquareCheck } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Progress } from '@weldsuite/ui/components/progress';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfCoachingLog, HrSelfEvaluation } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useMyHrAcknowledgeCoaching,
  useMyHrAcknowledgeEvaluation,
  useMyHrCoaching,
  useMyHrEvaluations,
} from '@/hooks/queries/use-weldhr-queries';
import { EmptyText, SectionCard } from '../../components/page-kit';
import { ErrorBanner, ScoreBadge, StatusBadge, errorMessage, formatDate } from '../../components/shared';
import { AcknowledgeControl } from './acknowledge-control';
import { Meta, TabLoading } from './shared';

export function MyReviewsTab() {
  const t = useTranslations();
  const coaching = useMyHrCoaching();
  const evaluations = useMyHrEvaluations();
  const acknowledgeCoaching = useMyHrAcknowledgeCoaching();
  const acknowledgeEvaluation = useMyHrAcknowledgeEvaluation();

  async function onAcknowledgeCoaching(id: string, comment: string | null) {
    await acknowledgeCoaching.mutateAsync({ id, comment });
    toast.success(t('weldhr.me.reviews.acknowledgedToast'));
  }

  async function onAcknowledgeEvaluation(id: string, comment: string | null) {
    await acknowledgeEvaluation.mutateAsync({ id, comment });
    toast.success(t('weldhr.me.reviews.acknowledgedToast'));
  }

  return (
    <div className="space-y-4">
      <SectionCard title={t('weldhr.me.reviews.evaluations.title')}>
        {evaluations.isLoading && <TabLoading />}
        {!evaluations.isLoading && !evaluations.data && (
          <ErrorBanner error={errorMessage(evaluations.error, t('weldhr.me.reviews.evaluations.loadFailed'))} />
        )}
        {evaluations.data &&
          (evaluations.data.length === 0 ? (
            <EmptyText>{t('weldhr.me.reviews.evaluations.empty')}</EmptyText>
          ) : (
            <div className="space-y-3">
              {evaluations.data.map((evaluation) => (
                <EvaluationCard key={evaluation.id} evaluation={evaluation} onAcknowledge={onAcknowledgeEvaluation} />
              ))}
            </div>
          ))}
      </SectionCard>

      <SectionCard title={t('weldhr.me.reviews.coaching.title')}>
        {coaching.isLoading && <TabLoading />}
        {!coaching.isLoading && !coaching.data && (
          <ErrorBanner error={errorMessage(coaching.error, t('weldhr.me.reviews.coaching.loadFailed'))} />
        )}
        {coaching.data &&
          (coaching.data.length === 0 ? (
            <EmptyText>{t('weldhr.me.reviews.coaching.empty')}</EmptyText>
          ) : (
            <div className="space-y-3">
              {coaching.data.map((log) => (
                <CoachingCard key={log.id} log={log} onAcknowledge={onAcknowledgeCoaching} />
              ))}
            </div>
          ))}
      </SectionCard>
    </div>
  );
}

function AcknowledgedLine({ acknowledgedAt, comment }: Readonly<{ acknowledgedAt: string; comment: string | null }>) {
  const t = useTranslations();
  return (
    <div className="space-y-1">
      <Meta>{t('weldhr.me.reviews.acknowledgedOn', { date: formatDate(acknowledgedAt) })}</Meta>
      {comment && (
        <p className="text-sm">
          <span className="text-muted-foreground">{t('weldhr.me.reviews.yourComment')}: </span>
          {comment}
        </p>
      )}
    </div>
  );
}

function CoachingCard({
  log,
  onAcknowledge,
}: Readonly<{
  log: HrSelfCoachingLog;
  onAcknowledge: (id: string, comment: string | null) => Promise<void>;
}>) {
  const t = useTranslations();
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <Meta>{formatDate(log.sessionDate)}</Meta>
          <h3 className="text-sm font-medium">{log.topic || t(`weldhr.status.coachingCategory.${log.category}`)}</h3>
          {log.coachName && <Meta>{t('weldhr.me.reviews.coaching.coach', { name: log.coachName })}</Meta>}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{t(`weldhr.status.coachingCategory.${log.category}`)}</Badge>
          <StatusBadge group="coaching" status={log.status} />
        </div>
      </div>

      {log.notes && <p className="whitespace-pre-wrap text-sm">{log.notes}</p>}

      {log.actionItems.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t('weldhr.me.reviews.coaching.actionItems')}</p>
          <ul className="space-y-1 text-sm">
            {log.actionItems.map((item) => (
              <li key={item.id} className="flex items-start gap-2">
                {item.done ? (
                  <SquareCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Square className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className={item.done ? 'text-muted-foreground line-through' : undefined}>{item.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {log.followUpDate && <Meta>{t('weldhr.me.reviews.coaching.followUp', { date: formatDate(log.followUpDate) })}</Meta>}

      {log.acknowledgedAt ? (
        <AcknowledgedLine acknowledgedAt={log.acknowledgedAt} comment={log.employeeComment} />
      ) : (
        <AcknowledgeControl onAcknowledge={(comment) => onAcknowledge(log.id, comment)} />
      )}
    </div>
  );
}

function EvaluationCard({
  evaluation,
  onAcknowledge,
}: Readonly<{
  evaluation: HrSelfEvaluation;
  onAcknowledge: (id: string, comment: string | null) => Promise<void>;
}>) {
  const t = useTranslations();
  const hasPeriod = Boolean(evaluation.periodStart || evaluation.periodEnd);

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h3 className="text-sm font-medium">{evaluation.formName ?? t('weldhr.me.reviews.evaluations.untitled')}</h3>
          {hasPeriod && (
            <Meta>
              {formatDate(evaluation.periodStart)} – {formatDate(evaluation.periodEnd)}
            </Meta>
          )}
          {evaluation.evaluatorName && (
            <Meta>{t('weldhr.me.reviews.evaluations.evaluator', { name: evaluation.evaluatorName })}</Meta>
          )}
        </div>
        <div className="flex items-center gap-2">
          <ScoreBadge score={evaluation.overallScore} />
          <StatusBadge group="evaluation" status={evaluation.status} />
        </div>
      </div>

      {evaluation.criteria.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground">{t('weldhr.me.reviews.evaluations.criteria')}</p>
          {evaluation.criteria.map((criterion) => {
            const scored = evaluation.scores.find((score) => score.criterionId === criterion.id);
            const percent = scored && criterion.maxScore > 0 ? Math.min(100, (scored.score / criterion.maxScore) * 100) : 0;
            return (
              <div key={criterion.id} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span>{criterion.label}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {scored ? scored.score : '—'} / {criterion.maxScore}
                  </span>
                </div>
                <Progress value={percent} className="h-1.5" />
                {scored?.comment && <Meta>{scored.comment}</Meta>}
              </div>
            );
          })}
        </div>
      )}

      {evaluation.summary && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t('weldhr.me.reviews.evaluations.summary')}</p>
          <p className="whitespace-pre-wrap text-sm">{evaluation.summary}</p>
        </div>
      )}

      {evaluation.acknowledgedAt && <AcknowledgedLine acknowledgedAt={evaluation.acknowledgedAt} comment={evaluation.employeeComment} />}
      {!evaluation.acknowledgedAt && evaluation.status === 'submitted' && (
        <AcknowledgeControl onAcknowledge={(comment) => onAcknowledge(evaluation.id, comment)} />
      )}
    </div>
  );
}
