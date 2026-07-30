
import { useParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import {
  useWorkflowDetail,
  useEditorWorkspaceMembers,
  useWorkflowVariables,
} from '@/hooks/use-workflow-editor-data';
import type { EditorWorkflow, WorkflowStepBag, WorkflowTriggerBag } from '@/components/workflow-editor/workflow-editor-client';
import { HelpdeskWorkflowEditorClient } from './helpdesk-workflow-editor';
import type { HelpdeskWorkflow, WorkflowStep, WorkflowTrigger } from './types';
import { useI18n } from '@/lib/i18n/provider';

function toHelpdeskTrigger(t: WorkflowTriggerBag): WorkflowTrigger {
  return {
    id: typeof t.id === 'string' ? t.id : undefined,
    type: t.type,
    entityType: typeof t.entityType === 'string' ? t.entityType : undefined,
    eventType: typeof t.eventType === 'string' ? t.eventType : undefined,
    config: t.config as Record<string, unknown> | undefined,
    filters: t.filters as unknown[] | undefined,
  };
}

function toHelpdeskStep(s: WorkflowStepBag): WorkflowStep {
  return {
    id: s.id ?? '',
    type: s.type ?? '',
    name: s.name ?? '',
    description: s.description,
    config: s.config,
    parentBranchId: s.parentBranchId,
  };
}

function toHelpdeskWorkflow(workflow: EditorWorkflow): HelpdeskWorkflow {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description ?? undefined,
    status: workflow.status ?? undefined,
    triggers: (workflow.triggers ?? []).map(toHelpdeskTrigger),
    steps: (workflow.steps ?? []).map(toHelpdeskStep),
  };
}

export default function HelpdeskWorkflowEditPage() {
  const { t } = useI18n();
  const { id } = useParams<{ id: string }>();

  const { data: workflow, isLoading: isWorkflowLoading } = useWorkflowDetail(id, { module: 'helpdesk' });
  const { data: workspaceMembers, isLoading: isMembersLoading } = useEditorWorkspaceMembers();
  const { data: workflowVariables, isLoading: isVariablesLoading } = useWorkflowVariables(id);

  const isLoading = isWorkflowLoading || isMembersLoading || isVariablesLoading;

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  if (!workflow) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground">{t.helpdesk.workflowsPage.workflowNotFound}</p>
      </div>
    );
  }

  return (
    <HelpdeskWorkflowEditorClient
      workflow={toHelpdeskWorkflow(workflow)}
      workspaceMembers={workspaceMembers}
      workflowVariables={workflowVariables}
    />
  );
}
