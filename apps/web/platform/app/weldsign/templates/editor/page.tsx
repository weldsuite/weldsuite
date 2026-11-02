/**
 * One template: the draft editor with roles in place of people. Steps:
 * documents, roles, fields, settings (with "Use template"). Every change is
 * saved as it is made; the fields step saves its whole field set on "Save" and
 * when you leave it. Without `sign_templates:update` it opens read-only, and
 * "Use template" is still there for anyone who may make requests.
 */

import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { useCan } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { PageLoader } from '@/components/page-loader';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { targetOf, useSignTemplate } from '@/hooks/queries/use-weldsign-queries';
import { DocumentsStep } from '../../envelope/documents-step';
import { EditorFrame } from '../../envelope/editor-frame';
import { FieldsStep } from '../../envelope/fields-step';
import { isNotFound } from '../../lib/errors';
import { RolesStep } from './roles-step';
import { TemplateSettingsStep } from './settings-step';

const STEPS = ['documents', 'roles', 'fields', 'settings'] as const;
type TemplateStep = (typeof STEPS)[number];

export default function TemplatePage() {
  const { templateId = '' } = useParams({ strict: false });
  return <TemplateEditor key={templateId} templateId={templateId} />;
}

function TemplateEditor({ templateId }: Readonly<{ templateId: string }>) {
  const { t } = useI18n();
  const tt = t.weldsign.templates;
  const canRead = useCan('sign_templates:read');
  const { data: template, isLoading, error } = useSignTemplate(templateId, canRead);
  const [step, setStep] = useState<TemplateStep>('documents');

  useBreadcrumbs(
    [
      { label: t.weldsign.breadcrumb.home, href: '/weldsign' },
      { label: tt.title, href: '/weldsign/templates' },
      { label: template?.title ?? '…' },
    ],
    { enabled: !!template },
  );

  if (!canRead) return <div className="p-10 text-center text-muted-foreground">{tt.noAccess}</div>;
  if (isLoading) return <PageLoader fullScreen={false} />;
  if (error || !template) {
    return <div className="p-10 text-center text-muted-foreground">{isNotFound(error) ? tt.editor.notFound : tt.editor.loadFailed}</div>;
  }

  const editable = template.canEdit;
  const banner = editable ? null : (
    <div className="border-b bg-muted/50 px-6 py-2 text-sm text-muted-foreground">{tt.editor.readOnly}</div>
  );

  return (
    <EditorFrame<TemplateStep>
      target={targetOf(template)}
      title={template.title}
      titleLabel={tt.editor.titleLabel}
      editable={editable}
      back={{ to: '/weldsign/templates', label: tt.editor.backToTemplates }}
      badge={<Badge variant="outline">{tt.editor.badge}</Badge>}
      steps={STEPS}
      stepLabels={t.weldsign.editor.steps}
      step={step}
      onStepChange={setStep}
      banner={banner}
    >
      {step === 'documents' && <DocumentsStep envelope={template} editable={editable} />}
      {step === 'roles' && <RolesStep template={template} editable={editable} />}
      {step === 'fields' && <FieldsStep envelope={template} editable={editable} />}
      {step === 'settings' && <TemplateSettingsStep template={template} editable={editable} />}
    </EditorFrame>
  );
}
