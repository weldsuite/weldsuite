import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Switch } from '@weldsuite/ui/components/switch';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
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

/** Custom-field types that can't be entered in a create form (set them from the record panel). */
const UNSUPPORTED_CUSTOM_FIELD_TYPES = new Set(['file', 'user_ref', 'entity_ref']);

/**
 * One typed input for a custom-field definition. Values land under
 * `customFields.<slug>` in the RHF form: text-like types as strings, number /
 * currency / rating as numbers, boolean as a boolean, multi-select as a string[].
 */
function CustomFieldInput<T extends FieldValues>({
  def,
  form,
}: Readonly<{ def: CustomFieldDefinition; form: UseFormReturn<T> }>) {
  const name = `customFields.${def.slug}` as Path<T>;
  const id = `cf-${def.slug}`;
  const options = def.options ?? [];
  const current = form.watch(name) as unknown;

  switch (def.fieldType) {
    case 'textarea':
      return <Textarea id={id} rows={3} {...form.register(name)} />;
    case 'number':
    case 'currency':
    case 'rating':
      return (
        <Input
          id={id}
          type="number"
          step={def.fieldType === 'currency' ? '0.01' : undefined}
          {...form.register(name, {
            setValueAs: (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? undefined : Number(v)),
          })}
        />
      );
    case 'date':
      return <Input id={id} type="date" {...form.register(name)} />;
    case 'email':
      return <Input id={id} type="email" {...form.register(name)} />;
    case 'phone':
      return <Input id={id} type="tel" {...form.register(name)} />;
    case 'boolean':
      return (
        <div>
          <Switch
            id={id}
            checked={current === true}
            onCheckedChange={(checked) =>
              form.setValue(name, checked as never, { shouldDirty: true })
            }
          />
        </div>
      );
    case 'single_select':
      return (
        <Select
          value={typeof current === 'string' && current ? current : undefined}
          onValueChange={(v) => form.setValue(name, v as never, { shouldDirty: true })}
        >
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case 'multi_select': {
      const selected = Array.isArray(current) ? (current as string[]) : [];
      return (
        <div id={id} className="flex flex-wrap gap-1.5">
          {options.map((opt) => {
            const isSelected = selected.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={isSelected}
                onClick={() =>
                  form.setValue(
                    name,
                    (isSelected ? selected.filter((v) => v !== opt.value) : [...selected, opt.value]) as never,
                    { shouldDirty: true },
                  )
                }
              >
                <Badge variant={isSelected ? 'default' : 'outline'} className="cursor-pointer">
                  {opt.label}
                </Badge>
              </button>
            );
          })}
        </div>
      );
    }
    default:
      return <Input id={id} {...form.register(name)} />;
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
}: Readonly<Props<T>>) {
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
          if (!def || UNSUPPORTED_CUSTOM_FIELD_TYPES.has(def.fieldType)) return null;
          return (
            <div key={slug} className="space-y-2">
              <Label htmlFor={`cf-${cfSlug}`}>
                {def.name}
                {def.required ? ' *' : ''}
              </Label>
              <CustomFieldInput def={def} form={form} />
            </div>
          );
        }

        const spec = getFieldSpec(entityType, slug);
        if (!spec) return null;

        const commonProps = {
          id: slug,
          autoFocus: idx === 0,
          placeholder: spec.placeholder,
          maxLength: spec.maxLength,
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

