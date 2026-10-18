import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useUpdateWeldchatLastPath, useUserPreferences } from './use-settings-queries';

const getMock = vi.fn();
const putMock = vi.fn();

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({
    getClient: async () => ({
      get: (...args: unknown[]) => getMock(...args),
      put: (...args: unknown[]) => putMock(...args),
    }),
  }),
}));

const serverPrefs = {
  theme: 'dark',
  fontSize: 16,
  language: 'nl',
  dateFormat: 'DD/MM/YYYY',
  timeFormat: '24h',
  timezone: 'Europe/Amsterdam',
  uiPreferences: { weldchatLastPath: '/weldchat/ch_1' },
};

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => ({ prefs: useUserPreferences(), save: useUpdateWeldchatLastPath() }), { wrapper });
}

describe('useUpdateWeldchatLastPath', () => {
  beforeEach(() => {
    getMock.mockReset();
    putMock.mockReset();
    putMock.mockResolvedValue({ data: serverPrefs });
  });

  it('re-reads the preferences when the write cancelled their first load', async () => {
    // Cold start: the first GET is still in flight when WeldChat records its page.
    getMock.mockReturnValueOnce(new Promise(() => {})).mockResolvedValue({ data: serverPrefs });
    const { result } = setup();
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));

    act(() => result.current.save.mutate('/weldchat/ch_1'));

    await waitFor(() => expect(result.current.prefs.data?.theme).toBe('dark'));
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('skips the re-read when no load was in flight', async () => {
    getMock.mockResolvedValue({ data: serverPrefs });
    const { result } = setup();
    await waitFor(() => expect(result.current.prefs.isSuccess).toBe(true));

    act(() => result.current.save.mutate('/weldchat/ch_2'));

    await waitFor(() => expect(result.current.save.isSuccess).toBe(true));
    expect(result.current.prefs.data?.uiPreferences?.weldchatLastPath).toBe('/weldchat/ch_2');
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});
