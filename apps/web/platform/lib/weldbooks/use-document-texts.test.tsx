import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { isLocaleLoaded } from '@weldsuite/i18n/locales';
import { useDocumentTexts } from './use-document-texts';

// Loading a locale bundle is a dynamic import; give it room when the suite runs in parallel.
const LOAD = { timeout: 10_000 };

function wrapperFor(language: 'en' | 'nl' | 'es') {
  return function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
    return <I18nProvider initialLanguage={language}>{children}</I18nProvider>;
  };
}

describe('useDocumentTexts', () => {
  it('gives the English texts', () => {
    const { result } = renderHook(() => useDocumentTexts(), { wrapper: wrapperFor('en') });
    expect(result.current.taxCodes.saas).toBe('Software as a service');
  });

  it('gives the Dutch texts', { timeout: 30_000 }, async () => {
    const { result } = renderHook(() => useDocumentTexts(), { wrapper: wrapperFor('nl') });
    await waitFor(() => expect(isLocaleLoaded('nl')).toBe(true), LOAD);
    await waitFor(() => expect(result.current.taxCodes.saas).toBe('Software als dienst (SaaS)'), LOAD);
  });

  it('falls back to English for a language without US bookkeeping texts instead of failing', { timeout: 30_000 }, async () => {
    const { result } = renderHook(() => useDocumentTexts(), { wrapper: wrapperFor('es') });
    await waitFor(() => expect(isLocaleLoaded('es')).toBe(true), LOAD);
    expect(result.current.taxCodes.saas).toBe('Software as a service');
    expect(result.current.errors.addressRequired).toMatch(/ship-to/);
  });
});
