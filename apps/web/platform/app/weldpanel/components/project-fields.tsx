/**
 * The fields of a project that the create dialog and the General tab share:
 * name, type and allowed domains. The parent owns the form (`useForm` with
 * `buildProjectFormSchema`) and the submit button.
 */

import type { UseFormReturn } from 'react-hook-form';
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { PANEL_PROJECT_KINDS } from '@weldsuite/app-api-client/schemas/weldpanel';
import { useI18n } from '@/lib/i18n/provider';
import { MAX_DOMAINS, parseDomain, type ProjectFormValues } from '../lib/validation';
import { OptionRadioGroup } from './option-radio-group';
import { StringListEditor } from './string-list-editor';

interface ProjectFieldsProps {
  form: UseFormReturn<ProjectFormValues>;
  namePlaceholder?: string;
  domainsHint: string;
  /** Marks the domains as optional (the create dialog; on General an empty list is just as valid). */
  domainsOptional?: boolean;
  disabled?: boolean;
}

export function ProjectFields({ form, namePlaceholder, domainsHint, domainsOptional = false, disabled = false }: Readonly<ProjectFieldsProps>) {
  const { t } = useI18n();
  const tw = t.weldpanel;

  const kindOptions = PANEL_PROJECT_KINDS.map((kind) => ({
    value: kind,
    label: tw.kinds[kind],
    description: tw.kindHints[kind],
  }));

  return (
    <div className="space-y-5">
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{tw.general.nameLabel}</FormLabel>
            <FormControl>
              <Input {...field} placeholder={namePlaceholder} disabled={disabled} autoComplete="off" maxLength={255} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="kind"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{tw.general.kindLabel}</FormLabel>
            <OptionRadioGroup value={field.value} onChange={field.onChange} options={kindOptions} ariaLabel={tw.general.kindLabel} disabled={disabled} />
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="allowedDomains"
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              {tw.general.domainsLabel}
              {domainsOptional && <span className="font-normal text-muted-foreground"> ({tw.createDialog.domainsOptional})</span>}
            </FormLabel>
            <StringListEditor
              value={field.value}
              onChange={field.onChange}
              parse={parseDomain}
              separator={/[\s,]+/}
              max={MAX_DOMAINS}
              placeholder="example.com"
              invalidMessage={tw.validation.domainInvalid}
              duplicateMessage={tw.validation.domainDuplicate}
              disabled={disabled}
            />
            <FormDescription>{domainsHint}</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
