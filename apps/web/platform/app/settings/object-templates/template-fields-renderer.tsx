import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { Plus } from 'lucide-react';
import type { CustomFieldDefinition } from '@/hooks/queries/use-settings-queries';
import { getFieldSpec } from './registry';
import type { TemplateInputType } from './types';
import type { TemplatePickerTemplate } from './use-template-picker';

interface Props<T extends FieldValues> {
  entityType: string;
  /** Slugs to render in order. From `useTemplatePicker`. */
  visibleSlugs: string[];
  /** Custom-field definitions keyed by raw slug (no `cf:` prefix). */
  customFieldBySlug: Record<string, CustomFieldDefinition>;
  /** RHF form — fields are registered directly against their slugs. */
  form: UseFormReturn<T>;
  templateId: string;
  setTemplateId: (id: string) => void;
  templates: TemplatePickerTemplate[];
  /** Label for the default (no-template) tab. Defaults to "Default". */
  defaultTabLabel?: string;
}

function htmlInputType(t: TemplateInputType): string {
  switch (t) {
    case 'email':
      return 'email';
    case 'number':
      return 'number';
    case 'url':
    case 'phone':
    case 'text':
    case 'textarea':
    default:
      return 'text';
  }
}

/**
 * Renders the template-aware portion of a quick-add dialog:
 *   1. An Attio-style horizontal tab strip at the top — "Default" tab plus
 *      one tab per template (only rendered when ≥1 template exists).
 *   2. The dynamic field list — built-in fields driven by the registry,
 *      custom fields driven by `customFieldBySlug`.
 *
 * The host dialog supplies the RHF form and is responsible for the surround
 * (DialogHeader, footer, submit handler, etc.).
 */
export function TemplateFieldsRenderer<T extends FieldValues>({
  entityType,
  visibleSlugs,
  customFieldBySlug,
  form,
  templateId,
  setTemplateId,
  templates,
  defaultTabLabel = 'Default',
}: Props<T>) {
  const activeTab = templateId || 'none';

  const tabs: PageTab[] = [
    { id: 'none', label: defaultTabLabel },
    ...templates.map((tpl) => ({ id: tpl.id, label: tpl.name })),
  ];

  // With no templates yet, offer a shortcut tab into settings to create one.
  if (templates.length === 0) {
    tabs.push({
      id: '__add_template',
      label: 'Add template',
      icon: Plus,
      href: `/settings/object-templates?type=${entityType}`,
    });
  }

  return (
    <>
      <PageTabs
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={(id) => setTemplateId(id === 'none' ? '' : id)}
        className="mb-5"
      />

      {visibleSlugs.map((slug, idx) => {
        if (slug.startsWith('cf:')) {
          const cfSlug = slug.slice(3);
          const def = customFieldBySlug[cfSlug];
          if (!def) return null;
          return (
            <div key={slug} className="space-y-2">
              <Label htmlFor={`cf-${cfSlug}`}>
                {def.name}
                {def.required ? ' *' : ''}
              </Label>
              <Input
                id={`cf-${cfSlug}`}
                {...form.register(`customFields.${cfSlug}` as Path<T>)}
              />
            </div>
          );
        }

        const spec = getFieldSpec(entityType, slug);
        if (!spec) return null;

        const commonProps = {
          id: slug,
          autoFocus: idx === 0,
          placeholder: spec.placeholder,
          ...form.register(slug as Path<T>),
        };

        return (
          <div key={slug} className="space-y-2">
            <Label htmlFor={slug}>
              {spec.label}
              {spec.required ? ' *' : ''}
            </Label>
            {spec.inputType === 'textarea' ? (
              <Textarea rows={3} {...commonProps} />
            ) : (
              <Input type={htmlInputType(spec.inputType)} {...commonProps} />
            )}
          </div>
        );
      })}
    </>
  );
}

