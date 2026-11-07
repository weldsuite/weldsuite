// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { en as enLocale } from '@weldsuite/i18n/locales/en';
import { nl as nlLocale } from '@weldsuite/i18n/locales/nl';

vi.mock('@/hooks/queries/use-weldmerge-queries', () => ({}));
vi.mock('@/hooks/queries/use-weldmerge-sync-queries', () => ({}));

const { installErrorMessage } = await import('./providers-section');
const en = enLocale.weldmerge.sync;
const nl = nlLocale.weldmerge.sync;

describe('installErrorMessage', () => {
  it('names each refusal the GitHub setup route sends back', () => {
    const m = en.providers.installErrors;
    expect(installErrorMessage('state_expired', m)).toBe(m.stateExpired);
    expect(installErrorMessage('installation_unverified', m)).toBe(m.installationUnverified);
    expect(installErrorMessage('installation_taken', m)).toBe(m.installationTaken);
  });

  it('falls back to a generic message for any other code', () => {
    expect(installErrorMessage('configuration_error', nl.providers.installErrors)).toBe(nl.providers.installErrors.generic);
  });
});
