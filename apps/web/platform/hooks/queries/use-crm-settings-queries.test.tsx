import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const m = vi.hoisted(() => ({
  available: true,
  get: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApi: () => ({ crmSettings: { get: m.get, update: m.update } }),
}));
vi.mock('@/lib/edition', () => ({
  isFeatureAvailable: (feature: string) => feature === 'crm-auto-add' && m.available,
}));

import { crmSettingsKeys, useCrmSettings, useUpdateCrmSettings } from './use-crm-settings-queries';

const settings = (enabled: boolean) => ({
  autoAdd: { enabled, createCompanies: false, sources: { email: true, meetings: true, helpdesk: true } },
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('crm settings queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.available = true;
    m.get.mockResolvedValue({ data: settings(false) });
  });

  it('reads the settings', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useCrmSettings(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(settings(false));
  });

  it('never asks for the route where the edition has no auto-add', () => {
    m.available = false;
    const { wrapper } = setup();
    const { result } = renderHook(() => useCrmSettings(), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(m.get).not.toHaveBeenCalled();
  });

  it('puts the saved settings in the cache', async () => {
    m.update.mockResolvedValue({ data: settings(true) });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useUpdateCrmSettings(), { wrapper });
    await act(() => result.current.mutateAsync({ autoAdd: { enabled: true } }));
    expect(m.update).toHaveBeenCalledWith({ autoAdd: { enabled: true } });
    expect(client.getQueryData(crmSettingsKeys.all)).toEqual({ data: settings(true) });
  });
});
