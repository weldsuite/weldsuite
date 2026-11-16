import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { SettingRow, SettingsPage, SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { AccessDeniedEmptyState } from '@/components/access-denied-empty-state';
import { useAiProviderName } from '@/components/ai/ai-meta-badge';
import { useAiSettings, useUpdateAiSettings } from '@/hooks/queries/use-ai-settings-queries';
import { errorMessage } from '@/app/agents/components/chat/labels';
import { hasAiSettings } from '@/lib/edition';
import { useI18n } from '@/lib/i18n/provider';
import { FeatureRow } from './feature-row';
import { ProviderCard } from './provider-card';
import { UsageSection } from './usage-section';
import { draftToUpdate, type AiDraft } from './ai-view';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';

/**
 * Settings > AI (Kubernetes editions with an AI provider, `/config.json` `ai`):
 * which providers the workspace allows, the default one, a provider or model
 * per feature, and what was used. Opening it takes `ai:manage`; switching a
 * provider on or off and saving a key apply at once, the default and the
 * per-feature choices are saved together with Save.
 */
export default function AiSettingsPage() {
  const { t } = useI18n();
  const ta = t.settings.ai;
  const { can, isLoading: permissionsLoading } = usePermissions();
  const canManage = can('ai:manage');
  const available = hasAiSettings();
  const { data: settings, isLoading, isError, refetch } = useAiSettings(canManage);

  if (permissionsLoading || (available && canManage && isLoading)) {
    return <PageLoader fullScreen={false} />;
  }

  if (!available || !canManage) {
    return (
      <AccessDeniedEmptyState
        description={ta.accessDeniedDescription}
        permission="ai:manage"
        pageLabel={ta.pageLabel}
      />
    );
  }

  if (isError || !settings) {
    return <ErrorState message={ta.loadFailed} onRetry={() => void refetch()} retryLabel={ta.retry} />;
  }

  return <AiSettingsForm settings={settings} />;
}

function AiSettingsForm({
  settings,
}: Readonly<{
  settings: NonNullable<ReturnType<typeof useAiSettings>['data']>;
}>) {
  const { t } = useI18n();
  const ta = t.settings.ai;
  const providerName = useAiProviderName();
  const update = useUpdateAiSettings();
  const [draft, setDraft] = useState<AiDraft>({
    defaultProvider: settings.defaultProvider,
    features: {},
  });

  // A saved policy that changed underneath (another tab, a provider switched off) resets the default.
  const enabledProviders = settings.providers.filter((p) => p.enabled);
  const defaultProvider = enabledProviders.some((p) => p.id === draft.defaultProvider)
    ? draft.defaultProvider
    : settings.defaultProvider;
  const pending = useMemo(
    () => draftToUpdate(settings, { ...draft, defaultProvider }),
    [settings, draft, defaultProvider],
  );

  const save = () => {
    if (!pending) return;
    update.mutate(pending, {
      onSuccess: (res) => {
        setDraft({ defaultProvider: res.data.defaultProvider, features: {} });
        toast.success(ta.messages.saved);
      },
      onError: (err) => toast.error(errorMessage(err, ta.messages.saveFailed)),
    });
  };

  return (
    <SettingsPage
      title={ta.title}
      description={ta.description}
      hasChanges={pending !== null}
      saving={update.isPending}
      onSave={save}
      onCancel={() => setDraft({ defaultProvider: settings.defaultProvider, features: {} })}
    >
      <SettingsSection title={ta.providers.title} description={ta.providers.description}>
        <div className="space-y-3">
          {settings.providers.map((provider) => (
            <ProviderCard key={provider.id} provider={provider} canManage={settings.canManage} />
          ))}
        </div>
        <InfoBanner variant="neutral">{ta.providers.disabledNote}</InfoBanner>
      </SettingsSection>

      <SettingsSection title={ta.default.title} description={ta.default.description}>
        <SettingRow label={ta.default.label}>
          <FilterSelect
            ariaLabel={ta.default.label}
            allLabel={providerName(settings.installProvider)}
            value={defaultProvider === settings.installProvider ? undefined : defaultProvider}
            onChange={(value) =>
              setDraft((d) => ({
                ...d,
                defaultProvider: (value ?? settings.installProvider) as typeof d.defaultProvider,
              }))
            }
            options={enabledProviders
              .filter((p) => p.id !== settings.installProvider)
              .map((p) => ({ value: p.id, label: providerName(p.id) }))}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={ta.features.title} description={ta.features.description}>
        <div className="space-y-4">
          {settings.features.map((feature) => (
            <FeatureRow
              key={feature.id}
              feature={feature}
              value={draft.features[feature.id]}
              onChange={(value) =>
                setDraft((d) => ({
                  ...d,
                  features: { ...d.features, [feature.id]: value },
                }))
              }
            />
          ))}
        </div>
      </SettingsSection>

      <UsageSection />
    </SettingsPage>
  );
}
