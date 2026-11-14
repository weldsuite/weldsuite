import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const getMock = vi.fn();
const entityIdRef = { current: 'ent_in' as string | null };

vi.mock('@/lib/api/weldbooks-client', () => ({
  weldbooksApi: {
    get: (...args: unknown[]) => getMock(...args),
  },
}));

vi.mock('@/hooks/use-current-accounting-entity', () => ({
  useCurrentAccountingEntity: () => ({
    entityId: entityIdRef.current,
    setEntityId: vi.fn(),
  }),
}));

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspaceId: () => 'ws_test',
}));

import { useCurrentEntityCurrency } from './use-current-entity-currency';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useCurrentEntityCurrency', () => {
  beforeEach(() => {
    getMock.mockReset();
    entityIdRef.current = 'ent_in';
  });

  it('returns the selected entity base currency and formats INR amounts', async () => {
    getMock.mockResolvedValue({
      data: [
        { id: 'ent_nl', baseCurrency: 'EUR', locale: 'nl-NL' },
        { id: 'ent_in', baseCurrency: 'INR', locale: 'en-IN' },
      ],
    });

    const { result } = renderHook(() => useCurrentEntityCurrency(), { wrapper });

    await waitFor(() => {
      expect(result.current.currency).toBe('INR');
    });
    expect(result.current.locale).toBe('en-IN');
    expect(result.current.formatMoney(1500)).toMatch(/₹|INR/);
    expect(result.current.formatMoney(1500)).not.toMatch(/€/);
  });

  it('reads an entity without a locale the way its country does, not the way the browser does', async () => {
    entityIdRef.current = 'ent_nl';
    getMock.mockImplementation(async (path: string) => {
      if (path.includes('jurisdictions')) {
        return { data: [{ code: 'NL', defaultLocale: 'nl-NL' }, { code: 'US', defaultLocale: 'en-US' }] };
      }
      return { data: [{ id: 'ent_nl', baseCurrency: 'EUR', locale: null, jurisdictionCode: 'NL' }] };
    });

    const { result } = renderHook(() => useCurrentEntityCurrency(), { wrapper });

    await waitFor(() => {
      expect(result.current.locale).toBe('nl-NL');
    });
    // Dutch grouping and decimal comma, whatever the browser's locale is.
    expect(result.current.formatMoney(1234.5).replace(/\s/g, ' ')).toMatch(/1\.234,50/);
  });

  it('prefers the locale of the entity itself over the one of its jurisdiction', async () => {
    entityIdRef.current = 'ent_nl';
    getMock.mockImplementation(async (path: string) => {
      if (path.includes('jurisdictions')) return { data: [{ code: 'NL', defaultLocale: 'nl-NL' }] };
      return { data: [{ id: 'ent_nl', baseCurrency: 'EUR', locale: 'en-IE', jurisdictionCode: 'NL' }] };
    });

    const { result } = renderHook(() => useCurrentEntityCurrency(), { wrapper });

    await waitFor(() => {
      expect(result.current.locale).toBe('en-IE');
    });
  });

  it('does not assume a currency when no entity is loaded', async () => {
    entityIdRef.current = null;
    getMock.mockResolvedValue({ data: [] });

    const { result } = renderHook(() => useCurrentEntityCurrency(), { wrapper });

    await waitFor(() => {
      expect(getMock).toHaveBeenCalled();
    });
    expect(result.current.currency).toBe('');
    expect(result.current.entityCurrency).toBeNull();
    expect(result.current.formatMoney(10)).not.toMatch(/€|\$/);
  });

  it('formats a US entity in USD with en-US', async () => {
    entityIdRef.current = 'ent_us';
    getMock.mockResolvedValue({
      data: [{ id: 'ent_us', baseCurrency: 'USD', locale: 'en-US', jurisdictionCode: 'US' }],
    });

    const { result } = renderHook(() => useCurrentEntityCurrency(), { wrapper });

    await waitFor(() => {
      expect(result.current.currency).toBe('USD');
    });
    expect(result.current.formatMoney(1234.5)).toBe('$1,234.50');
  });
});
