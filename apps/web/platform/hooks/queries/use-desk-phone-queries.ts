/**
 * WeldDesk phone (call-api `/api/desk/phone/*`): the member's own softphone
 * ("take calls" switch and login token), the callers waiting in the queue and
 * picking one up. Realtime: the waiting set is announced on the workspace
 * topic `desk_phone_queue`; a slow poll covers a missed event.
 */

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@weldsuite/api-client';
import { useTopic } from '@weldsuite/realtime/react';
import type { z } from 'zod';
import type {
  deskPhonePickupSchema,
  deskPhoneQueueItemSchema,
  deskSoftphoneSchema,
  deskSoftphoneTokenSchema,
} from '@weldsuite/app-api-client/schemas/call-responses';
import { useAppApiClient } from '@/lib/api/use-app-api';

export type DeskSoftphone = z.infer<typeof deskSoftphoneSchema>;
export type DeskSoftphoneToken = z.infer<typeof deskSoftphoneTokenSchema>;
export type DeskPhoneQueueItem = z.infer<typeof deskPhoneQueueItemSchema>;
export type DeskPhonePickup = z.infer<typeof deskPhonePickupSchema>;

export const deskPhoneKeys = {
  all: ['desk', 'phone'] as const,
  softphone: () => [...deskPhoneKeys.all, 'softphone'] as const,
  queue: () => [...deskPhoneKeys.all, 'queue'] as const,
};

/** How often the waiting list is re-read when no realtime event arrived. */
export const DESK_PHONE_QUEUE_POLL_MS = 15_000;
/** How often the member's softphone state is re-read (another tab may have changed it). */
const SOFTPHONE_POLL_MS = 60_000;

/** The member's "take calls" state and whether telephony is set up. Disabled for members who cannot read conversations. */
export function useDeskSoftphone(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskPhoneKeys.softphone(),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskSoftphone }>('/desk/phone/softphone');
      return res.data;
    },
    enabled,
    staleTime: 30_000,
    refetchInterval: SOFTPHONE_POLL_MS,
  });
}

/** Switch "take calls" on or off. */
export function useSetDeskSoftphoneAvailable() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (available: boolean) => {
      const client = await getClient();
      const res = await client.put<{ data: DeskSoftphone }>('/desk/phone/softphone', { available });
      return res.data;
    },
    onSuccess: (softphone) => {
      qc.setQueryData(deskPhoneKeys.softphone(), softphone);
    },
  });
}

/** The login token of the member's own softphone credential (created on first use). */
export function useFetchDeskSoftphoneToken() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      const res = await client.post<{ data: DeskSoftphoneToken }>('/desk/phone/softphone/token', {});
      return res.data;
    },
  });
}

/** Callers waiting for an agent, oldest first. Stays live on `desk_phone_queue`, with a slow poll as a safety net. */
export function useDeskPhoneQueue(enabled = true) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: deskPhoneKeys.queue() });
  }, [qc]);
  useTopic(enabled ? 'desk_phone_queue' : '', refresh);

  return useQuery({
    queryKey: deskPhoneKeys.queue(),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskPhoneQueueItem[] }>('/desk/phone/queue');
      return res.data ?? [];
    },
    enabled,
    refetchInterval: DESK_PHONE_QUEUE_POLL_MS,
  });
}

/** Ring the member's own browser for a waiting call. */
export function usePickupDeskPhoneCall() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (callId: string) => {
      const client = await getClient();
      const res = await client.post<{ data: DeskPhonePickup }>(
        `/desk/phone/queue/${encodeURIComponent(callId)}/pickup`,
        {},
      );
      return res.data;
    },
    // Whether it worked or the call is gone, the list is out of date.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: deskPhoneKeys.queue() });
    },
  });
}

/** Why a pickup was refused; the UI turns each into a sentence. */
export type DeskPhonePickupFailure =
  | 'gone'
  | 'notReady'
  | 'noCredential'
  | 'notActivated'
  | 'ringFailed'
  | 'unknown';

/** Maps the pickup route's refusals (404, 409 with a message, 400, 502) to a failure the UI can word. */
export function deskPhonePickupFailure(err: unknown): DeskPhonePickupFailure {
  if (!isApiError(err)) return 'unknown';
  const body = err.body as { error?: { message?: unknown } } | undefined;
  const message = typeof body?.error?.message === 'string' ? body.error.message : err.message;
  if (err.status === 404) return 'gone';
  if (err.status === 409) {
    if (/no longer waiting/i.test(message)) return 'gone';
    if (/cannot be picked up yet/i.test(message)) return 'notReady';
    if (/no softphone credential/i.test(message)) return 'noCredential';
    return 'unknown';
  }
  if (err.status === 400 && /not activated/i.test(message)) return 'notActivated';
  if (err.status === 502) return 'ringFailed';
  return 'unknown';
}
