/**
 * Privacy & collection tab: autocapture, consent mode, masking level and the
 * pages that are never tracked (`panel_projects:manage`). Without that
 * permission the values are shown, with no controls.
 */

import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  PANEL_CONSENT_MODES,
  PANEL_MASKING_LEVELS,
  type PanelProjectDto,
} from '@weldsuite/app-api-client/schemas/weldpanel';
import { useUpdateWeldPanelProjectSettings } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { OptionRadioGroup } from '../components/option-radio-group';
import { ReadOnlyChips, ReadOnlyField } from '../components/read-only-field';
import { StringListEditor } from '../components/string-list-editor';
import { privacyFormValues, settingsChanges } from '../lib/changes';
import { buildPrivacyFormSchema, MAX_EXCLUDED_URLS, parseUrlPattern, type PrivacyFormValues } from '../lib/validation';

interface PrivacyTabProps {
  project: PanelProjectDto;
  canManage: boolean;
}

export function PrivacyTab({ project, canManage }: Readonly<PrivacyTabProps>) {
  const { t } = useI18n();
  const tp = t.weldpanel.privacy;
  const { settings } = project;

  return (
    <section className="space-y-5 rounded-lg border bg-card p-4 sm:p-5">
      <div className="space-y-1">
        <h2 className="text-base font-medium">{tp.title}</h2>
        <p className="text-sm text-muted-foreground">{tp.description}</p>
      </div>
      {canManage ? (
        // Keyed by the server's version, so a save (or a colleague's change) starts the form from what is stored.
        <PrivacyForm key={project.updatedAt} project={project} />
      ) : (
        <>
          <dl className="space-y-4">
            <ReadOnlyField label={tp.autocaptureLabel}>{settings.autocapture ? tp.on : tp.off}</ReadOnlyField>
            <ReadOnlyField label={tp.consentLabel}>{tp.consent[settings.consentMode].label}</ReadOnlyField>
            <ReadOnlyField label={tp.maskingLabel}>{tp.masking[settings.maskingLevel].label}</ReadOnlyField>
            <ReadOnlyField label={tp.excludedLabel}>
              <ReadOnlyChips values={settings.excludedUrls} empty={tp.excludedNone} />
            </ReadOnlyField>
          </dl>
          <p className="text-sm text-muted-foreground">{tp.readOnlyNote}</p>
        </>
      )}
    </section>
  );
}

function PrivacyForm({ project }: Readonly<{ project: PanelProjectDto }>) {
  const { t } = useI18n();
  const tp = t.weldpanel.privacy;
  const update = useUpdateWeldPanelProjectSettings(project.id);
  const schema = useMemo(() => buildPrivacyFormSchema(t.weldpanel.validation), [t.weldpanel.validation]);
  const form = useForm<PrivacyFormValues>({ resolver: zodResolver(schema), defaultValues: privacyFormValues(project.settings) });

  const consentOptions = PANEL_CONSENT_MODES.map((mode) => ({ value: mode, ...tp.consent[mode] }));
  const maskingOptions = PANEL_MASKING_LEVELS.map((level) => ({ value: level, ...tp.masking[level] }));

  const submit = form.handleSubmit(async (values) => {
    const changes = settingsChanges(values, project.settings);
    if (!changes.settings) return;
    try {
      await update.mutateAsync(changes);
      // The saved values are the new baseline (the remount on a new `updatedAt` does the same).
      form.reset(values);
      toast.success(tp.saved);
    } catch {
      toast.error(tp.saveFailed);
    }
  });

  const saving = update.isPending;

  return (
    <Form {...form}>
      <form onSubmit={submit} noValidate className="space-y-6">
        <FormField
          control={form.control}
          name="autocapture"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start justify-between gap-4 rounded-lg border p-3">
              <div className="space-y-1">
                <FormLabel>{tp.autocaptureLabel}</FormLabel>
                <FormDescription>{tp.autocaptureDescription}</FormDescription>
              </div>
              <FormControl>
                <Switch checked={field.value} onCheckedChange={field.onChange} disabled={saving} />
              </FormControl>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="consentMode"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tp.consentLabel}</FormLabel>
              <OptionRadioGroup value={field.value} onChange={field.onChange} options={consentOptions} ariaLabel={tp.consentLabel} disabled={saving} />
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="maskingLevel"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tp.maskingLabel}</FormLabel>
              <FormDescription>{tp.maskingDescription}</FormDescription>
              <OptionRadioGroup value={field.value} onChange={field.onChange} options={maskingOptions} ariaLabel={tp.maskingLabel} disabled={saving} />
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="excludedUrls"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tp.excludedLabel}</FormLabel>
              <StringListEditor
                value={field.value}
                onChange={field.onChange}
                parse={parseUrlPattern}
                separator={/\s+/}
                max={MAX_EXCLUDED_URLS}
                placeholder={tp.excludedPlaceholder}
                invalidMessage={t.weldpanel.validation.patternInvalid}
                duplicateMessage={t.weldpanel.validation.patternDuplicate}
                disabled={saving}
              />
              <FormDescription>{tp.excludedDescription}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" disabled={saving || !form.formState.isDirty}>
          {saving && <Loader2 className="animate-spin" />}
          {saving ? tp.saving : tp.save}
        </Button>
      </form>
    </Form>
  );
}
