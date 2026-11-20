import { describe, expect, it } from 'vitest';
import { createAiSettingsApi } from '../domains/ai-settings';
import type { ClientApi } from '../types';
import {
  aiSettingsSchema,
  aiUsageSchema,
  runtimeAiConfigSchema,
  setAiKeySchema,
  updateAiSettingsSchema,
} from './ai-settings';

const META = {
  provider: 'mistral',
  model: 'mistral/mistral-medium',
  region: 'eu',
};

const SETTINGS = {
  installProvider: 'mistral',
  defaultProvider: 'mistral',
  providers: [
    {
      id: 'mistral',
      region: 'eu',
      install: true,
      offered: true,
      enabled: true,
      keySource: 'weldsuite',
      keySources: ['weldsuite'],
    },
    {
      id: 'anthropic',
      region: 'outside-eu',
      install: false,
      offered: true,
      enabled: true,
      keySource: 'own',
      keySources: ['weldsuite', 'own'],
      enabledBy: 'user_1',
      enabledAt: '2026-11-13T10:00:00.000Z',
      key: {
        hint: 'sk-…a1b2',
        status: 'ok',
        lastError: null,
        lastCheckedAt: null,
      },
    },
  ],
  features: [
    {
      id: 'mail',
      overridable: true,
      override: { provider: 'anthropic', model: null },
      effective: {
        provider: 'anthropic',
        model: 'anthropic/claude-sonnet-5-5',
        region: 'outside-eu',
      },
      models: [
        {
          id: 'anthropic/claude-sonnet-5-5',
          provider: 'anthropic',
          region: 'outside-eu',
          label: 'Claude Sonnet',
        },
      ],
    },
    {
      id: 'search-index',
      overridable: false,
      override: null,
      effective: META,
      models: [],
    },
  ],
  canManage: true,
};

describe('ai settings contract', () => {
  it('reads the policy, with the key block present for admins and absent for members', () => {
    expect(aiSettingsSchema.safeParse(SETTINGS).success).toBe(true);
    const member = {
      ...SETTINGS,
      canManage: false,
      providers: SETTINGS.providers.map(({ key: _key, ...rest }) => rest),
    };
    expect(aiSettingsSchema.safeParse(member).success).toBe(true);
  });

  it('rejects a provider or region it does not know', () => {
    expect(aiSettingsSchema.safeParse({ ...SETTINGS, defaultProvider: 'gemini' }).success).toBe(false);
  });

  it('validates an update body: providers, default, overrides and the acknowledgement', () => {
    const body = {
      providers: { anthropic: { enabled: true, keySource: 'own' } },
      defaultProvider: null,
      featureOverrides: {
        mail: { provider: 'anthropic', model: 'anthropic/claude-sonnet-5-5' },
        forms: null,
      },
      acknowledgedOutsideEu: true,
    };
    expect(updateAiSettingsSchema.parse(body)).toEqual(body);
    // Only the providers a workspace can switch itself are accepted.
    expect(
      updateAiSettingsSchema.safeParse({
        providers: { mistral: { enabled: false, keySource: 'weldsuite' } },
      }).success,
    ).toBe(true);
    expect(
      updateAiSettingsSchema.safeParse({
        providers: { anthropic: { enabled: true, keySource: 'sky' } },
      }).success,
    ).toBe(false);
  });

  it('wants a key of some length', () => {
    expect(setAiKeySchema.safeParse({ apiKey: '  ' }).success).toBe(false);
    expect(setAiKeySchema.parse({ apiKey: ' sk-ant-1234567 ' }).apiKey).toBe('sk-ant-1234567');
  });

  it('reads usage per month, provider and feature', () => {
    const usage = {
      months: [
        {
          month: '2026-11',
          byProvider: [
            {
              provider: 'anthropic',
              credits: 0,
              inputTokens: 1200,
              outputTokens: 300,
              keySource: 'own',
            },
          ],
          byFeature: [{ feature: 'mail', credits: 12 }],
        },
      ],
    };
    expect(aiUsageSchema.parse(usage)).toEqual(usage);
  });

  it('reads the ai block of /config.json', () => {
    const ai = {
      defaultProvider: 'mistral',
      providers: [{ id: 'mistral', region: 'eu', keySources: ['weldsuite', 'own'] }],
    };
    expect(runtimeAiConfigSchema.parse(ai)).toEqual(ai);
  });
});

describe('ai settings client', () => {
  it('calls the routes of the contract', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const record = (method: string) => async (path: string, data?: unknown) => {
      calls.push([method, path, data]);
      return {};
    };
    const api = {
      get: record('GET'),
      post: record('POST'),
      put: record('PUT'),
      delete: record('DELETE'),
    } as unknown as ClientApi;
    const client = createAiSettingsApi(api);

    await client.get();
    await client.update({ acknowledgedOutsideEu: true });
    await client.setKey('anthropic', { apiKey: 'sk-ant-1234567' });
    await client.testKey('anthropic');
    await client.removeKey('anthropic');
    await client.usage();

    expect(calls.map(([method, path]) => `${method} ${path}`)).toEqual([
      'GET /ai-settings',
      'PUT /ai-settings',
      'PUT /ai-settings/keys/anthropic',
      'POST /ai-settings/keys/anthropic/test',
      'DELETE /ai-settings/keys/anthropic',
      'GET /ai-settings/usage',
    ]);
  });
});
