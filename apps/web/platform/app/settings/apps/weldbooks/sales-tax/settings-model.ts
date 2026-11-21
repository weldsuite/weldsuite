/**
 * The engine settings form without the React: the values, the checks and the
 * payload.
 *
 * Credentials are write-only. The server never returns them, only whether some
 * are stored, so the secret fields always start empty and are cleared again
 * after a save. A payload carries credentials only when the user typed new
 * ones; leaving them blank keeps the stored ones.
 */
import type {
  AvalaraEnvironment,
  SalesTaxEngineId,
  SalesTaxSettings,
  UpdateSettingsInput,
} from '@/lib/api/domains/weldbooks-sales-tax-setup';

export interface EngineFormValues {
  engine: SalesTaxEngineId;
  /** Stripe Tax. */
  apiKey: string;
  /** Avalara. */
  accountId: string;
  licenseKey: string;
  companyCode: string;
  environment: AvalaraEnvironment;
}

/** The form for the saved settings. The secret fields are always empty. */
export function settingsToForm(settings: Pick<SalesTaxSettings, 'engine' | 'config'>): EngineFormValues {
  return {
    engine: settings.engine,
    apiKey: '',
    accountId: '',
    licenseKey: '',
    companyCode: settings.config.companyCode ?? '',
    environment: settings.config.environment ?? 'production',
  };
}

/** The same form with the secrets wiped (after a save, or when the engine choice changes). */
export function withoutSecrets(values: EngineFormValues): EngineFormValues {
  return { ...values, apiKey: '', accountId: '', licenseKey: '' };
}

/**
 * Whether the saved settings hold credentials for the engine chosen in the
 * form. They belong to the engine they were saved for: choosing another one
 * means entering its credentials.
 */
export function hasStoredCredentialsFor(
  settings: Pick<SalesTaxSettings, 'engine' | 'hasCredentials'>,
  engine: SalesTaxEngineId,
): boolean {
  return engine !== 'manual' && settings.hasCredentials && settings.engine === engine;
}

export type EngineProblem = 'apiKey' | 'accountId' | 'licenseKey' | 'bothCredentials' | 'companyCode';

export interface EnginePayload {
  input: UpdateSettingsInput | null;
  problems: EngineProblem[];
}

/**
 * The PUT body for the form, or the fields that are missing.
 *
 * - Manual: just the engine.
 * - Stripe Tax: the API key when typed; required when none is stored.
 * - Avalara: company code and environment; the account ID and license key
 *   together when either is typed, required when none are stored.
 */
export function buildEnginePayload(values: EngineFormValues, storedForEngine: boolean): EnginePayload {
  if (values.engine === 'manual') return { input: { engine: 'manual' }, problems: [] };

  const problems: EngineProblem[] = [];

  if (values.engine === 'stripe_tax') {
    const apiKey = values.apiKey.trim();
    if (!apiKey && !storedForEngine) problems.push('apiKey');
    if (problems.length > 0) return { input: null, problems };
    return { input: { engine: 'stripe_tax', ...(apiKey ? { credentials: { apiKey } } : {}) }, problems: [] };
  }

  const accountId = values.accountId.trim();
  const licenseKey = values.licenseKey.trim();
  const companyCode = values.companyCode.trim();
  if (!companyCode) problems.push('companyCode');
  const typedAny = accountId !== '' || licenseKey !== '';
  if (typedAny && (!accountId || !licenseKey)) {
    problems.push('bothCredentials');
  } else if (!typedAny && !storedForEngine) {
    problems.push('accountId', 'licenseKey');
  }
  if (problems.length > 0) return { input: null, problems };

  return {
    input: {
      engine: 'avalara',
      config: { companyCode, environment: values.environment },
      ...(typedAny ? { credentials: { accountId, licenseKey } } : {}),
    },
    problems: [],
  };
}

/** The body that removes the stored credentials: it has to switch back to manual in the same call. */
export function removeCredentialsPayload(): UpdateSettingsInput {
  return { engine: 'manual', credentials: null };
}

/** True when the form differs from what is saved (the save button wakes up). */
export function isDirty(values: EngineFormValues, settings: Pick<SalesTaxSettings, 'engine' | 'config'>): boolean {
  const saved = settingsToForm(settings);
  return (
    values.engine !== saved.engine ||
    values.apiKey !== '' ||
    values.accountId !== '' ||
    values.licenseKey !== '' ||
    (values.engine === 'avalara' && (values.companyCode.trim() !== saved.companyCode || values.environment !== saved.environment))
  );
}
