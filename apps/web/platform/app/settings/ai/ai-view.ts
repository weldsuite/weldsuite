/**
 * Pure helpers for Settings > AI: how a feature's override is written as one
 * select value, and which changes the Save button sends.
 */

import type {
  AiFeatureOverride,
  AiFeatureState,
  AiProviderId,
  AiSettings,
  UpdateAiSettingsInput,
} from '@weldsuite/app-api-client/schemas/ai-settings';

/** The select value meaning "use the default" (no override). */
export const DEFAULT_VALUE = '';

/** An override as one select value: `` (default), `p:<provider>` or `m:<model id>`. */
export function overrideToValue(override: AiFeatureOverride | null | undefined): string {
  if (!override) return DEFAULT_VALUE;
  return override.model ? `m:${override.model}` : `p:${override.provider}`;
}

/** The inverse of `overrideToValue`. A model's provider is its id's prefix. */
export function valueToOverride(value: string): AiFeatureOverride | null {
  if (value.startsWith('p:')) return { provider: value.slice(2) as AiProviderId, model: null };
  if (value.startsWith('m:')) {
    const model = value.slice(2);
    return {
      provider: model.slice(0, model.indexOf('/')) as AiProviderId,
      model,
    };
  }
  return null;
}

export interface FeatureChoice {
  value: string;
  kind: 'provider' | 'model';
  provider: AiProviderId;
  /** The model's label; absent for a provider's own default. */
  label?: string;
}

/**
 * What a feature row offers besides "Default": each provider that has a model
 * for the feature (its own default), then the specific models.
 */
export function featureChoices(feature: AiFeatureState): FeatureChoice[] {
  const providers: AiProviderId[] = [];
  for (const model of feature.models) {
    if (!providers.includes(model.provider)) providers.push(model.provider);
  }
  const choices: FeatureChoice[] = [];
  for (const provider of providers) {
    choices.push({ value: `p:${provider}`, kind: 'provider', provider });
    for (const model of feature.models) {
      if (model.provider === provider) {
        choices.push({
          value: `m:${model.id}`,
          kind: 'model',
          provider,
          label: model.label,
        });
      }
    }
  }
  return choices;
}

export interface AiDraft {
  /** The chosen default provider (the install's own when none was chosen). */
  defaultProvider: AiProviderId;
  /** Feature id → select value, only for features the person touched. */
  features: Record<string, string>;
}

/** What differs from the saved settings, as a `PUT /api/ai-settings` body; null when nothing does. */
export function draftToUpdate(settings: AiSettings, draft: AiDraft): UpdateAiSettingsInput | null {
  const update: UpdateAiSettingsInput = {};
  if (draft.defaultProvider !== settings.defaultProvider) {
    update.defaultProvider = draft.defaultProvider === settings.installProvider ? null : draft.defaultProvider;
  }
  const overrides: Record<string, AiFeatureOverride | null> = {};
  for (const feature of settings.features) {
    const chosen = draft.features[feature.id];
    if (chosen === undefined || !feature.overridable) continue;
    if (chosen !== overrideToValue(feature.override)) overrides[feature.id] = valueToOverride(chosen);
  }
  if (Object.keys(overrides).length > 0) update.featureOverrides = overrides;
  return Object.keys(update).length > 0 ? update : null;
}
