
import { useState } from 'react';
import { useParams, useRouter, Link } from '@/lib/router';
import { SequenceEditorWrapper } from './sequence-editor-wrapper';
import { useWorkflowEditorData } from '@/hooks/use-workflow-editor-data';
import { useSequence, useLaunchSequence, useStartSequence, usePauseSequence } from '@/hooks/queries/use-sequences-queries';
import { SequenceWizardNav } from './components/sequence-wizard-nav';
import { WorkflowEditorShell } from '@/components/workflow-editor';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { CheckCircle2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import { useTranslations } from '@weldsuite/i18n/client';

export default function SequenceEditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const t = getTranslations('crm');
  const st = useTranslations();

  const {
    workflow,
    actionTypes,
    triggerTypes,
    entityEvents,
    emailAccounts,
    workspaceMembers,
    workflowVariables,
    workflowsForChaining,
    webhookData,
    isLoading,
    isError: isWorkflowError,
  } = useWorkflowEditorData(id);
  const { data: sequenceResp } = useSequence(id);
  const launchSequence = useLaunchSequence();
  const startSequence = useStartSequence();
  const pauseSequence = usePauseSequence();
  const [launchOpen, setLaunchOpen] = useState(false);

  if (isLoading) {
    return <PageLoader />;
  }

  if (isWorkflowError || !workflow) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-2">
          <p className="text-muted-foreground">{t.sequenceEditorPage.notFound}</p>
        </div>
      </div>
    );
  }

  const isDraft = workflow.status === 'draft';
  const isActive = workflow.status === 'active';
  const isPaused = workflow.status === 'paused';
  const sequence = sequenceResp?.data;
  const stepCount = Array.isArray(workflow.steps) ? workflow.steps.length : 0;
  const enrolledCount = sequence?.enrolledCount || 0;

  const hasSteps = stepCount > 0;
  const hasPeople = enrolledCount > 0;
  const isReady = hasSteps && hasPeople;

  const handleLaunch = async () => {
    if (!isReady) return;
    try {
      setLaunchOpen(false);
      const result = await launchSequence.mutateAsync(id);
      const count = result.data?.activated || 0;
      toast.success(t.sequenceEditorPage.launchedSuccess.replace('{count}', String(count)));
      router.push(`/weldcrm/sequences/${id}/people`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.sequenceEditorPage.launchFailed);
    }
  };

  const handleStart = async () => {
    try {
      await startSequence.mutateAsync(id);
      toast.success(t.sequenceEditorPage.resumedSuccess);
    } catch {
      toast.error(t.sequenceEditorPage.resumeFailed);
    }
  };

  const handlePause = async () => {
    try {
      await pauseSequence.mutateAsync(id);
      toast.success(t.sequenceEditorPage.pausedSuccess);
    } catch {
      toast.error(t.sequenceEditorPage.pauseFailed);
    }
  };

  return (
    <WorkflowEditorShell
      nav={({ onBeforeNavigate, actionsRef }) => (
        <SequenceWizardNav
          sequenceId={id}
          sequenceName={workflow.name}
          currentStep={1}
          isDraft={isDraft}
          onBeforeNavigate={onBeforeNavigate}
          rightContent={
            <div className="flex items-center gap-1 md:gap-2">
              <div ref={actionsRef} className="flex items-center gap-1 md:gap-2" />
              {isDraft && (
                <Popover open={launchOpen} onOpenChange={setLaunchOpen}>
                  <PopoverTrigger asChild>
                    <Button size="sm" disabled={launchSequence.isPending}>
                      {launchSequence.isPending ? t.sequenceEditorPage.buttonLaunching : t.sequenceEditorPage.buttonLaunch}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-72 p-0">
                    <div className="p-4 space-y-3">
                      <p className="text-sm font-medium">{t.sequenceEditorPage.launchChecklist}</p>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2.5">
                          {hasSteps ? (
                            <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
                          ) : (
                            <XCircle className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          )}
                          <span className="text-sm text-muted-foreground">
                            {hasSteps ? t.sequenceEditorPage.stepsAdded : t.sequenceEditorPage.stepsRequired}
                          </span>
                        </div>
                        <div className="flex items-center gap-2.5">
                          {hasPeople ? (
                            <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
                          ) : (
                            <XCircle className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          )}
                          <span className="text-sm text-muted-foreground">
                            {hasPeople
                              ? (enrolledCount === 1
                                ? t.sequenceEditorPage.personEnrolled.replace('{count}', String(enrolledCount))
                                : t.sequenceEditorPage.peopleEnrolled.replace('{count}', String(enrolledCount)))
                              : t.sequenceEditorPage.enrollPeople}
                          </span>
                          {!hasPeople && (
                            <Link
                              href={`/weldcrm/sequences/${id}/people`}
                              className="text-xs text-muted-foreground hover:text-foreground ml-auto px-1.5 py-0.5 rounded-md hover:bg-muted transition-colors"
                              onClick={() => setLaunchOpen(false)}
                            >
                              {t.sequenceEditorPage.addLink}
                            </Link>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="border-t px-4 py-3">
                      <Button
                        size="sm"
                        className="w-full"
                        disabled={!isReady || launchSequence.isPending}
                        onClick={handleLaunch}
                      >
                        {launchSequence.isPending ? t.sequenceEditorPage.buttonLaunching : t.sequenceEditorPage.buttonLaunchSequence}
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>
              )}
              {isActive && (
                <Button size="sm" variant="outline" onClick={handlePause} disabled={pauseSequence.isPending}>
                  {t.sequenceEditorPage.buttonPause}
                </Button>
              )}
              {isPaused && (
                <Button size="sm" onClick={handleStart} disabled={startSequence.isPending}>
                  {t.sequenceEditorPage.buttonResume}
                </Button>
              )}
            </div>
          }
        />
      )}
      editor={({ actionsRef, setDirty }) => (
        <SequenceEditorWrapper
          sequenceId={id}
          isDraft={isDraft}
          onDirtyChange={setDirty}
          workflow={workflow}
          actionTypes={actionTypes || []}
          triggerTypes={triggerTypes || []}
          entityEvents={entityEvents || []}
          emailAccounts={emailAccounts || []}
          workspaceMembers={workspaceMembers || []}
          workflowVariables={workflowVariables || []}
          workflowsForChaining={workflowsForChaining || []}
          webhookData={webhookData || null}
          basePath="/weldcrm/sequences"
          parentLabel={st('sweep.weldcrm.sequences.parentLabel')}
          parentHref="/weldcrm"
          listLabel={st('sweep.weldcrm.sequences.listLabel')}
          allowedActionIds={['send_email', 'delay', 'condition']}
          actionsPortalRef={actionsRef}
        />
      )}
    />
  );
}
