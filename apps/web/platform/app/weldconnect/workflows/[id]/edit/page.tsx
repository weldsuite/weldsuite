
import { Link, useParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { useWorkflowEditorData } from '@/hooks/use-workflow-editor-data';
import { WorkflowEditorClient, WorkflowEditorShell } from '@/components/workflow-editor';
import { EditorWizardNav } from '@/components/editor-wizard-nav';
import { AlertTriangle, GitPullRequest, History, RotateCw, Settings } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';

export default function WorkflowEditPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useI18n();
  const tws = t.weldconnect.workflowSettings;
  const te = t.weldconnect.workflowEditError;

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
    isNotFound,
    refetch,
  } = useWorkflowEditorData(id);

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  // A request failure (e.g. a workflow fetch that fired before Clerk finished
  // bootstrapping the token on a hard refresh) shows a retry state instead of
  // throwing notFound() into the message-less root error boundary. A genuine
  // "not found" (fetch succeeded, no workflow) shows its own message.
  if (isWorkflowError || isNotFound || !workflow) {
    const notFoundCase = isNotFound && !isWorkflowError;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <AlertTriangle className="h-10 w-10 text-muted-foreground" />
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{notFoundCase ? te.notFoundTitle : te.title}</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {notFoundCase ? te.notFoundDescription : te.description}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!notFoundCase && (
            <Button variant="default" size="sm" onClick={() => refetch()}>
              <RotateCw className="mr-1.5 h-4 w-4" />
              {te.retry}
            </Button>
          )}
          <Button variant="outline" size="sm" asChild>
            <Link href="/weldconnect/workflows">{te.back}</Link>
          </Button>
        </div>
      </div>
    );
  }

  const wizardTabs = [
    { label: tws.tabEditor, href: `/weldconnect/workflows/${id}/edit`, icon: GitPullRequest },
    { label: tws.tabExecutions, href: `/weldconnect/workflows/${id}/edit?panel=runs`, icon: History },
    { label: tws.tabSettings, href: `/weldconnect/workflows/${id}/settings`, icon: Settings },
  ];

  return (
    <WorkflowEditorShell
      nav={({ onBeforeNavigate, actionsRef }) => (
        <EditorWizardNav
          tabs={wizardTabs}
          currentStep={1}
          onBeforeNavigate={onBeforeNavigate}
          rightContent={<div ref={actionsRef} className="flex items-center gap-1 md:gap-2" />}
        />
      )}
      editor={({ actionsRef, setDirty }) => (
        <WorkflowEditorClient
          workflow={workflow}
          actionTypes={actionTypes ?? []}
          triggerTypes={triggerTypes ?? []}
          entityEvents={entityEvents ?? []}
          emailAccounts={emailAccounts}
          workspaceMembers={workspaceMembers}
          workflowVariables={workflowVariables}
          workflowsForChaining={workflowsForChaining}
          webhookData={webhookData}
          hideNavTabs
          actionsPortalRef={actionsRef}
          onDirtyChange={setDirty}
        />
      )}
    />
  );
}
