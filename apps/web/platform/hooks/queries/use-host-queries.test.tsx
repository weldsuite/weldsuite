import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError } from '@weldsuite/api-client';
import {
  hostKeys,
  useRefreshZoneStatus,
  zoneStatusRefetchInterval,
  type RefreshZoneStatusResponse,
} from './use-host-queries';

const refreshZoneStatusMock = vi.fn();

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApi: () => ({
    domains: {
      refreshZoneStatus: (...args: unknown[]) => refreshZoneStatusMock(...args),
    },
  }),
}));

function createWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useRefreshZoneStatus', () => {
  beforeEach(() => {
    refreshZoneStatusMock.mockReset();
  });

  it('does not loop when the zone stays active after the initial sync', async () => {
    refreshZoneStatusMock.mockResolvedValue({
      data: {
        zoneStatus: 'active',
        domainStatus: 'active',
        cloudflareStatus: 'active',
      },
    });

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useRefreshZoneStatus('dom_test', true), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => {
      expect(refreshZoneStatusMock).toHaveBeenCalledTimes(1);
    });

    invalidateSpy.mockClear();
    await result.current.refetch();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(refreshZoneStatusMock).toHaveBeenCalledTimes(2);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('invalidates domain and dns queries once when the zone becomes active', async () => {
    refreshZoneStatusMock
      .mockResolvedValueOnce({
        data: {
          zoneStatus: 'pending',
          domainStatus: 'pending',
          cloudflareStatus: 'pending',
        },
      })
      .mockResolvedValueOnce({
        data: {
          zoneStatus: 'active',
          domainStatus: 'active',
          cloudflareStatus: 'active',
        },
      });

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useRefreshZoneStatus('dom_test', true), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => {
      expect(result.current.data?.data.zoneStatus).toBe('pending');
    });

    await result.current.refetch();

    await waitFor(() => {
      expect(result.current.data?.data.zoneStatus).toBe('active');
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: hostKeys.domain('dom_test'),
      exact: true,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: hostKeys.dnsZones('dom_test'),
    });

    invalidateSpy.mockClear();
    await result.current.refetch();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('uses a zone-status key outside the domain query prefix', () => {
    const domainKey = hostKeys.domain('dom_test');
    const zoneStatusKey = hostKeys.zoneStatus('dom_test');

    expect(zoneStatusKey.slice(0, domainKey.length)).not.toEqual(domainKey);
  });
});

describe('zoneStatusRefetchInterval', () => {
  const answer = (zoneStatus: RefreshZoneStatusResponse['data']['zoneStatus']): RefreshZoneStatusResponse => ({
    data: { zoneStatus, domainStatus: 'pending', cloudflareStatus: zoneStatus },
  });

  it('polls a zone that waits for its delegation, and stops once it is settled', () => {
    expect(zoneStatusRefetchInterval(answer('pending'), null)).toBe(20_000);
    expect(zoneStatusRefetchInterval(answer('active'), null)).toBe(false);
    expect(zoneStatusRefetchInterval(answer('error'), null)).toBe(false);
  });

  it('stops when the API answers that the domain has no zone it watches', () => {
    const refused = new ApiError('This domain does not have a Hetzner zone yet.', 400);
    expect(zoneStatusRefetchInterval(undefined, refused)).toBe(false);
  });

  it('keeps trying after a server error or before any answer', () => {
    expect(zoneStatusRefetchInterval(undefined, new ApiError('Could not reach Hetzner.', 503))).toBe(20_000);
    expect(zoneStatusRefetchInterval(undefined, new Error('offline'))).toBe(20_000);
    expect(zoneStatusRefetchInterval(undefined, null)).toBe(20_000);
  });
});
