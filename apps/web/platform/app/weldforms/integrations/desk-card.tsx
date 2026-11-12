/** WeldDesk integration: open a ticket per response from recall templates. */

import { useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import {
  deskIntegrationConfigSchema,
  type DeskIntegrationConfig,
  type FormDetail,
  type FormIntegration,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { useI18n } from '@/lib/i18n/provider';
import { useDepartments } from '@/hooks/queries/use-helpdesk-queries';
import { FieldSelect } from './field-select';
import { IntegrationCard } from './integration-card';
import { TagListInput } from './tag-list-input';
import { TemplateField } from './template-field';
import { useIntegration } from './use-integration';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const DEFAULT_INBOX = '__default__';

function parseConfig(integration: FormIntegration | null): DeskIntegrationConfig {
  const parsed = deskIntegrationConfigSchema.safeParse(integration?.config ?? {});
  return parsed.success ? parsed.data : deskIntegrationConfigSchema.parse({});
}

export function DeskCard({ form, integration }: Readonly<{ form: FormDetail; integration: FormIntegration | null }>) {
  const { t } = useI18n();
  const ti = t.weldformsResults.integrations;
  const td = ti.desk;
  const [config, setConfig] = useState<DeskIntegrationConfig>(() => parseConfig(integration));
  const [enabled, setEnabled] = useState(integration?.enabled ?? true);
  const actions = useIntegration(form.id, integration);
  const inboxes = useDepartments();
  const patch = (next: Partial<DeskIntegrationConfig>) => setConfig((current) => ({ ...current, ...next }));

  return (
    <IntegrationCard
      icon={LifeBuoy}
      title={td.title}
      description={td.description}
      removeAction={td.actionPerson}
      integration={integration}
      enabled={enabled}
      onEnabledChange={setEnabled}
      canSave
      saving={actions.saving}
      onSave={() => void actions.save('desk', enabled, config)}
      testing={actions.testing}
      onTest={() => void actions.runTest()}
      removing={actions.removing}
      onRemove={() => void actions.remove()}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="desk-inbox">{td.inbox}</Label>
          <Select
            value={config.departmentId ?? DEFAULT_INBOX}
            onValueChange={(value) => patch({ departmentId: value === DEFAULT_INBOX ? undefined : value })}
          >
            <SelectTrigger id="desk-inbox">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_INBOX}>{td.defaultInbox}</SelectItem>
              {(inboxes.data?.data ?? []).map((inbox) => (
                <SelectItem key={inbox.id} value={inbox.id}>
                  {inbox.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="desk-priority">{td.priority}</Label>
          <Select value={config.priority} onValueChange={(value) => patch({ priority: value as DeskIntegrationConfig['priority'] })}>
            <SelectTrigger id="desk-priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITIES.map((priority) => (
                <SelectItem key={priority} value={priority}>
                  {td.priorities[priority]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <TemplateField
        id="desk-subject"
        label={td.subject}
        value={config.subject}
        onChange={(subject) => patch({ subject })}
        definition={form.definition}
      />
      <TemplateField
        id="desk-body"
        label={td.body}
        hint={td.bodyHint}
        value={config.body}
        onChange={(body) => patch({ body })}
        definition={form.definition}
        multiline
      />

      <FieldSelect
        id="desk-requester"
        label={td.requester}
        hint={td.requesterHint}
        definition={form.definition}
        types={['email', 'contact_info']}
        value={config.requesterFieldId}
        onChange={(value) => patch({ requesterFieldId: value })}
        noneLabel={td.noRequester}
      />

      <TagListInput id="desk-tags" label={ti.tags} placeholder={ti.tagsPlaceholder} value={config.tags} onChange={(tags) => patch({ tags })} />

      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="desk-attach">{ti.attachFiles}</Label>
        <Switch id="desk-attach" checked={config.attachFiles} onCheckedChange={(v) => patch({ attachFiles: v })} />
      </div>
    </IntegrationCard>
  );
}
