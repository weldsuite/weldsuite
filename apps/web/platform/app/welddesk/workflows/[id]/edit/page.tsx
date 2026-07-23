
import { useParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import {
  useWorkflowDetail,
  useEditorWorkspaceMembers,
  useWorkflowVariables,
} from '@/hooks/use-workflow-editor-data';
import { HelpdeskWorkflowEditorClient } from './helpdesk-workflow-editor';
import { useI18n } from '@/lib/i18n/provider';

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
      workflow={workflow}
      workspaceMembers={workspaceMembers}
      workflowVariables={workflowVariables}
    />
  );
}
