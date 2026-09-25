/**
 * Score an evaluation — create (pick employee + form) or edit (employee and
 * form locked, criteria are the ones snapshotted on the evaluation). The
 * overall-score preview mirrors the server formula in
 * `apps/workers/app-api/src/services/weldhr/performance.ts` (`overallScore`):
 * weighted mean of score/maxScore, 0–100, skipping unscored criteria.
 */

import { useMemo, useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import type {
  HrEvaluation,
  HrEvaluationCriterion,
} from '@weldsuite/app-api-client/domains/weldhr';
import {
  useCreateHrEvaluation,
  useHrEvaluationForms,
  useUpdateHrEvaluation,
} from '@/hooks/queries/use-weldhr-queries';
import {
  CompanyPicker,
  EmployeePicker,
  ErrorBanner,
  ScoreBadge,
  errorMessage,
} from '../../components/shared';

/** Weighted mean of criterion percentages, 0–100. Mirrors the server. */
function computeOverallScore(
  criteria: HrEvaluationCriterion[],
  scores: Map<string, number>,
): number | null {
  let weighted = 0;
  let weights = 0;
  for (const c of criteria) {
    const score = scores.get(c.id);
    if (score === undefined || c.weight <= 0 || c.maxScore <= 0) continue;
    weighted += (Math.min(score, c.maxScore) / c.maxScore) * c.weight;
    weights += c.weight;
  }
  if (weights === 0) return null;
  return Math.round((weighted / weights) * 1000) / 10;
}

export function EvaluationDialog({
  evaluation,
  employeeId,
  employeeLabel,
  onClose,
  onSaved,
}: Readonly<{
  evaluation?: HrEvaluation | null;
  employeeId?: string;
  employeeLabel?: string;
  onClose: () => void;
  onSaved?: (id: string) => void;
}>) {
  const t = useTranslations();
  const isEdit = Boolean(evaluation);
  const { data: forms } = useHrEvaluationForms();
  const activeForms = (forms ?? []).filter((f) => f.isActive || f.id === evaluation?.formId);
  const createEvaluation = useCreateHrEvaluation();
  const updateEvaluation = useUpdateHrEvaluation();

  const [empId, setEmpId] = useState<string | null>(evaluation?.employeeId ?? employeeId ?? null);
  const [empLabel, setEmpLabel] = useState<string | null>(evaluation?.employeeName ?? employeeLabel ?? null);
  const [formId, setFormId] = useState<string>(evaluation?.formId ?? '');
  const [companyId, setCompanyId] = useState<string | null>(evaluation?.companyId ?? null);
  const [companyLabel, setCompanyLabel] = useState<string | null>(evaluation?.companyName ?? null);
  const [periodStart, setPeriodStart] = useState(evaluation?.periodStart ?? '');
  const [periodEnd, setPeriodEnd] = useState(evaluation?.periodEnd ?? '');
  const [summary, setSummary] = useState(evaluation?.summary ?? '');
  const [sharedWithClient, setSharedWithClient] = useState(evaluation?.sharedWithClient ?? false);
  const [scores, setScores] = useState<Map<string, number>>(
    () => new Map((evaluation?.scores ?? []).map((s) => [s.criterionId, s.score])),
  );
  const [comments, setComments] = useState<Map<string, string>>(
    () => new Map((evaluation?.scores ?? []).map((s) => [s.criterionId, s.comment ?? ''])),
  );
  const [failure, setFailure] = useState<string | null>(null);

  const criteria: HrEvaluationCriterion[] = useMemo(
    () => (isEdit ? evaluation!.criteria : (activeForms.find((f) => f.id === formId)?.criteria ?? [])),
    [isEdit, evaluation, activeForms, formId],
  );

  const overallPreview = useMemo(() => computeOverallScore(criteria, scores), [criteria, scores]);

  const pending = createEvaluation.isPending || updateEvaluation.isPending;
  const canSubmitAction = !isEdit || evaluation!.status === 'draft';
  const locked = isEdit && evaluation!.status === 'acknowledged';

  function setScore(criterionId: string, value: number | null) {
    setScores((current) => {
      const next = new Map(current);
      if (value === null || Number.isNaN(value)) next.delete(criterionId);
      else next.set(criterionId, value);
      return next;
    });
  }

  function buildScoresPayload() {
    return criteria
      .filter((c) => scores.has(c.id))
      .map((c) => ({
        criterionId: c.id,
        score: scores.get(c.id)!,
        comment: comments.get(c.id)?.trim() || null,
      }));
  }

  async function submit(submitNow: boolean) {
    if (!empId || (!isEdit && !formId)) return;
    setFailure(null);
    try {
      if (isEdit && evaluation) {
        const result = await updateEvaluation.mutateAsync({
          id: evaluation.id,
          companyId,
          periodStart: periodStart || null,
          periodEnd: periodEnd || null,
          scores: buildScoresPayload(),
          summary: summary.trim() || null,
          sharedWithClient,
          submit: submitNow,
        });
        onSaved?.(result.data.id);
      } else {
        const result = await createEvaluation.mutateAsync({
          employeeId: empId,
          formId,
          companyId,
          periodStart: periodStart || null,
          periodEnd: periodEnd || null,
          scores: buildScoresPayload(),
          summary: summary.trim() || null,
          sharedWithClient,
          submit: submitNow,
        });
        onSaved?.(result.data.id);
      }
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.evaluations.dialog.saveFailed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('weldhr.evaluations.dialog.editTitle') : t('weldhr.evaluations.dialog.createTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('weldhr.common.employee')}</Label>
              <EmployeePicker
                value={empId}
                valueLabel={empLabel}
                onChange={(id, label) => {
                  setEmpId(id);
                  setEmpLabel(label);
                }}
                disabled={isEdit || Boolean(employeeId)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('weldhr.evaluations.dialog.form')}</Label>
              {isEdit ? (
                <Input value={evaluation?.formName ?? ''} disabled />
              ) : (
                <Select value={formId} onValueChange={setFormId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('weldhr.evaluations.dialog.selectForm')} />
                  </SelectTrigger>
                  <SelectContent>
                    {activeForms.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        {t('weldhr.evaluations.dialog.noActiveForms')}
                      </div>
                    ) : (
                      activeForms.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>{t('weldhr.common.client')}</Label>
              <CompanyPicker
                value={companyId}
                valueLabel={companyLabel}
                onChange={(id, label) => {
                  setCompanyId(id);
                  setCompanyLabel(label);
                }}
                allowClear
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="evaluation-period-start">{t('weldhr.evaluations.dialog.periodStart')}</Label>
              <Input
                id="evaluation-period-start"
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="evaluation-period-end">{t('weldhr.evaluations.dialog.periodEnd')}</Label>
              <Input
                id="evaluation-period-end"
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </div>
          </div>

          {criteria.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>{t('weldhr.evaluations.dialog.criteriaTitle')}</Label>
                <div className="flex items-center gap-1.5 text-sm">
                  <span className="text-xs text-muted-foreground">{t('weldhr.evaluations.dialog.overallPreview')}</span>
                  <ScoreBadge score={overallPreview} />
                </div>
              </div>
              <div className="space-y-3 rounded-md border p-3">
                {criteria.map((c) => (
                  <div key={c.id} className="space-y-1.5 border-b pb-3 last:border-0 last:pb-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{c.label}</p>
                        {c.description && <p className="text-xs text-muted-foreground">{c.description}</p>}
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t('weldhr.evaluations.dialog.weight')}: {c.weight}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        max={c.maxScore}
                        step="any"
                        disabled={locked}
                        value={scores.get(c.id) ?? ''}
                        onChange={(e) =>
                          setScore(c.id, e.target.value === '' ? null : Number(e.target.value))
                        }
                        className="w-24"
                      />
                      <span className="text-xs text-muted-foreground">
                        / {c.maxScore} {t('weldhr.evaluations.dialog.maxScore')}
                      </span>
                    </div>
                    <Input
                      value={comments.get(c.id) ?? ''}
                      disabled={locked}
                      onChange={(e) =>
                        setComments((current) => new Map(current).set(c.id, e.target.value))
                      }
                      placeholder={t('weldhr.evaluations.dialog.commentPlaceholder')}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="evaluation-summary">{t('weldhr.evaluations.dialog.summary')}</Label>
            <Textarea
              id="evaluation-summary"
              rows={4}
              disabled={locked}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder={t('weldhr.evaluations.dialog.summaryPlaceholder')}
            />
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">{t('weldhr.common.sharedWithClient')}</p>
              <p className="text-xs text-muted-foreground">{t('weldhr.common.sharedWithClientHint')}</p>
            </div>
            <Switch checked={sharedWithClient} onCheckedChange={setSharedWithClient} disabled={locked} />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('weldhr.common.cancel')}
          </Button>
          {canSubmitAction && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void submit(false)}
              disabled={pending || !empId || (!isEdit && !formId)}
            >
              {t('weldhr.evaluations.dialog.saveDraft')}
            </Button>
          )}
          {canSubmitAction && (
            <Button
              type="button"
              onClick={() => void submit(true)}
              disabled={pending || !empId || (!isEdit && !formId)}
            >
              {t('weldhr.evaluations.dialog.submit')}
            </Button>
          )}
          {!canSubmitAction && (
            <Button
              type="button"
              onClick={() => void submit(false)}
              disabled={pending || locked}
            >
              {t('weldhr.common.save')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
