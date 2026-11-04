import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormField } from '@weldsuite/ui/components/form';
import type { RaidItem } from '@weldsuite/app-api-client/domains/project-control';
import { useI18n } from '@/lib/i18n/provider';
import { useAssessRisk } from '@/hooks/queries/use-project-control-queries';
import {
  assessFormSchema,
  assessValuesFromItem,
  buildAssessBody,
  raidResolverOptions,
  type AssessFormValues,
} from '../_lib/form';
import { DEFAULT_REVIEW_INTERVAL_DAYS, reviewIntervalLabel, riskBand, riskScore } from '../_lib/risk';
import { reviewEveryLabel } from '../_lib/copy';
import { TextAreaField, TextField } from './form-fields';
import { RatingPicker, ScoreCard } from './rating-controls';

interface AssessDialogProps {
  /** The risk to reassess; the dialog is open while this is set. */
  risk: RaidItem | null;
  onClose: () => void;
}

/** Reassess a risk: new probability and impact, an optional after-mitigation target and a note. */
export function AssessDialog({ risk, onClose }: Readonly<AssessDialogProps>) {
  const { t, format } = useI18n();
  const copy = t.projects.raid;
  return (
    <Dialog open={risk !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="flex max-h-[92vh] flex-col gap-0 p-0 sm:max-w-xl">
        {risk ? (
          <>
            <DialogHeader className="border-b px-6 pt-6 pb-4 text-left">
              <DialogTitle>{format(copy.assess.title, { code: risk.code })}</DialogTitle>
              <DialogDescription>{copy.assess.description}</DialogDescription>
            </DialogHeader>
            <AssessForm key={risk.id} risk={risk} onClose={onClose} />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AssessForm({ risk, onClose }: Readonly<{ risk: RaidItem; onClose: () => void }>) {
  const { t, format } = useI18n();
  const copy = t.projects.raid;
  const assess = useAssessRisk();
  const resolverOptions = useMemo(() => raidResolverOptions(copy.validation, format), [copy.validation, format]);

  const form = useForm<AssessFormValues>({
    resolver: zodResolver(assessFormSchema, resolverOptions),
    defaultValues: assessValuesFromItem(risk),
  });
  const [probability, impact, residualProbability, residualImpact] = form.watch([
    'probability',
    'impact',
    'residualProbability',
    'residualImpact',
  ]);
  const band = riskBand(riskScore(probability ?? 3, impact ?? 3));
  const reviewHint = format(copy.form.reviewDefault, {
    interval: reviewEveryLabel(copy, reviewIntervalLabel(risk.reviewIntervalDays ?? DEFAULT_REVIEW_INTERVAL_DAYS[band]), format),
  });

  const submit = async (values: AssessFormValues) => {
    const body = buildAssessBody(values);
    if (!body) {
      toast.error(copy.toasts.assessFailed);
      return;
    }
    try {
      await assess.mutateAsync({ id: risk.id, data: body });
      toast.success(copy.toasts.assessed);
      onClose();
    } catch {
      toast.error(copy.toasts.assessFailed);
    }
  };

  return (
    <Form {...form}>
      <form noValidate onSubmit={form.handleSubmit(submit)} className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <FormField
            control={form.control}
            name="probability"
            render={({ field, fieldState }) => (
              <RatingPicker label={copy.form.probability} kind="probability" value={field.value} onChange={field.onChange} error={fieldState.error?.message} />
            )}
          />
          <FormField
            control={form.control}
            name="impact"
            render={({ field, fieldState }) => (
              <RatingPicker label={copy.form.impact} kind="impact" value={field.value} onChange={field.onChange} error={fieldState.error?.message} />
            )}
          />
          <ScoreCard probability={probability} impact={impact} previousScore={risk.score} />

          <div className="space-y-4 rounded-lg border p-4">
            <div>
              <div className="text-sm font-medium">{copy.form.residual}</div>
              <p className="mt-0.5 text-xs text-muted-foreground">{copy.form.residualHint}</p>
            </div>
            <FormField
              control={form.control}
              name="residualProbability"
              render={({ field, fieldState }) => (
                <RatingPicker
                  label={copy.form.probability}
                  kind="probability"
                  value={field.value}
                  onChange={field.onChange}
                  nullable
                  error={fieldState.error?.message}
                />
              )}
            />
            <FormField
              control={form.control}
              name="residualImpact"
              render={({ field, fieldState }) => (
                <RatingPicker
                  label={copy.form.impact}
                  kind="impact"
                  value={field.value}
                  onChange={field.onChange}
                  nullable
                  error={fieldState.error?.message}
                />
              )}
            />
            {residualProbability == null && residualImpact == null ? (
              <p className="text-xs text-muted-foreground">{copy.detail.noTarget}</p>
            ) : null}
          </div>

          <TextAreaField control={form.control} name="note" label={copy.assess.note} placeholder={copy.assess.notePlaceholder} rows={2} />
          <TextField control={form.control} name="nextReviewDate" type="date" label={copy.assess.nextReview} description={reviewHint} />
        </div>
        <DialogFooter className="border-t px-6 py-3.5">
          <Button type="button" variant="outline" onClick={onClose} disabled={assess.isPending}>
            {t.common.actions.cancel}
          </Button>
          <Button type="submit" disabled={assess.isPending}>
            {assess.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {copy.assess.submit}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
