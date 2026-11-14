/**
 * WeldCRM integration: create or update a person (or create a lead) from the
 * answers, optionally with the company, mapped fields, a list, tags and a
 * logged activity.
 */

import { useMemo, useState } from 'react';
import { Contact, Plus, X } from 'lucide-react';
import { partsOf, type FieldBlock } from '@weldsuite/forms-engine';
import {
  crmIntegrationConfigSchema,
  type CrmIntegrationConfig,
  type FormDetail,
  type FormIntegration,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { useI18n } from '@/lib/i18n/provider';
import { useCustomFields } from '@/hooks/use-custom-fields';
import { useLists } from '@/hooks/queries/use-lists-queries';
import { FieldSelect, fieldsOfTypes } from './field-select';
import { IntegrationCard } from './integration-card';
import { TagListInput } from './tag-list-input';
import { useIntegration } from './use-integration';

/** Standard person fields a response can fill (slugs of `createPersonSchema`). */
export const STANDARD_CRM_FIELDS = ['firstName', 'lastName', 'email', 'directPhone', 'mobilePhone', 'title', 'department'] as const;

const EMAIL_TYPES = ['email', 'contact_info'] as const;
const COMPANY_TYPES = ['short_text', 'contact_info'] as const;
const NO_LIST = '__none__';

type Mapping = CrmIntegrationConfig['mappings'][number];

function parseConfig(integration: FormIntegration | null): CrmIntegrationConfig {
  const parsed = crmIntegrationConfigSchema.safeParse(integration?.config ?? { emailFieldId: '' });
  return parsed.success ? parsed.data : crmIntegrationConfigSchema.parse({ emailFieldId: '' });
}

export function CrmCard({ form, integration }: Readonly<{ form: FormDetail; integration: FormIntegration | null }>) {
  const { t } = useI18n();
  const ti = t.weldformsResults.integrations;
  const tc = ti.crm;
  const [config, setConfig] = useState<CrmIntegrationConfig>(() => parseConfig(integration));
  const [enabled, setEnabled] = useState(integration?.enabled ?? true);
  const actions = useIntegration(form.id, integration);
  const customFields = useCustomFields(config.target === 'lead' ? 'lead' : 'person');
  const lists = useLists('person');
  const patch = (next: Partial<CrmIntegrationConfig>) => setConfig((current) => ({ ...current, ...next }));

  const allFields = useMemo(() => fieldsOfTypes(form.definition), [form.definition]);

  const updateMapping = (index: number, next: Partial<Mapping>) =>
    patch({ mappings: config.mappings.map((m, i) => (i === index ? { ...m, ...next } : m)) });

  function addMapping() {
    const first = allFields[0];
    if (!first) return;
    patch({ mappings: [...config.mappings, { blockId: first.id, crmField: '', mode: 'fill_empty' }] });
  }

  const partOptions = (field: FieldBlock | undefined): string[] =>
    field && (field.type === 'contact_info' || field.type === 'address')
      ? partsOf(field).filter((p) => p.enabled).map((p) => p.part)
      : [];

  return (
    <IntegrationCard
      icon={Contact}
      title={tc.title}
      description={tc.description}
      removeAction={tc.actionPerson}
      integration={integration}
      enabled={enabled}
      onEnabledChange={setEnabled}
      canSave={config.emailFieldId !== ''}
      saving={actions.saving}
      onSave={() => void actions.save('crm', enabled, config)}
      testing={actions.testing}
      onTest={() => void actions.runTest()}
      removing={actions.removing}
      onRemove={() => void actions.remove()}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="crm-target">{tc.target}</Label>
          <Select value={config.target} onValueChange={(value) => patch({ target: value as CrmIntegrationConfig['target'] })}>
            <SelectTrigger id="crm-target">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="person">{tc.targets.person}</SelectItem>
              <SelectItem value="lead">{tc.targets.lead}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <FieldSelect
          id="crm-email"
          label={tc.emailField}
          hint={tc.emailFieldHint}
          definition={form.definition}
          types={EMAIL_TYPES}
          value={config.emailFieldId || undefined}
          onChange={(value) => patch({ emailFieldId: value ?? '' })}
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="crm-company">{tc.createCompany}</Label>
          <Switch id="crm-company" checked={config.createCompany} onCheckedChange={(v) => patch({ createCompany: v })} />
        </div>
        {config.createCompany && (
          <FieldSelect
            id="crm-company-field"
            label={tc.companyField}
            hint={tc.companyFieldHint}
            definition={form.definition}
            types={COMPANY_TYPES}
            value={config.companyFieldId}
            onChange={(value) => patch({ companyFieldId: value })}
            noneLabel={tc.companyFromDomain}
          />
        )}
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium">{tc.mappings}</p>
          <p className="text-xs text-muted-foreground">{tc.mappingsHint}</p>
        </div>
        {config.mappings.map((mapping, index) => {
          const field = allFields.find((f) => f.id === mapping.blockId);
          const parts = partOptions(field);
          return (
            <div key={index} className="grid gap-2 rounded-md border p-2.5 sm:grid-cols-[1fr_auto_1fr_auto]">
              <div className="flex min-w-0 gap-2">
                <Select
                  value={mapping.blockId}
                  onValueChange={(blockId) => updateMapping(index, { blockId, part: undefined })}
                >
                  <SelectTrigger size="sm" aria-label={tc.question} className="min-w-0 flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {allFields.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {parts.length > 0 && (
                  <Select value={mapping.part ?? parts[0]} onValueChange={(part) => updateMapping(index, { part })}>
                    <SelectTrigger size="sm" aria-label={tc.part} className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {parts.map((part) => (
                        <SelectItem key={part} value={part}>
                          {(tc.parts as Record<string, string>)[part] ?? part}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <span className="hidden self-center text-muted-foreground sm:block" aria-hidden>
                →
              </span>
              <div className="flex min-w-0 gap-2">
                <Select value={mapping.crmField || undefined} onValueChange={(crmField) => updateMapping(index, { crmField })}>
                  <SelectTrigger size="sm" aria-label={tc.crmField} className="min-w-0 flex-1">
                    <SelectValue placeholder={tc.chooseCrmField} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>{tc.standardFields}</SelectLabel>
                      {STANDARD_CRM_FIELDS.map((key) => (
                        <SelectItem key={key} value={key}>
                          {tc.fields[key]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                    {(customFields.data ?? []).length > 0 && (
                      <SelectGroup>
                        <SelectLabel>{tc.customFields}</SelectLabel>
                        {(customFields.data ?? []).map((cf) => (
                          <SelectItem key={cf.id} value={`custom:${cf.id}`}>
                            {cf.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
                <Select value={mapping.mode} onValueChange={(mode) => updateMapping(index, { mode: mode as Mapping['mode'] })}>
                  <SelectTrigger size="sm" aria-label={tc.mode} className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fill_empty">{tc.modes.fill_empty}</SelectItem>
                    <SelectItem value="overwrite">{tc.modes.overwrite}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={tc.removeMapping}
                onClick={() => patch({ mappings: config.mappings.filter((_, i) => i !== index) })}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          );
        })}
        <Button type="button" variant="outline" size="sm" disabled={allFields.length === 0} onClick={addMapping}>
          <Plus className="mr-1.5 h-4 w-4" />
          {tc.addMapping}
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="crm-list">{tc.list}</Label>
          <Select value={config.listId ?? NO_LIST} onValueChange={(value) => patch({ listId: value === NO_LIST ? undefined : value })}>
            <SelectTrigger id="crm-list">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_LIST}>{tc.noList}</SelectItem>
              {(lists.data?.data ?? []).map((list) => (
                <SelectItem key={list.id} value={list.id}>
                  {list.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <TagListInput id="crm-tags" label={ti.tags} placeholder={ti.tagsPlaceholder} value={config.tags} onChange={(tags) => patch({ tags })} />
      </div>

      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="crm-activity">{tc.logActivity}</Label>
        <Switch id="crm-activity" checked={config.logActivity} onCheckedChange={(v) => patch({ logActivity: v })} />
      </div>
    </IntegrationCard>
  );
}
