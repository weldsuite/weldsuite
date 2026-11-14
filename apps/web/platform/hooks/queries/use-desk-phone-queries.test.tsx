/**
 * WeldDesk phone queries: the waiting list refetches on `desk_phone_queue`
 * (with a slow poll behind it), and the pickup route's refusals map to a
 * failure the UI can word.
 */

import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@weldsuite/api-client';

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => client }),
}));

const topic = vi.hoisted(() => ({ name: '', handler: null as null | (() => void) }));
vi.mock('@weldsuite/realtime/react', () => ({
  useTopic: (name: string, handler: () => void) => {
    topic.name = name;
    topic.handler = handler;
  },
}));

import {
  DESK_PHONE_QUEUE_POLL_MS,
  deskPhonePickupFailure,
  deskPhoneKeys,
  useDeskPhoneQueue,
  useDeskSoftphone,
  usePickupDeskPhoneCall,
  useSetDeskSoftphoneAvailable,
} from './use-desk-phone-queries';

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

const waiting = (callId: string) => ({
  callId,
  conversationId: 'dconv_1',
  fromNumber: '+31612345678',
  callerName: null,
  departmentId: null,
  waitingSince: '2026-11-09T10:00:00.000Z',
  ringing: false,
});

beforeEach(() => {
  client.get.mockReset();
  client.post.mockReset();
  client.put.mockReset();
  topic.name = '';
  topic.handler = null;
});

describe('useDeskPhoneQueue', () => {
  it('reads the waiting calls and listens on desk_phone_queue', async () => {
    client.get.mockResolvedValue({ data: [waiting('call_1')] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useDeskPhoneQueue(true), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(client.get).toHaveBeenCalledWith('/desk/phone/queue');
    expect(topic.name).toBe('desk_phone_queue');
  });

  it('refetches when the queue changes', async () => {
    client.get.mockResolvedValueOnce({ data: [waiting('call_1')] }).mockResolvedValueOnce({ data: [] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useDeskPhoneQueue(true), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    act(() => topic.handler?.());
    await waitFor(() => expect(result.current.data).toEqual([]));
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it('polls slowly as a safety net', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      client.get.mockResolvedValue({ data: [] });
      const { wrapper } = setup();
      renderHook(() => useDeskPhoneQueue(true), { wrapper });
      await waitFor(() => expect(client.get).toHaveBeenCalledTimes(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DESK_PHONE_QUEUE_POLL_MS + 100);
      });
      expect(client.get.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing while disabled', () => {
    const { wrapper } = setup();
    renderHook(() => useDeskPhoneQueue(false), { wrapper });
    expect(client.get).not.toHaveBeenCalled();
    expect(topic.name).toBe('');
  });
});

describe('softphone hooks', () => {
  it('reads the softphone and switches take calls, keeping the cache in step', async () => {
    client.get.mockResolvedValue({ data: { configured: true, available: false, registered: false, sipUsername: null } });
    client.put.mockResolvedValue({ data: { configured: true, available: true, registered: true, sipUsername: 'sip_me' } });
    const { qc, wrapper } = setup();
    const { result } = renderHook(() => ({ read: useDeskSoftphone(true), set: useSetDeskSoftphoneAvailable() }), { wrapper });
    await waitFor(() => expect(result.current.read.data?.available).toBe(false));
    expect(client.get).toHaveBeenCalledWith('/desk/phone/softphone');

    await act(async () => {
      await result.current.set.mutateAsync(true);
    });
    expect(client.put).toHaveBeenCalledWith('/desk/phone/softphone', { available: true });
    expect(qc.getQueryData(deskPhoneKeys.softphone())).toMatchObject({ available: true, sipUsername: 'sip_me' });
  });
});

describe('usePickupDeskPhoneCall', () => {
  it('asks the server to ring this member for the call and refreshes the list', async () => {
    client.post.mockResolvedValue({ data: { callId: 'call_1', ringing: true } });
    const { qc, wrapper } = setup();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => usePickupDeskPhoneCall(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('call_1');
    });
    expect(client.post).toHaveBeenCalledWith('/desk/phone/queue/call_1/pickup', {});
    expect(invalidate).toHaveBeenCalledWith({ queryKey: deskPhoneKeys.queue() });
  });

  it('refreshes the list when the pickup is refused too', async () => {
    client.post.mockRejectedValue(new ApiError('conflict', 409, { error: { message: 'The call is no longer waiting' } }));
    const { qc, wrapper } = setup();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => usePickupDeskPhoneCall(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('call_1').catch(() => undefined);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: deskPhoneKeys.queue() });
  });
});

describe('deskPhonePickupFailure', () => {
  const refusal = (status: number, message: string) => new ApiError(message, status, { error: { message } });

  it.each([
    [refusal(404, 'Call not found'), 'gone'],
    [refusal(409, 'The call is no longer waiting'), 'gone'],
    [refusal(409, 'The call cannot be picked up yet'), 'notReady'],
    [refusal(409, 'You have no softphone credential yet'), 'noCredential'],
    [refusal(400, 'Phone service is not activated'), 'notActivated'],
    [refusal(502, 'Could not ring your softphone'), 'ringFailed'],
    [refusal(500, 'boom'), 'unknown'],
    [refusal(409, 'something else'), 'unknown'],
    [new Error('offline'), 'unknown'],
  ] as const)('maps %#', (error, expected) => {
    expect(deskPhonePickupFailure(error)).toBe(expected);
  });
});
