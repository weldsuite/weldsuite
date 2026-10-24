/**
 * Last step of a template: defaults for every request made from it (message,
 * signing order, reminders), what is still missing, and "Use template". There
 * is no Send here: a template only becomes a request when it is used.
 */

import { useState } from 'react';
import { FilePlus2 } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import type { SignEnvelopeDetail } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { targetOf, useUpdateSignEnvelope } from '@/hooks/queries/use-weldsign-queries';
import { MessageField, ReadinessChecklist, ReminderSettings, SigningOrderToggle, SummaryStats } from '../../envelope/settings-fields';
import { readinessProblems } from '../../lib/readiness';
import { recipientLabel } from '../../lib/recipients';
import { canUseTemplate } from '../../lib/use-template';
import { UseTemplateDialog } from '../use-template-dialog';

export function TemplateSettingsStep({ template, editable }: Readonly<{ template: SignEnvelopeDetail; editable: boolean }>) {
  const { t } = useI18n();
  const tt = t.weldsign.templates;
  const ts = tt.settings;
  const tr = t.weldsign.editor.review;
  const update = useUpdateSignEnvelope(targetOf(template));
  const canUse = useCan('sign_envelopes:create');
  const [using, setUsing] = useState(false);

  // Roles are what a template has in place of people, so problems name the role.
  const problems = readinessProblems(template, (role) => recipientLabel(role, 'template'));
  const usable = canUseTemplate({ documentCount: template.documents.length, roles: template.recipientList });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <div>
        <h2 className="text-lg font-semibold">{ts.title}</h2>
        <p className="text-sm text-muted-foreground">{ts.description}</p>
      </div>

      <MessageField message={template.message} disabled={!editable} onSave={(message) => update.mutate({ message })} />

      <SigningOrderToggle
        checked={template.signingOrderEnabled}
        disabled={!editable}
        onChange={(signingOrderEnabled) => update.mutate({ signingOrderEnabled })}
      />

      <ReminderSettings settings={template} editable={editable} save={(input) => update.mutate(input)} />

      <SummaryStats
        title={ts.summary}
        stats={[
          { label: tr.summaryDocuments, value: template.documents.length },
          { label: ts.summaryRoles, value: template.recipientList.length },
          { label: tr.summaryFields, value: template.fields.length },
        ]}
      />

      <ReadinessChecklist
        problems={problems}
        heading={ts.problems}
        messages={{
          ready: ts.ready,
          noDocuments: ts.noDocuments,
          noSigners: ts.noSigners,
          signerWithoutSignature: ts.signerWithoutSignature,
        }}
      />

      {canUse && (
        <div className="flex flex-col items-end gap-1.5">
          <Button disabled={!usable} onClick={() => setUsing(true)}>
            <FilePlus2 />
            {ts.useTemplate}
          </Button>
          {!usable && <p className="text-xs text-muted-foreground">{tt.cannotUse}</p>}
        </div>
      )}

      <UseTemplateDialog templateId={using ? template.id : null} onClose={() => setUsing(false)} />
    </div>
  );
}
