/**
 * The Sequence tab, laid out like a WeldConnect workflow (and a WeldCRM
 * sequence): the steps on WeldConnect's canvas and the selected step in the
 * panel beside it, with Save in the page's nav row (`actionsTarget`). Saving
 * replaces all steps, which the API refuses while the campaign is active, so
 * the editor is locked then and says to pause first.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { EditorPanelBody, EditorPanelHeader, EditorSidePanel } from '@weldsuite/ui/components/editor-side-panel';
import { WorkflowCanvas, type WorkflowCanvasLabels } from '@weldsuite/ui/components/workflow-canvas';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  replaceReachStepsSchema,
  type ReachCampaignDetail,
} from '@weldsuite/app-api-client/schemas/reach';
import { useReplaceReachSteps, useReachEnrollments } from '@/hooks/queries/use-reach-campaign-queries';
import { useReachProspects } from '@/hooks/queries/use-reach-prospect-queries';
import { errorMessage } from '@/app/weldreach/components/engage/kit';
import {
  MAX_STEPS,
  customFieldNames,
  newStep,
  normalizeSteps,
  stepsToDraft,
} from '../../lib/sequence';
import {
  sequenceNodeId,
  sequenceToCanvas,
  stepIndexForNode,
  type SequenceCanvasText,
} from '../../lib/sequence-canvas';
import type { PreviewProspect } from './preview-pane';
import { StepPanel, type SequenceValues } from './step-panel';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';

const SAMPLE_SIZE = 100;
const PREVIEW_PROSPECTS = 50;
const NOOP = () => undefined;

/** "3 days, 4 hours" for a Wait node. */
function useWaitSummary() {
  const t = useTranslations();
  return useCallback(
    (days: number, hours: number) => {
      const parts: string[] = [];
      if (days > 0) parts.push(days === 1 ? t('reachEngage.sequence.canvas.oneDay') : t('reachEngage.sequence.canvas.days', { count: days }));
      if (hours > 0) parts.push(hours === 1 ? t('reachEngage.sequence.canvas.oneHour') : t('reachEngage.sequence.canvas.hours', { count: hours }));
      return parts.join(', ');
    },
    [t],
  );
}

