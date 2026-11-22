import { toast } from 'sonner';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SettingRow, SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { Switch } from '@weldsuite/ui/components/switch';
import { usePermissions } from '@weldsuite/permissions/react';
import {
  CRM_AUTO_ADD_SOURCES,
  type CrmAutoAddSource,
  type UpdateCrmSettingsInput,
} from '@weldsuite/app-api-client/schemas/crm-settings';
import { useCrmSettings, useUpdateCrmSettings } from '@/hooks/queries/use-crm-settings-queries';
import { useI18n } from '@/lib/i18n/provider';

/**
 * The Auto-add tab of Settings → Apps → WeldCRM: whether WeldCRM adds the
 * people the workspace deals with by itself, from which sources, and whether
 * it adds their company too (`/api/crm-settings`, Kubernetes editions only).
 * Each change is saved at once, like the other switches in Settings.
 */
export function AutoAddSettings() {
  const { t } = useI18n();
  const ta = t.crm.settings.autoAdd;
  const { can } = usePermissions();
  const canManage = can('settings:manage');
  const { data, isLoading, isError, refetch } = useCrmSettings();
  const update = useUpdateCrmSettings();

  if (isLoading) return <InlineSpinner />;
  if (isError || !data) return <ErrorState message={ta.loadFailed} onRetry={() => void refetch()} />;

  const settings = data.autoAdd;
  const locked = !canManage || update.isPending;

  const save = (input: UpdateCrmSettingsInput) => {
    update.mutate(input, {
      onSuccess: () => toast.success(ta.saved),
      onError: () => toast.error(ta.saveFailed),
    });
  };
  const saveSource = (source: CrmAutoAddSource, checked: boolean) => save({ autoAdd: { sources: { [source]: checked } } });

  return (
    <SettingsSection title={ta.title} description={ta.description}>
      <SettingRow
        label={ta.enabledLabel}
        description={ta.enabledDescription}
        htmlFor="crm-auto-add-enabled"
        descriptionId="crm-auto-add-enabled-description"
      >
        <Switch
          id="crm-auto-add-enabled"
          checked={settings.enabled}
          onCheckedChange={(enabled) => save({ autoAdd: { enabled } })}
          disabled={locked}
          aria-describedby="crm-auto-add-enabled-description"
        />
      </SettingRow>

      <fieldset className="space-y-3 rounded-md border p-4" disabled={locked || !settings.enabled}>
        <legend className="px-1 text-sm font-medium">{ta.sourcesLegend}</legend>
        {CRM_AUTO_ADD_SOURCES.map((source) => {
          const id = `crm-auto-add-source-${source}`;
          return (
            <div key={source} className="flex items-start gap-3">
              <Checkbox
                id={id}
                checked={settings.sources[source]}
                onCheckedChange={(checked) => saveSource(source, checked === true)}
                disabled={locked || !settings.enabled}
                aria-describedby={`${id}-description`}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <label htmlFor={id} className="text-sm font-medium">
                  {ta.sources[source].label}
                </label>
                <p id={`${id}-description`} className="text-sm text-muted-foreground">
                  {ta.sources[source].description}
                </p>
              </div>
            </div>
          );
        })}
      </fieldset>

      <SettingRow
        label={ta.companiesLabel}
        description={ta.companiesDescription}
        htmlFor="crm-auto-add-companies"
        descriptionId="crm-auto-add-companies-description"
      >
        <Switch
          id="crm-auto-add-companies"
          checked={settings.createCompanies}
          onCheckedChange={(createCompanies) => save({ autoAdd: { createCompanies } })}
          disabled={locked || !settings.enabled}
          aria-describedby="crm-auto-add-companies-description"
        />
      </SettingRow>
    </SettingsSection>
  );
}
