
import { useParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { useTemplate } from '@/hooks/queries/use-automation-queries';
import { useI18n } from '@/lib/i18n/provider';
import {
  useEmailAccounts,
  useEditorWorkspaceMembers,
} from '@/hooks/use-workflow-editor-data';
import { TemplateEditorClient, type RawTemplateTrigger, type RawTemplateStep } from './template-editor-client';

export default function TemplateEditPage() {
  const { t } = useI18n();
  const { id } = useParams<{ id: string }>();

  const { data: templateResult, isLoading: isTemplateLoading } = useTemplate(id);
  const { data: emailAccounts, isLoading: isEmailAccountsLoading } = useEmailAccounts();
  const { data: workspaceMembers, isLoading: isMembersLoading } = useEditorWorkspaceMembers();

  const isLoading = isTemplateLoading || isEmailAccountsLoading || isMembersLoading;

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
      template={{
        ...template,
        triggers: template.triggers as RawTemplateTrigger[],
        steps: template.steps as RawTemplateStep[],
      }}
      emailAccounts={emailAccounts}
      workspaceMembers={workspaceMembers}
    />
  );
}
