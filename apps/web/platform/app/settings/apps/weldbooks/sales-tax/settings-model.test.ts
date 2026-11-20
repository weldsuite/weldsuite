import { describe, expect, it } from 'vitest';
import type { SalesTaxSettings } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import {
  buildEnginePayload,
  hasStoredCredentialsFor,
  isDirty,
  removeCredentialsPayload,
  settingsToForm,
  withoutSecrets,
  type EngineFormValues,
} from './settings-model';

function settings(overrides: Partial<SalesTaxSettings> = {}): SalesTaxSettings {
  return {
    entityId: 'ent_1',
    engine: 'manual',
    config: { companyCode: null, environment: 'production' },
    hasCredentials: false,
    engineOptions: [],
    agencies: [],
    registeredStates: [],
    ...overrides,
  };
}

function form(overrides: Partial<EngineFormValues> = {}): EngineFormValues {
  return { ...settingsToForm(settings()), ...overrides };
}

describe('settingsToForm', () => {
  it('never carries a secret, even when credentials are stored', () => {
    const values = settingsToForm(settings({ engine: 'avalara', hasCredentials: true, config: { companyCode: 'WELD', environment: 'sandbox' } }));
    expect(values).toEqual({
      engine: 'avalara',
      apiKey: '',
      accountId: '',
      licenseKey: '',
      companyCode: 'WELD',
      environment: 'sandbox',
    });
  });

  it('wipes secrets that were typed', () => {
    expect(withoutSecrets(form({ engine: 'avalara', apiKey: 'sk', accountId: 'a', licenseKey: 'b', companyCode: 'W' }))).toMatchObject({
      apiKey: '',
      accountId: '',
      licenseKey: '',
      companyCode: 'W',
      engine: 'avalara',
    });
  });
});

describe('stored credentials', () => {
  it('belong to the engine they were saved for', () => {
    const saved = settings({ engine: 'stripe_tax', hasCredentials: true });
    expect(hasStoredCredentialsFor(saved, 'stripe_tax')).toBe(true);
    expect(hasStoredCredentialsFor(saved, 'avalara')).toBe(false);
    expect(hasStoredCredentialsFor(saved, 'manual')).toBe(false);
    expect(hasStoredCredentialsFor(settings({ engine: 'stripe_tax', hasCredentials: false }), 'stripe_tax')).toBe(false);
  });
});

describe('buildEnginePayload', () => {
  it('sends just the engine for manual', () => {
    expect(buildEnginePayload(form({ engine: 'manual', apiKey: 'left over' }), false)).toEqual({ input: { engine: 'manual' }, problems: [] });
  });

  it('needs the API key for Stripe Tax when none is stored', () => {
    expect(buildEnginePayload(form({ engine: 'stripe_tax' }), false)).toEqual({ input: null, problems: ['apiKey'] });
    expect(buildEnginePayload(form({ engine: 'stripe_tax', apiKey: '   ' }), false).problems).toEqual(['apiKey']);
  });

  it('sends a typed Stripe key, trimmed', () => {
    expect(buildEnginePayload(form({ engine: 'stripe_tax', apiKey: ' rk_live_123456 ' }), false)).toEqual({
      input: { engine: 'stripe_tax', credentials: { apiKey: 'rk_live_123456' } },
      problems: [],
    });
  });

  it('keeps the stored Stripe key when none is typed: no credentials in the payload', () => {
    const result = buildEnginePayload(form({ engine: 'stripe_tax' }), true);
    expect(result).toEqual({ input: { engine: 'stripe_tax' }, problems: [] });
    expect(result.input).not.toHaveProperty('credentials');
  });

  it('needs the company code and both credentials for Avalara when none are stored', () => {
    expect(buildEnginePayload(form({ engine: 'avalara' }), false)).toEqual({
      input: null,
      problems: ['companyCode', 'accountId', 'licenseKey'],
    });
  });

  it('refuses half of the Avalara credentials', () => {
    expect(buildEnginePayload(form({ engine: 'avalara', companyCode: 'W', accountId: '123' }), true).problems).toEqual(['bothCredentials']);
    expect(buildEnginePayload(form({ engine: 'avalara', companyCode: 'W', licenseKey: 'k' }), false).problems).toEqual(['bothCredentials']);
  });

  it('sends the Avalara config and new credentials together', () => {
    expect(
      buildEnginePayload(
        form({ engine: 'avalara', companyCode: ' WELD ', environment: 'sandbox', accountId: ' 1100012345 ', licenseKey: ' abc ' }),
        false,
      ),
    ).toEqual({
      input: {
        engine: 'avalara',
        config: { companyCode: 'WELD', environment: 'sandbox' },
        credentials: { accountId: '1100012345', licenseKey: 'abc' },
      },
      problems: [],
    });
  });

  it('keeps stored Avalara credentials when only the config changes', () => {
    const result = buildEnginePayload(form({ engine: 'avalara', companyCode: 'WELD2', environment: 'production' }), true);
    expect(result.input).toEqual({ engine: 'avalara', config: { companyCode: 'WELD2', environment: 'production' } });
    expect(result.input).not.toHaveProperty('credentials');
  });
});

describe('removing credentials', () => {
  it('switches back to manual in the same call, since a provider engine cannot run without them', () => {
    expect(removeCredentialsPayload()).toEqual({ engine: 'manual', credentials: null });
  });
});

describe('isDirty', () => {
  const saved = settings({ engine: 'avalara', hasCredentials: true, config: { companyCode: 'WELD', environment: 'production' } });

  it('is false for the form as saved', () => {
    expect(isDirty(settingsToForm(saved), saved)).toBe(false);
  });

  it('is true for a changed engine, config or typed secret', () => {
    expect(isDirty({ ...settingsToForm(saved), engine: 'manual' }, saved)).toBe(true);
    expect(isDirty({ ...settingsToForm(saved), companyCode: 'OTHER' }, saved)).toBe(true);
    expect(isDirty({ ...settingsToForm(saved), environment: 'sandbox' }, saved)).toBe(true);
    expect(isDirty({ ...settingsToForm(saved), licenseKey: 'new' }, saved)).toBe(true);
  });
});
