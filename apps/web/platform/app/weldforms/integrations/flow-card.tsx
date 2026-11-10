/** WeldFlow integration: create a task per response, in a project or as a personal task. */

import { useState } from 'react';
import { SquareCheck } from 'lucide-react';
import {
  flowIntegrationConfigSchema,
  type FlowIntegrationConfig,
  type FormDetail,
  type FormIntegration,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { useI18n } from '@/lib/i18n/provider';
import { useDeskWorkspaceMembers } from '@/hooks/queries/use-desk-workspace-members';
import { useProjects } from '@/hooks/queries/use-projects-queries';
import { FieldSelect } from './field-select';
import { IntegrationCard } from './integration-card';
import { TagListInput } from './tag-list-input';
import { TemplateField } from './template-field';
import { useIntegration } from './use-integration';

const PERSONAL = '__personal__';
const NOBODY = '__nobody__';

function parseConfig(integration: FormIntegration | null): FlowIntegrationConfig {
  const parsed = flowIntegrationConfigSchema.safeParse(integration?.config ?? {});
  return parsed.success ? parsed.data : flowIntegrationConfigSchema.parse({});
}

export function FlowCard({ form, integration }: Readonly<{ form: FormDetail; integration: FormIntegration | null }>) {
  const { t } = useI18n();
  const ti = t.weldformsResults.integrations;
  const tf = ti.flow;
  const [config, setConfig] = useState<FlowIntegrationConfig>(() => parseConfig(integration));
  const [enabled, setEnabled] = useState(integration?.enabled ?? true);
  const actions = useIntegration(form.id, integration);
  const projects = useProjects({ pageSize: 100 });
  const members = useDeskWorkspaceMembers();
  const patch = (next: Partial<FlowIntegrationConfig>) => setConfig((current) => ({ ...current, ...next }));

  return (
    <IntegrationCard
      icon={SquareCheck}
      title={tf.title}
      description={tf.description}
      removeAction={tf.actionPerson}
      integration={integration}
      enabled={enabled}
      onEnabledChange={setEnabled}
      canSave
      saving={actions.saving}
      onSave={() => void actions.save('flow', enabled, config)}
      testing={actions.testing}
      onTest={() => void actions.runTest()}
      removing={actions.removing}
      onRemove={() => void actions.remove()}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="flow-project">{tf.project}</Label>
          <Select
            value={config.projectId ?? PERSONAL}
            onValueChange={(value) => patch({ projectId: value === PERSONAL ? null : value })}
          >
            <SelectTrigger id="flow-project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={PERSONAL}>{tf.personalTask}</SelectItem>
              {(projects.data?.data ?? []).map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="flow-assignee">{tf.assignee}</Label>
          <Select
            value={config.assigneeUserId ?? NOBODY}
            onValueChange={(value) => patch({ assigneeUserId: value === NOBODY ? undefined : value })}
          >
            <SelectTrigger id="flow-assignee">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NOBODY}>{tf.noAssignee}</SelectItem>
              {(members.data ?? []).map((member) => (
                <SelectItem key={member.userId} value={member.userId}>
                  {member.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <TemplateField
        id="flow-title"
        label={tf.taskTitle}
        value={config.title}
        onChange={(title) => patch({ title })}
        definition={form.definition}
      />
      <TemplateField
        id="flow-description"
        label={tf.taskDescription}
        value={config.description}
        onChange={(description) => patch({ description })}
        definition={form.definition}
        multiline
      />

      <FieldSelect
        id="flow-due"
        label={tf.dueDate}
        hint={tf.dueDateHint}
        definition={form.definition}
        types={['date']}
        value={config.dueDateFieldId}
        onChange={(value) => patch({ dueDateFieldId: value })}
        noneLabel={tf.noDueDate}
      />

      <TagListInput id="flow-labels" label={tf.labels} placeholder={ti.tagsPlaceholder} value={config.labels} onChange={(labels) => patch({ labels })} />

      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="flow-attach">{ti.attachFiles}</Label>
        <Switch id="flow-attach" checked={config.attachFiles} onCheckedChange={(v) => patch({ attachFiles: v })} />
      </div>
    </IntegrationCard>
  );
}
