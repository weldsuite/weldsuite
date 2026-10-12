/**
 * The Sequence tab: an ordered list of steps to edit, with a live preview.
 * Saving replaces all steps, which the API refuses while the campaign is
 * active, so the editor is locked then and says to pause first.
 */

import { useEffect, useMemo, useState } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  replaceReachStepsSchema,
  type ReachCampaignDetail,
} from '@weldsuite/app-api-client/schemas/reach';
import { useReplaceReachSteps, useReachEnrollments } from '@/hooks/queries/use-reach-campaign-queries';
import { useReachProspects } from '@/hooks/queries/use-reach-prospect-queries';
import { ErrorBanner, Notice, TabBody, errorMessage } from '@/app/weldreach/components/engage/kit';
import {
  MAX_STEPS,
  customFieldNames,
  newStep,
  normalizeSteps,
  stepsToDraft,
} from '../../lib/sequence';
import { PreviewPane, type PreviewProspect } from './preview-pane';
import { StepCard, type SequenceValues } from './step-card';

const SAMPLE_SIZE = 100;
const PREVIEW_PROSPECTS = 50;

export function SequenceTab({
  campaign,
  canEdit,
}: Readonly<{ campaign: ReachCampaignDetail; canEdit: boolean }>) {
  const t = useTranslations();
  const replaceSteps = useReplaceReachSteps(campaign.id);
  const [failure, setFailure] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  const locked = campaign.status === 'active';
  const readOnly = locked || !canEdit;

  const serverDraft = useMemo(() => stepsToDraft(campaign.steps), [campaign.steps]);
  const form = useForm<SequenceValues>({
    resolver: zodResolver(replaceReachStepsSchema),
    defaultValues: { steps: serverDraft },
  });
  const { fields, append, remove, move } = useFieldArray({ control: form.control, name: 'steps' });
  const { isDirty } = form.formState;

  // Pick up changes made elsewhere (another tab, a pause/resume) unless there are unsaved edits.
  useEffect(() => {
    if (!form.formState.isDirty) form.reset({ steps: serverDraft });
  }, [serverDraft, form]);

  // Custom fields seen on prospects feed the variable menu; the same sample is a
  // preview fallback while the campaign has no prospects of its own.
  const sample = useReachProspects({}, { limit: SAMPLE_SIZE });
  const enrolled = useReachEnrollments(campaign.id);
  const customFields = useMemo(() => customFieldNames(sample.prospects), [sample.prospects]);
  const previewProspects = useMemo<PreviewProspect[]>(() => {
    const source =
      enrolled.enrollments.length > 0
        ? enrolled.enrollments.map((enrollment) => enrollment.prospect)
        : sample.prospects;
    return source.slice(0, PREVIEW_PROSPECTS).map((prospect) => ({
      id: prospect.id,
      email: prospect.email,
      firstName: prospect.firstName,
      lastName: prospect.lastName,
      companyName: prospect.companyName,
    }));
  }, [enrolled.enrollments, sample.prospects]);

  const selectedIndex = Math.min(selected, Math.max(fields.length - 1, 0));
  const previewSubject = useWatch({ control: form.control, name: `steps.${selectedIndex}.subject` });
  const previewBody = useWatch({ control: form.control, name: `steps.${selectedIndex}.body` });

  const submit = form.handleSubmit(async (values) => {
    setFailure(null);
    try {
      const res = await replaceSteps.mutateAsync(normalizeSteps(values.steps));
      form.reset({ steps: stepsToDraft(res.data.steps) });
      toast.success(t('reachEngage.sequence.saved'));
    } catch (err) {
      setFailure(errorMessage(err, t('reachEngage.sequence.saveFailed')));
    }
  });

  function addStep() {
    append(newStep());
    setSelected(fields.length);
  }

  function moveStep(index: number, direction: -1 | 1) {
    move(index, index + direction);
    setSelected(index + direction);
  }

  function removeStep(index: number) {
    remove(index);
    setSelected((current) => Math.max(0, current >= index ? current - 1 : current));
  }

  return (
    <TabBody>
      {locked && (
        <Notice tone="warning" title={t('reachEngage.sequence.lockedTitle')}>
          {t('reachEngage.sequence.lockedHint')}
        </Notice>
      )}
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

      <form onSubmit={submit} className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <fieldset disabled={readOnly} className="m-0 min-w-0 space-y-4 border-0 p-0">
          {fields.map((field, index) => (
            <StepCard
              key={field.id}
              form={form}
              index={index}
              total={fields.length}
              selected={index === selectedIndex}
              disabled={readOnly}
              customFields={customFields}
              onSelect={() => setSelected(index)}
              onMove={(direction) => moveStep(index, direction)}
              onRemove={() => removeStep(index)}
            />
          ))}

          {form.formState.errors.steps?.root && (
            <p className="text-xs text-destructive">{t('reachEngage.sequence.needsStep')}</p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addStep}
              disabled={readOnly || fields.length >= MAX_STEPS}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              {t('reachEngage.sequence.addStep')}
            </Button>

            <div className="flex items-center gap-3">
              {isDirty && !readOnly && (
                <span className="text-xs text-muted-foreground">
                  {t('reachEngage.sequence.unsaved')}
                </span>
              )}
              {isDirty && !readOnly && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={replaceSteps.isPending}
                  onClick={() => form.reset({ steps: serverDraft })}
                >
                  {t('reachEngage.common.discard')}
                </Button>
              )}
              <Button type="submit" size="sm" disabled={readOnly || !isDirty || replaceSteps.isPending}>
                {replaceSteps.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('reachEngage.sequence.save')}
              </Button>
            </div>
          </div>

          {fields.length >= MAX_STEPS && (
            <p className="text-xs text-muted-foreground">
              {t('reachEngage.sequence.maxSteps', { count: MAX_STEPS })}
            </p>
          )}
        </fieldset>

        <div className="min-w-0 xl:sticky xl:top-0 xl:self-start">
          <PreviewPane
            campaignId={campaign.id}
            stepNumber={selectedIndex + 1}
            subject={previewSubject ?? ''}
            body={previewBody ?? ''}
            prospects={previewProspects}
          />
        </div>
      </form>
    </TabBody>
  );
}
