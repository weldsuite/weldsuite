
import { useState, type ComponentProps } from 'react';
import { useParams, useRouter, Link } from '@/lib/router';
import { SequenceEditorWrapper } from './sequence-editor-wrapper';
import { useWorkflowEditorData } from '@/hooks/use-workflow-editor-data';
import { useSequence, useLaunchSequence, useStartSequence, usePauseSequence } from '@/hooks/queries/use-sequences-queries';
import { SequenceWizardNav } from './components/sequence-wizard-nav';
import { WorkflowEditorShell } from '@/components/workflow-editor';
import type { WorkflowEditorShellProps } from '@/components/workflow-editor/workflow-editor-shell';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { CheckCircle2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import { useTranslations } from '@weldsuite/i18n/client';

type ShellRenderProps = Parameters<WorkflowEditorShellProps['nav']>[0];

function getEnrolledLabel(enrolledCount: number): string {
  const t = getTranslations('crm');
  const template =
    enrolledCount === 1 ? t.sequenceEditorPage.personEnrolled : t.sequenceEditorPage.peopleEnrolled;
  return template.replace('{count}', String(enrolledCount));
}

function ChecklistIcon({ done }: Readonly<{ done: boolean }>) {
  return done ? (
    <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
  ) : (
    <XCircle className="h-4 w-4 text-muted-foreground flex-shrink-0" />
  );
}

interface LaunchPopoverProps {
  sequenceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPending: boolean;
  hasSteps: boolean;
  hasPeople: boolean;
  isReady: boolean;
  enrolledCount: number;
  onLaunch: () => void;
}

function LaunchPopover({
  sequenceId,
  open,
  onOpenChange,
  isPending,
  hasSteps,
  hasPeople,
  isReady,
  enrolledCount,
  onLaunch,
}: Readonly<LaunchPopoverProps>) {
  const t = getTranslations('crm');
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button size="sm" disabled={isPending}>
          {isPending ? t.sequenceEditorPage.buttonLaunching : t.sequenceEditorPage.buttonLaunch}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="p-4 space-y-3">
          <p className="text-sm font-medium">{t.sequenceEditorPage.launchChecklist}</p>
          <div className="space-y-2">
            <div className="flex items-center gap-2.5">
              <ChecklistIcon done={hasSteps} />
              <span className="text-sm text-muted-foreground">
                {hasSteps ? t.sequenceEditorPage.stepsAdded : t.sequenceEditorPage.stepsRequired}
              </span>
            </div>
            <div className="flex items-center gap-2.5">
              <ChecklistIcon done={hasPeople} />
              <span className="text-sm text-muted-foreground">
                {hasPeople ? getEnrolledLabel(enrolledCount) : t.sequenceEditorPage.enrollPeople}
              </span>
              {!hasPeople && (
                <Link
                  href={`/weldcrm/sequences/${sequenceId}/people`}
                  className="text-xs text-muted-foreground hover:text-foreground ml-auto px-1.5 py-0.5 rounded-md hover:bg-muted transition-colors"
                  onClick={() => onOpenChange(false)}
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
            disabled={!isReady || isPending}
            onClick={onLaunch}
          >
            {isPending ? t.sequenceEditorPage.buttonLaunching : t.sequenceEditorPage.buttonLaunchSequence}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface SequenceNavConfig {
  sequenceId: string;
  sequenceName: string;
  isDraft: boolean;
  isActive: boolean;
  isPaused: boolean;
  launchOpen: boolean;
  setLaunchOpen: (open: boolean) => void;
  isLaunchPending: boolean;
  isPausePending: boolean;
  isStartPending: boolean;
  hasSteps: boolean;
  hasPeople: boolean;
  isReady: boolean;
  enrolledCount: number;
  onLaunch: () => void;
  onPause: () => void;
  onStart: () => void;
}

function renderSequenceNav(config: SequenceNavConfig, { onBeforeNavigate, actionsRef }: ShellRenderProps) {
  const t = getTranslations('crm');
  return (
    <SequenceWizardNav
      sequenceId={config.sequenceId}
      sequenceName={config.sequenceName}
      currentStep={1}
      isDraft={config.isDraft}
      onBeforeNavigate={onBeforeNavigate}
      rightContent={
        <div className="flex items-center gap-1 md:gap-2">
          <div ref={actionsRef} className="flex items-center gap-1 md:gap-2" />
          {config.isDraft && (
            <LaunchPopover
              sequenceId={config.sequenceId}
              open={config.launchOpen}
              onOpenChange={config.setLaunchOpen}
              isPending={config.isLaunchPending}
              hasSteps={config.hasSteps}
              hasPeople={config.hasPeople}
              isReady={config.isReady}
              enrolledCount={config.enrolledCount}
              onLaunch={config.onLaunch}
            />
          )}
          {config.isActive && (
            <Button size="sm" variant="outline" onClick={config.onPause} disabled={config.isPausePending}>
              {t.sequenceEditorPage.buttonPause}
            </Button>
          )}
          {config.isPaused && (
            <Button size="sm" onClick={config.onStart} disabled={config.isStartPending}>
              {t.sequenceEditorPage.buttonResume}
            </Button>
          )}
        </div>
      }
    />
  );
}

type SequenceEditorConfig = Omit<
  ComponentProps<typeof SequenceEditorWrapper>,
  'onDirtyChange' | 'actionsPortalRef'
>;

function renderSequenceEditor(config: SequenceEditorConfig, { actionsRef, setDirty }: ShellRenderProps) {
  return <SequenceEditorWrapper {...config} onDirtyChange={setDirty} actionsPortalRef={actionsRef} />;
}

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

  const navConfig: SequenceNavConfig = {
    sequenceId: id,
    sequenceName: workflow.name,
    isDraft,
    isActive,
    isPaused,
    launchOpen,
    setLaunchOpen,
    isLaunchPending: launchSequence.isPending,
    isPausePending: pauseSequence.isPending,
    isStartPending: startSequence.isPending,
    hasSteps,
    hasPeople,
    isReady,
    enrolledCount,
    onLaunch: handleLaunch,
    onPause: handlePause,
    onStart: handleStart,
  };

  const editorConfig: SequenceEditorConfig = {
    sequenceId: id,
    isDraft,
    workflow,
    actionTypes: actionTypes || [],
    triggerTypes: triggerTypes || [],
    entityEvents: entityEvents || [],
    emailAccounts: emailAccounts || [],
    workspaceMembers: workspaceMembers || [],
    workflowVariables: workflowVariables || [],
    workflowsForChaining: workflowsForChaining || [],
    webhookData: webhookData || null,
    basePath: '/weldcrm/sequences',
    parentLabel: st('sweep.weldcrm.sequences.parentLabel'),
    parentHref: '/weldcrm',
    listLabel: st('sweep.weldcrm.sequences.listLabel'),
    allowedActionIds: ['send_email', 'delay', 'condition'],
  };

  return (
    <WorkflowEditorShell
      nav={(renderProps) => renderSequenceNav(navConfig, renderProps)}
      editor={(renderProps) => renderSequenceEditor(editorConfig, renderProps)}
    />
  );
}