export function SequenceTab({
  campaign,
  canEdit,
  actionsTarget,
}: Readonly<{
  campaign: ReachCampaignDetail;
  canEdit: boolean;
  /** Where Save / Discard go, the page's nav row; without one they sit above the canvas. */
  actionsTarget?: HTMLElement | null;
}>) {
  const t = useTranslations();
  const waitSummary = useWaitSummary();
  const replaceSteps = useReplaceReachSteps(campaign.id);
  const [failure, setFailure] = useState<string | null>(null);

  const locked = campaign.status === 'active';
  const readOnly = locked || !canEdit;

  const serverDraft = useMemo(() => stepsToDraft(campaign.steps), [campaign.steps]);
  const form = useForm<SequenceValues>({
    resolver: zodResolver(replaceReachStepsSchema),
    defaultValues: { steps: serverDraft },
  });
  const { fields, insert, remove, move } = useFieldArray({ control: form.control, name: 'steps' });
  const { isDirty } = form.formState;
  const steps = useWatch({ control: form.control, name: 'steps' });

  // The open step is tracked by its field id, so it stays open when steps move.
  const [selectedKey, setSelectedKey] = useState<string | null>(fields[0]?.id ?? null);
  const selectedIndex = fields.findIndex((field) => field.id === selectedKey);

  // Pick up changes made elsewhere (another tab, a pause/resume) unless there are unsaved edits.
  useEffect(() => {
    if (!form.formState.isDirty) form.reset({ steps: serverDraft });
  }, [serverDraft, form]);

  // A reset gives every step a new field id: keep the same position open.
  const lastIndex = useRef(0);
  useEffect(() => {
    if (selectedIndex !== -1) lastIndex.current = selectedIndex;
    else if (selectedKey !== null && fields.length > 0) {
      setSelectedKey(fields[Math.min(lastIndex.current, fields.length - 1)]?.id ?? null);
    }
  }, [fields, selectedIndex, selectedKey]);

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

  const stepName = useCallback(
    (index: number) =>
      index === 0 ? t('reachEngage.sequence.firstEmail') : t('reachEngage.sequence.followUp', { number: index }),
    [t],
  );

  const canvasText = useMemo<SequenceCanvasText>(
    () => ({
      start: t('reachEngage.sequence.canvas.start'),
      stepName,
      wait: t('reachEngage.sequence.canvas.wait'),
      waitSummary,
      from: t('reachEngage.sequence.canvas.from'),
      fromValue: t('reachEngage.sequence.canvas.fromValue'),
      to: t('reachEngage.sequence.canvas.to'),
      toValue: '{{email}}',
      subject: t('reachEngage.sequence.subject'),
      subjectPlaceholder: t('reachEngage.sequence.subjectPlaceholder'),
      bodyPlaceholder: t('reachEngage.sequence.bodyPlaceholder'),
    }),
    [t, stepName, waitSummary],
  );
  const canvas = useMemo(
    () => sequenceToCanvas(steps ?? [], fields.map((field) => field.id), canvasText),
    [steps, fields, canvasText],
  );

  const labels = useMemo<WorkflowCanvasLabels>(
    () => ({
      zoomIn: t('weldconnect.flowEditor.zoomIn'),
      zoomOut: t('weldconnect.flowEditor.zoomOut'),
      resetLayout: t('weldconnect.flowEditor.resetLayout'),
      setupRequired: t('weldconnect.flowEditor.setupRequired'),
      addStep: t('reachEngage.sequence.addStep'),
      lockedTriggerSummary: t('reachEngage.sequence.canvas.startSummary'),
    }),
    [t],
  );

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

  // The canvas reads its callbacks from effects; refs keep them stable across renders.
  const latest = useRef({ canvas, fields });
  latest.current = { canvas, fields };

  const selectCanvasStep = useCallback((canvasIndex: number) => {
    const index = latest.current.canvas.nodes[canvasIndex]?.index;
    if (index !== undefined) setSelectedKey(latest.current.fields[index]?.id ?? null);
  }, []);

  const addStepAfter = useCallback(
    (sourceNodeId?: string) => {
      const after = stepIndexForNode(latest.current.canvas, sourceNodeId);
      const at = after === null ? 0 : after + 1;
      insert(at, newStep());
      // `insert` gives the new step its field id on the next render; select it by position then.
      lastIndex.current = at;
      setSelectedKey('__new__');
    },
    [insert],
  );

  function removeStep(index: number) {
    remove(index);
    lastIndex.current = Math.max(0, index - 1);
    setSelectedKey('__removed__');
  }

  const deleteCanvasStep = useCallback(
    (canvasIndex: number) => {
      const index = latest.current.canvas.nodes[canvasIndex]?.index;
      if (index === undefined || readOnly || latest.current.fields.length <= 1) return;
      remove(index);
      lastIndex.current = Math.max(0, index - 1);
      setSelectedKey('__removed__');
    },
    [readOnly, remove],
  );

  const canAdd = !readOnly && fields.length < MAX_STEPS;
  const selectedNodeId = selectedIndex === -1 ? null : sequenceNodeId(fields[selectedIndex]!.id, 'email');
  const needsStep = Boolean(form.formState.errors.steps?.root);
  const atMax = fields.length >= MAX_STEPS;

  const actions = (
    <>
      {isDirty && !readOnly && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={replaceSteps.isPending}
          onClick={() => form.reset({ steps: serverDraft })}
        >
          {t('reachEngage.common.discard')}
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        disabled={readOnly || !isDirty || replaceSteps.isPending}
        onClick={() => void submit()}
      >
        {replaceSteps.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t('reachEngage.sequence.save')}
      </Button>
    </>
  );

  return (
    // A div, not a form: the canvas's own buttons (zoom, reset) have no type and
    // would submit it. Save submits through react-hook-form directly.
    <div className="flex min-h-0 flex-1 flex-col">
      {locked && (
        <InfoBanner
          variant="warning"
          title={t('reachEngage.sequence.lockedTitle')}
          className="rounded-none border-x-0 border-t-0"
        >
          {t('reachEngage.sequence.lockedHint')}
        </InfoBanner>
      )}

      {actionsTarget ? (
        createPortal(actions, actionsTarget)
      ) : (
        <div className="flex h-[52px] shrink-0 items-center justify-end gap-2 border-b px-4">{actions}</div>
      )}

      {(failure || needsStep || atMax) && (
        <div className="space-y-2 border-b px-4 py-3">
          <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
          {needsStep && <p className="text-xs text-destructive">{t('reachEngage.sequence.needsStep')}</p>}
          {atMax && (
            <p className="text-xs text-muted-foreground">{t('reachEngage.sequence.maxSteps', { count: MAX_STEPS })}</p>
          )}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="relative min-w-0 flex-1">
          <WorkflowCanvas
            trigger={canvas.trigger}
            steps={canvas.steps}
            onSelectTrigger={NOOP}
            onSelectStep={selectCanvasStep}
            onDeleteStep={deleteCanvasStep}
            onStepsChange={NOOP}
            onAddStep={canAdd ? addStepAfter : undefined}
            onDeselect={() => setSelectedKey(null)}
            selectedNodeId={selectedNodeId}
            triggerLocked
            labels={labels}
            className="h-full w-full"
          />
        </div>

        <EditorSidePanel open={selectedIndex !== -1}>
          {selectedIndex === -1 ? (
            <>
              <EditorPanelHeader title={t('reachEngage.sequence.panelTitle')} />
              <EditorPanelBody>
                <p className="text-sm text-muted-foreground">{t('reachEngage.sequence.panelHint')}</p>
              </EditorPanelBody>
            </>
          ) : (
            <StepPanel
              key={fields[selectedIndex]!.id}
              form={form}
              index={selectedIndex}
              total={fields.length}
              title={stepName(selectedIndex)}
              disabled={readOnly}
              campaignId={campaign.id}
              customFields={customFields}
              previewProspects={previewProspects}
              onMove={(direction) => move(selectedIndex, selectedIndex + direction)}
              onRemove={() => removeStep(selectedIndex)}
              onClose={() => setSelectedKey(null)}
            />
          )}
        </EditorSidePanel>
      </div>
    </div>
  );
}
