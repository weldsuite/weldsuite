import { describe, expect, it } from 'vitest';
import type { AiFeatureState, AiSettings } from '@weldsuite/app-api-client/schemas/ai-settings';
import { draftToUpdate, featureChoices, overrideToValue, valueToOverride } from './ai-view';

const META = {
  provider: 'mistral',
  model: 'mistral/mistral-medium',
  region: 'eu',
} as const;

const MAIL: AiFeatureState = {
  id: 'mail',
  overridable: true,
  override: null,
  effective: META,
  models: [
    {
      id: 'mistral/mistral-medium',
      provider: 'mistral',
      region: 'eu',
      label: 'Mistral Medium',
    },
    {
      id: 'anthropic/claude-sonnet-5-5',
      provider: 'anthropic',
      region: 'outside-eu',
      label: 'Claude Sonnet',
    },
  ],
};

const SETTINGS: AiSettings = {
  installProvider: 'mistral',
  defaultProvider: 'mistral',
  providers: [],
  features: [MAIL, { ...MAIL, id: 'search-index', overridable: false }],
  canManage: true,
};

describe('override values', () => {
  it('round-trips a provider and a model', () => {
    expect(overrideToValue(null)).toBe('');
    expect(valueToOverride('')).toBeNull();
    expect(valueToOverride(overrideToValue({ provider: 'anthropic', model: null }))).toEqual({
      provider: 'anthropic',
      model: null,
    });
    const model = {
      provider: 'anthropic',
      model: 'anthropic/claude-sonnet-5-5',
    } as const;
    expect(valueToOverride(overrideToValue(model))).toEqual(model);
  });
});

describe('featureChoices', () => {
  it('lists each provider with its models, in order', () => {
    expect(featureChoices(MAIL).map((c) => c.value)).toEqual([
      'p:mistral',
      'm:mistral/mistral-medium',
      'p:anthropic',
      'm:anthropic/claude-sonnet-5-5',
    ]);
  });
});

describe('draftToUpdate', () => {
  it('is null when nothing changed', () => {
    expect(
      draftToUpdate(SETTINGS, {
        defaultProvider: 'mistral',
        features: { mail: '' },
      }),
    ).toBeNull();
  });

  it('sends only what changed, and the install default as null', () => {
    const withClaudeDefault = {
      ...SETTINGS,
      defaultProvider: 'anthropic' as const,
    };
    expect(
      draftToUpdate(withClaudeDefault, {
        defaultProvider: 'mistral',
        features: {},
      }),
    ).toEqual({ defaultProvider: null });
    expect(
      draftToUpdate(SETTINGS, {
        defaultProvider: 'anthropic',
        features: { mail: 'p:anthropic' },
      }),
    ).toEqual({
      defaultProvider: 'anthropic',
      featureOverrides: { mail: { provider: 'anthropic', model: null } },
    });
  });

  it('clears an override with null and ignores fixed features', () => {
    const overridden: AiSettings = {
      ...SETTINGS,
      features: [{ ...MAIL, override: { provider: 'anthropic', model: null } }, SETTINGS.features[1]!],
    };
    expect(
      draftToUpdate(overridden, {
        defaultProvider: 'mistral',
        features: { mail: '', 'search-index': 'p:anthropic' },
      }),
    ).toEqual({
      featureOverrides: { mail: null },
    });
  });
});
