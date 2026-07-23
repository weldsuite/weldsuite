
import { useParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { useTemplate } from '@/hooks/queries/use-automation-queries';
import { useI18n } from '@/lib/i18n/provider';
import {
  useActionTypes,
  useTriggerTypes,
  useEntityEvents,
  useEmailAccounts,
  useEditorWorkspaceMembers,
} from '@/hooks/use-workflow-editor-data';
import { TemplateEditorClient } from './template-editor-client';

export default function TemplateEditPage() {
  const { t } = useI18n();
  const { id } = useParams<{ id: string }>();

  const { data: templateResult, isLoading: isTemplateLoading } = useTemplate(id);
  const { data: actionTypes, isLoading: isActionTypesLoading } = useActionTypes();
  const { data: triggerTypes, isLoading: isTriggerTypesLoading } = useTriggerTypes();
  const { data: entityEvents, isLoading: isEntityEventsLoading } = useEntityEvents();
  const { data: emailAccounts, isLoading: isEmailAccountsLoading } = useEmailAccounts();
  const { data: workspaceMembers, isLoading: isMembersLoading } = useEditorWorkspaceMembers();

  const isLoading =
    isTemplateLoading ||
    isActionTypesLoading ||
    isTriggerTypesLoading ||
    isEntityEventsLoading ||
    isEmailAccountsLoading ||
    isMembersLoading;

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  const template = templateResult?.data;

  if (!template) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground">{t.weldconnect.templateEditorPage.templateNotFound}</p>
      </div>
    );
  }

  return (
    <TemplateEditorClient
      template={template}
      actionTypes={actionTypes ?? []}
      triggerTypes={triggerTypes ?? []}
      entityEvents={entityEvents ?? []}
      emailAccounts={emailAccounts}
      workspaceMembers={workspaceMembers}
    />
  );
}
