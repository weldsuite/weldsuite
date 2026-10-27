import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { WorkspaceEvent } from '@weldsuite/realtime';

const ME = 'user_me';

const client = { get: vi.fn(), put: vi.fn() };
const getClient = async () => client;
const workspaceClient = {
  setPresence: vi.fn(),
  onResyncRequired: vi.fn(() => () => {}),
};
let presenceHandler: ((event: WorkspaceEvent) => void) | null = null;

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ userId: ME }),
  useOrganization: () => ({ organization: { id: 'org_acme' } }),
}));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApiClient: () => ({ getClient }) }));
vi.mock('@weldsuite/realtime/react', () => ({
  useWorkspaceClientMaybe: () => workspaceClient,
  useTopic: (_topic: string, handler: (event: WorkspaceEvent) => void) => {
    presenceHandler = handler;
  },
}));

import { PresenceProvider, usePresence } from './presence-context';

function emit(event: string, data: unknown) {
  act(() => presenceHandler?.({ topic: 'presence', event, data, ts: Date.now(), userId: 'system' }));
}

const wrapper = ({ children }: { children: ReactNode }) => <PresenceProvider>{children}</PresenceProvider>;

function rows(...data: Array<Record<string, unknown>>) {
  return { data };
}

describe('PresenceProvider', () => {
  beforeEach(() => {
    client.get.mockReset();
    client.put.mockReset();
    workspaceClient.setPresence.mockReset();
    presenceHandler = null;
  });

  afterEach(() => cleanup());

  it('shows the chosen status while connected, and offline when not', async () => {
    client.get.mockResolvedValue(
      rows(
        { userId: 'user_bob', manualStatus: 'dnd', live: 'online', statusText: 'Focus', updatedAt: '2026-10-27T09:00:00Z' },
        { userId: 'user_carol', manualStatus: 'dnd', live: null, updatedAt: '2026-10-27T09:00:00Z' },
        { userId: 'user_dave', manualStatus: 'online', live: 'away', updatedAt: null },
      ),
    );
    const { result } = renderHook(() => usePresence(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.getStatus('user_bob')).toEqual({ status: 'dnd', statusText: 'Focus', statusEmoji: undefined });
    expect(result.current.getStatus('user_carol')?.status).toBe('offline');
    expect(result.current.getStatus('user_dave')?.status).toBe('away');
    expect(result.current.myStatus?.status).toBe('online');
  });

  it('keeps the hub snapshot over live presence from a slower fetch', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    client.get.mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));
    const { result } = renderHook(() => usePresence(), { wrapper });

    emit('snapshot', { users: { user_bob: 'away' } });
    await act(async () => resolveFetch(rows({ userId: 'user_bob', manualStatus: 'online', live: 'online' })));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.getStatus('user_bob')?.status).toBe('away');

    emit('connection_changed', { userId: 'user_bob', live: null });
    expect(result.current.getStatus('user_bob')?.status).toBe('offline');
  });

  it('never lets an older or legacy status event replace a newer status', async () => {
    client.get.mockResolvedValue(
      rows({ userId: 'user_bob', manualStatus: 'busy', live: 'online', updatedAt: '2026-10-27T09:00:00Z' }),
    );
    const { result } = renderHook(() => usePresence(), { wrapper });
    await waitFor(() => expect(result.current.getStatus('user_bob')?.status).toBe('busy'));

    // Replayed from the hub's log after the fetch: older than the row.
    emit('status_changed', { userId: 'user_bob', status: 'online', updatedAt: '2026-10-27T08:00:00Z' });
    // From before presence moved into the hub: `offline` meant "disconnected".
    emit('status_changed', { userId: 'user_bob', status: 'offline' });
    expect(result.current.getStatus('user_bob')?.status).toBe('busy');

    emit('status_changed', { userId: 'user_bob', status: 'dnd', updatedAt: '2026-10-27T10:00:00Z' });
    expect(result.current.getStatus('user_bob')?.status).toBe('dnd');
  });

  it('saves a chosen status and reports calls to the hub', async () => {
    client.get.mockResolvedValue(rows());
    client.put.mockResolvedValue({
      data: { userId: ME, status: 'dnd', updatedAt: '2026-10-27T10:00:00Z' },
    });
    const { result } = renderHook(() => usePresence(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => result.current.setMyStatus('dnd'));
    expect(client.put).toHaveBeenCalledWith('/chat-status', { status: 'dnd', statusText: undefined, statusEmoji: undefined });
    expect(result.current.myStatus?.status).toBe('dnd');

    act(() => result.current.setInCall(true));
    expect(workspaceClient.setPresence).toHaveBeenCalledWith({ inCall: true });
  });
});
