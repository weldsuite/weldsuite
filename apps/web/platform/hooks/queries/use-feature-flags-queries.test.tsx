import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';

const get = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ featureFlags: { get } }) }));

import { useFeatureFlag, useFeatureFlagStatus } from './use-feature-flags-queries';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useFeatureFlagStatus', () => {
  it('is undefined while the flags load, then the flag', async () => {
    get.mockResolvedValue({ data: { 'chat-visuals-gallery': true } });
    const { result } = renderHook(() => useFeatureFlagStatus('chat-visuals-gallery'), { wrapper });
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('is off when the flags cannot be read', async () => {
    get.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useFeatureFlagStatus('chat-visuals-gallery'), { wrapper });
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('is off for a flag the answer leaves out', async () => {
    get.mockResolvedValue({ data: {} });
    const { result } = renderHook(
      () => ({ status: useFeatureFlagStatus('chat-visuals-gallery'), plain: useFeatureFlag('chat-visuals-gallery') }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.status).toBe(false));
    expect(result.current.plain).toBe(false);
  });
});
