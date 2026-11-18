import type { AiFeatureState } from '@weldsuite/app-api-client/schemas/ai-settings';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { SettingRow } from '@weldsuite/ui/components/settings-layout';
import { AiMetaBadge, useAiProviderName } from '@/components/ai/ai-meta-badge';
import { useI18n } from '@/lib/i18n/provider';
import { DEFAULT_VALUE, featureChoices, overrideToValue } from './ai-view';

/**
 * One feature on the Per feature list: Default, a provider, or a specific
 * model. A feature WeldSuite fixes (the search index) reads "Mistral, set by
 * WeldSuite" with nothing to choose.
 */
export function FeatureRow({
  feature,
  value,
  onChange,
}: Readonly<{
  feature: AiFeatureState;
  value: string | undefined;
  onChange: (value: string) => void;
}>) {
  const { t } = useI18n();
  const ta = t.settings.ai;
  const providerName = useAiProviderName();
  const label = (ta.features.names as Record<string, string>)[feature.id] ?? feature.id;
  const current = value ?? overrideToValue(feature.override);

  if (!feature.overridable) {
    return (
      <div data-testid={`ai-feature-${feature.id}`}>
        <SettingRow
          label={label}
          description={ta.features.fixed.replace('{provider}', providerName(feature.effective.provider))}
        >
          <AiMetaBadge ai={feature.effective} hideIcon />
        </SettingRow>
      </div>
    );
  }

  const choices = featureChoices(feature).map((choice) => ({
    value: choice.value,
    label:
      choice.kind === 'provider'
        ? ta.features.provider.replace('{provider}', providerName(choice.provider))
        : `${providerName(choice.provider)} · ${choice.label}`,
  }));

  return (
    <div data-testid={`ai-feature-${feature.id}`}>
      <SettingRow
        label={label}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {ta.features.runsOn.replace('{model}', feature.effective.model)}
            <AiMetaBadge ai={feature.effective} hideIcon />
          </span>
        }
      >
        <FilterSelect
          ariaLabel={label}
          allLabel={ta.features.useDefault}
          value={current === DEFAULT_VALUE ? undefined : current}
          onChange={(next) => onChange(next ?? DEFAULT_VALUE)}
          options={choices}
        />
      </SettingRow>
    </div>
  );
}
