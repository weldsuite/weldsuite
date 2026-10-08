import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TaxPreviewRequest, TaxPreviewResult } from '@/lib/api/domains/weldbooks-sales-tax-preview';

const calculate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/domains/weldbooks-sales-tax-preview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/domains/weldbooks-sales-tax-preview')>();
  return { ...actual, salesTaxPreviewApi: { ...actual.salesTaxPreviewApi, calculate } };
});
vi.mock('@/lib/api/use-app-api', () => ({ useAppApiClient: () => ({ getClient: vi.fn() }) }));

import { useTaxPreview } from './use-weldbooks-tax-preview';

function result(total: string): TaxPreviewResult {
  return {
    engine: 'manual',
    engineRef: null,
    calculatedAt: '2026-03-01T00:00:00.000Z',
    warnings: [],
    shipToState: 'TX',
    shipToPostalCode: '78701',
    addressIncomplete: false,
    subtotal: '100.00',
    discountTotal: '0.00',
    taxTotal: '8.25',
    total,
    lines: [],
    jurisdictions: [],
    taxBreakdown: [],
  };
}

function request(unitPrice: string): TaxPreviewRequest {
  return { kind: 'invoice', items: [{ description: 'Work', quantity: '1', unitPrice }] };
}

function wrapper({ children }: Readonly<{ children: ReactNode }>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function engineDown() {
  return Object.assign(new Error('Engine unreachable'), { code: 'TAX_ENGINE_UNAVAILABLE', status: 503 });
}

describe('useTaxPreview', () => {
  beforeEach(() => {
    calculate.mockReset();
  });

  it('calculates once after the edits stop, for the last state of the form', async () => {
    calculate.mockResolvedValue({ data: result('108.25') });
    const { result: hook, rerender } = renderHook(({ req }) => useTaxPreview(req, { debounceMs: 30 }), {
      wrapper,
      initialProps: { req: null as TaxPreviewRequest | null },
    });

    rerender({ req: request('1') });
    rerender({ req: request('10') });
    rerender({ req: request('100') });
    expect(hook.current.isCalculating).toBe(true);
    expect(calculate).not.toHaveBeenCalled();

    await waitFor(() => expect(hook.current.result?.total).toBe('108.25'));
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(calculate).toHaveBeenCalledWith(request('100'));
    expect(hook.current.isCalculating).toBe(false);
    expect(hook.current.isStale).toBe(false);
  });

  it('keeps the last good values on screen while the next ones load', async () => {
    calculate.mockResolvedValueOnce({ data: result('108.25') });
    const { result: hook, rerender } = renderHook(({ req }) => useTaxPreview(req, { debounceMs: 10 }), {
      wrapper,
      initialProps: { req: request('100') as TaxPreviewRequest | null },
    });
    await waitFor(() => expect(hook.current.result?.total).toBe('108.25'));

    calculate.mockReturnValueOnce(new Promise(() => {}));
    rerender({ req: request('200') });
    await waitFor(() => expect(hook.current.isCalculating).toBe(true));
    expect(hook.current.result?.total).toBe('108.25');
    expect(hook.current.isStale).toBe(true);
  });

  it('keeps the last good values when a calculation fails, and says why', async () => {
    calculate.mockResolvedValueOnce({ data: result('108.25') });
    const { result: hook, rerender } = renderHook(({ req }) => useTaxPreview(req, { debounceMs: 10 }), {
      wrapper,
      initialProps: { req: request('100') as TaxPreviewRequest | null },
    });
    await waitFor(() => expect(hook.current.result?.total).toBe('108.25'));

    calculate.mockRejectedValueOnce(engineDown());
    rerender({ req: request('200') });

    await waitFor(() => expect(hook.current.errorCode).toBe('TAX_ENGINE_UNAVAILABLE'));
    expect(hook.current.result?.total).toBe('108.25');
    expect(hook.current.isStale).toBe(true);
    expect(hook.current.isCalculating).toBe(false);
  });

  it('clears the error once a later calculation succeeds', async () => {
    calculate.mockRejectedValueOnce(engineDown());
    const { result: hook, rerender } = renderHook(({ req }) => useTaxPreview(req, { debounceMs: 10 }), {
      wrapper,
      initialProps: { req: request('100') as TaxPreviewRequest | null },
    });
    await waitFor(() => expect(hook.current.errorCode).toBe('TAX_ENGINE_UNAVAILABLE'));
    expect(hook.current.result).toBeNull();

    calculate.mockResolvedValueOnce({ data: result('216.50') });
    rerender({ req: request('200') });
    await waitFor(() => expect(hook.current.result?.total).toBe('216.50'));
    expect(hook.current.error).toBeNull();
  });

  it('has nothing to show, and asks nothing, while nothing is priced', async () => {
    const { result: hook } = renderHook(() => useTaxPreview(null, { debounceMs: 10 }), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calculate).not.toHaveBeenCalled();
    expect(hook.current.result).toBeNull();
    expect(hook.current.isCalculating).toBe(false);
  });

  it('does not ask while disabled (the jurisdiction is not known yet)', async () => {
    const { result: hook } = renderHook(() => useTaxPreview(request('100'), { debounceMs: 10, enabled: false }), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calculate).not.toHaveBeenCalled();
    expect(hook.current.result).toBeNull();
  });
});
