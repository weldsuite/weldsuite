import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const weldforms = vi.hoisted(() => ({ fill: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => ({ weldforms }) }));

import { weldformsKeys } from './use-weldforms-queries';
import { useMemberFill, weldformsResultsKeys } from './use-weldforms-results-queries';

describe('useMemberFill', () => {
  it('is not refetched by the module-wide invalidation of a form event', async () => {
    weldforms.fill.mockResolvedValue({ data: { alreadyResponded: false } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useMemberFill('pub_1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // What lib/realtime/sync-map.ts does for form and form_response events,
    // the member's own submit included.
    await client.invalidateQueries({ queryKey: weldformsKeys.all });

    expect(weldforms.fill).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({ alreadyResponded: false });
    expect(weldformsResultsKeys.fill('pub_1')[0]).not.toBe(weldformsKeys.all[0]);
  });
});
