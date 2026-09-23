/** WeldHR — evaluation detail: scored criteria, status timeline, actions. */

import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Check } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { Progress } from '@weldsuite/ui/components/progress';
import { Switch } from '@weldsuite/ui/components/switch';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { useParams } from '@/lib/router';
import {
  useDeleteHrEvaluation,
  useHrEmployee,
  useHrEvaluation,
  useUpdateHrEvaluation,
} from '@/hooks/queries/use-weldhr-queries';
import {
  EmployeeAvatar,
  ErrorBanner,
  InlineSpinner,
  PageBody,
  ScoreBadge,
  StatusBadge,
  errorMessage,
  formatDate,
  formatDateTime,
} from '../../components/shared';
import { EvaluationDialog } from '../components/evaluation-dialog';

export default function WeldHrEvaluationDetailPage() {
  const t = useTranslations();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { evaluationId } = useParams() as { evaluationId: string };

  const { data: evaluation, isLoading, error } = useHrEvaluation(evaluationId);
  const { data: employee } = useHrEmployee(evaluation?.employeeId);
  const updateEvaluation = useUpdateHrEvaluation();
  const deleteEvaluation = useDeleteHrEvaluation();

  const [editing, setEditing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const canUpdate = can('evaluations:update');
  const canDelete = can('evaluations:delete');

  async function submitDraft() {
    if (!evaluation) return;
    setFailure(null);
    try {
      await updateEvaluation.mutateAsync({ id: evaluation.id, submit: true });
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.evaluations.detail.submitFailed')));
    }
  }

  async function toggleShare(value: boolean) {
    if (!evaluation) return;
    setFailure(null);
    try {
      await updateEvaluation.mutateAsync({ id: evaluation.id, sharedWithClient: value });
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.common.saveFailed')));
    }
  }

  async function remove() {
    if (!evaluation) return;
    if (!confirm(t('weldhr.evaluations.detail.deleteConfirm'))) return;
    setFailure(null);
    try {
      await deleteEvaluation.mutateAsync(evaluation.id);
      await navigate({ to: '/weldhr/evaluations' });
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.evaluations.detail.deleteFailed')));
    }
  }

  if (isLoading) return <InlineSpinner />;
  if (!evaluation) {
    return (
      <PageBody>
        <ErrorBanner error={errorMessage(error, t('weldhr.evaluations.detail.notFound'))} />
      </PageBody>
    );
  }

  const scoreByCriterion = new Map(evaluation.scores.map((s) => [s.criterionId, s]));
  const canEditNow = evaluation.status !== 'acknowledged';

  return (
    <PageBody>
      <Link to="/weldhr/evaluations" className="flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-3.5 w-3.5" />
        {t('weldhr.evaluations.detail.back')}
      </Link>

      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <EmployeeAvatar name={evaluation.employeeName ?? ''} src={employee?.avatarUrl} className="h-10 w-10" />
          <div>
            <Link
              to="/weldhr/employees/$employeeId"
              params={{ employeeId: evaluation.employeeId }}
              className="text-lg font-semibold hover:underline"
            >
              {evaluation.employeeName}
            </Link>
            <p className="text-sm text-muted-foreground">
              {evaluation.formName} {employee?.jobTitle ? `· ${employee.jobTitle}` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge group="evaluation" status={evaluation.status} />
          {canUpdate && canEditNow && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              {t('weldhr.common.edit')}
            </Button>
          )}
          {canUpdate && evaluation.status === 'draft' && (
            <Button size="sm" onClick={() => void submitDraft()} disabled={updateEvaluation.isPending}>
              <Check className="mr-1.5 h-3.5 w-3.5" />
              {t('weldhr.evaluations.dialog.submit')}
            </Button>
          )}
          {canDelete && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void remove()}
              disabled={deleteEvaluation.isPending}
            >
              {t('weldhr.common.delete')}
            </Button>
          )}
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">{t('weldhr.evaluations.detail.overallScore')}</p>
          <div className="mt-1">
            <ScoreBadge score={evaluation.overallScore} />
          </div>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">{t('weldhr.evaluations.table.period')}</p>
          <p className="mt-1 text-sm font-medium">
            {evaluation.periodStart || evaluation.periodEnd
              ? `${formatDate(evaluation.periodStart)} – ${formatDate(evaluation.periodEnd)}`
              : t('weldhr.evaluations.table.noPeriod')}
          </p>
          {evaluation.companyName && <p className="text-xs text-muted-foreground">{evaluation.companyName}</p>}
        </Card>
        <Card className="flex items-center justify-between p-4">
          <div>
            <p className="text-sm font-medium">{t('weldhr.common.sharedWithClient')}</p>
            <p className="text-xs text-muted-foreground">{t('weldhr.common.sharedWithClientHint')}</p>
          </div>
          <Switch
            checked={evaluation.sharedWithClient}
            onCheckedChange={(v) => void toggleShare(v)}
            disabled={!canUpdate || updateEvaluation.isPending}
          />
        </Card>
      </div>

      <Card className="space-y-4 p-4">
        <h3 className="text-sm font-medium">{t('weldhr.evaluations.detail.criteria')}</h3>
        <div className="space-y-4">
          {evaluation.criteria.map((c) => {
            const scored = scoreByCriterion.get(c.id);
            const pct = scored ? Math.min(100, (scored.score / c.maxScore) * 100) : 0;
            return (
              <div key={c.id} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-medium">{c.label}</span>
                  <span className="text-muted-foreground">
                    {scored ? scored.score : '—'} / {c.maxScore} · {t('weldhr.evaluations.detail.weight')} {c.weight}
                  </span>
                </div>
                <Progress value={pct} />
                {scored?.comment && <p className="text-xs text-muted-foreground">{scored.comment}</p>}
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="space-y-2 p-4">
        <h3 className="text-sm font-medium">{t('weldhr.evaluations.dialog.summary')}</h3>
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
          {evaluation.summary || t('weldhr.evaluations.detail.noSummary')}
        </p>
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="text-sm font-medium">{t('weldhr.evaluations.detail.statusTimeline.title')}</h3>
        <ol className="space-y-2 text-sm">
          <TimelineStep label={t('weldhr.evaluations.detail.statusTimeline.created')} at={evaluation.createdAt} done />
          <TimelineStep
            label={t('weldhr.evaluations.detail.statusTimeline.submitted')}
            at={evaluation.submittedAt}
            done={Boolean(evaluation.submittedAt)}
          />
          <TimelineStep
            label={t('weldhr.evaluations.detail.statusTimeline.acknowledged')}
            at={evaluation.acknowledgedAt}
            done={Boolean(evaluation.acknowledgedAt)}
          />
        </ol>
        {evaluation.employeeComment && (
          <div className="rounded-md border bg-muted/40 p-3">
            <p className="text-xs font-medium text-muted-foreground">{t('weldhr.evaluations.detail.employeeComment')}</p>
            <p className="mt-1 text-sm">{evaluation.employeeComment}</p>
          </div>
        )}
      </Card>

      {editing && (
        <EvaluationDialog evaluation={evaluation} onClose={() => setEditing(false)} />
      )}
    </PageBody>
  );
}

function TimelineStep({ label, at, done }: { label: string; at: string | null; done: boolean }) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-2">
        <Badge variant={done ? 'default' : 'secondary'} className="h-5 w-5 justify-center rounded-full p-0">
          {done ? <Check className="h-3 w-3" /> : ''}
        </Badge>
        {label}
      </span>
      <span className="text-xs text-muted-foreground">{at ? formatDateTime(at) : '—'}</span>
    </li>
  );
}
