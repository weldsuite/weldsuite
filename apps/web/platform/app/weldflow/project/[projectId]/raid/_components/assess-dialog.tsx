import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { FieldDescription, FieldGroup, FieldLegend, FieldSet } from '@weldsuite/ui/components/field';
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
import { DateField, TextAreaField } from './form-fields';
import { RatingField, ScoreField } from './rating-controls';

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
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
        {risk ? (
          <>
            <DialogHeader>
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
  const [probability, impact] = form.watch(['probability', 'impact']);
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
    <form noValidate onSubmit={form.handleSubmit(submit)} className="grid gap-4">
      <FieldGroup>
        <FieldGroup>
          <RatingField control={form.control} name="probability" label={copy.form.probability} kind="probability" />
          <RatingField control={form.control} name="impact" label={copy.form.impact} kind="impact" />
          <ScoreField probability={probability} impact={impact} previousScore={risk.score} />
        </FieldGroup>
        <FieldSet>
          <FieldLegend variant="label">{copy.form.residual}</FieldLegend>
          <FieldDescription>{copy.form.residualHint}</FieldDescription>
          <FieldGroup>
            <RatingField control={form.control} name="residualProbability" label={copy.form.probability} kind="probability" nullable />
            <RatingField control={form.control} name="residualImpact" label={copy.form.impact} kind="impact" nullable />
          </FieldGroup>
        </FieldSet>
        <TextAreaField control={form.control} name="note" label={copy.assess.note} placeholder={copy.assess.notePlaceholder} rows={2} />
        <DateField control={form.control} name="nextReviewDate" label={copy.assess.nextReview} description={reviewHint} inline />
      </FieldGroup>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={assess.isPending}>
            {t.common.actions.cancel}
          </Button>
        </DialogClose>
        <Button type="submit" disabled={assess.isPending}>
          {assess.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {copy.assess.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}
