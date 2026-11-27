import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@weldsuite/api-client';

const weldforms = vi.hoisted(() => ({
  domainsConfig: vi.fn(),
  domains: vi.fn(),
  addDomain: vi.fn(),
  refreshDomain: vi.fn(),
  makeDomainPrimary: vi.fn(),
  updateDomain: vi.fn(),
  removeDomain: vi.fn(),
}));

vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ weldforms }) }));

import {
  formDomainErrorCode,
  useAddFormDomain,
  useFormDomains,
  useFormDomainsConfig,
  useMakeFormDomainPrimary,
  useRefreshFormDomain,
  useRemoveFormDomain,
  useUpdateFormDomain,
  weldformsKeys,
} from './use-weldforms-queries';

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('WeldForms custom domain queries', () => {
  it('reads the config and the domains', async () => {
    weldforms.domainsConfig.mockResolvedValue({ data: { available: true } });
    weldforms.domains.mockResolvedValue({ data: [{ id: 'fdom_1' }] });
    const client = new QueryClient();
    const config = renderHook(() => useFormDomainsConfig(), { wrapper: wrapper(client) });
    const list = renderHook(() => useFormDomains(), { wrapper: wrapper(client) });
    await waitFor(() => expect(config.result.current.data).toEqual({ available: true }));
    await waitFor(() => expect(list.result.current.data).toEqual([{ id: 'fdom_1' }]));
  });

  it('asks nothing while disabled', () => {
    weldforms.domains.mockClear();
    renderHook(() => useFormDomains(false), { wrapper: wrapper(new QueryClient()) });
    expect(weldforms.domains).not.toHaveBeenCalled();
  });

  it('refreshes the domains and the form lists after every change', async () => {
    for (const fn of Object.values(weldforms)) fn.mockResolvedValue({ data: {} });
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(
      () => ({
        add: useAddFormDomain(),
        refresh: useRefreshFormDomain(),
        primary: useMakeFormDomainPrimary(),
        update: useUpdateFormDomain(),
        remove: useRemoveFormDomain(),
      }),
      { wrapper: wrapper(client) },
    );
    await act(async () => {
      await result.current.add.mutateAsync({ hostname: 'forms.acme.com' });
      await result.current.refresh.mutateAsync('fdom_1');
      await result.current.primary.mutateAsync('fdom_1');
      await result.current.update.mutateAsync({ id: 'fdom_1', homeFormPublicId: 'abc' });
      await result.current.remove.mutateAsync('fdom_1');
    });
    expect(weldforms.addDomain).toHaveBeenCalledWith({ hostname: 'forms.acme.com' });
    expect(weldforms.refreshDomain).toHaveBeenCalledWith('fdom_1');
    expect(weldforms.makeDomainPrimary).toHaveBeenCalledWith('fdom_1');
    expect(weldforms.updateDomain).toHaveBeenCalledWith('fdom_1', { homeFormPublicId: 'abc' });
    expect(weldforms.removeDomain).toHaveBeenCalledWith('fdom_1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: weldformsKeys.domains() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: weldformsKeys.lists() });
    expect(invalidate).toHaveBeenCalledTimes(10);
  });

  it("reads the server's error code", () => {
    expect(formDomainErrorCode(new ApiError('taken', 409, { error: { code: 'HOST_TAKEN', message: 'x' } }))).toBe('HOST_TAKEN');
    expect(formDomainErrorCode(new ApiError('boom', 500))).toBeNull();
    expect(formDomainErrorCode(new Error('network'))).toBeNull();
  });
});
