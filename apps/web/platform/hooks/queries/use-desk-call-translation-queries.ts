/**
 * WeldDesk live call translation (call-api `/api/desk/phone/calls/:callId/translation`).
 * Global only (feature `desk-ai`); the captions themselves arrive over realtime
 * (`phone.caption`, see components/welddesk/phone/call-translation).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@weldsuite/api-client';
import type {
  CallTranslationState,
  StartCallTranslation,
  UpdateCallTranslation,
} from '@weldsuite/core-api-client/schemas/desk-call-translation';
import { useAppApiClient } from '@/lib/api/use-app-api';

export type DeskCallTranslation = CallTranslationState;

export const deskCallTranslationKeys = {
  call: (callId: string) => ['desk', 'phone', 'call-translation', callId] as const,
};

const path = (callId: string) => `/desk/phone/calls/${encodeURIComponent(callId)}/translation`;

/** The call's translation state; null while it was never switched on. */
export function useDeskCallTranslation(callId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskCallTranslationKeys.call(callId),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskCallTranslation | null }>(path(callId));
      return res.data ?? null;
    },
    enabled: enabled && Boolean(callId),
    staleTime: 30_000,
    retry: false,
  });
}

export function useStartDeskCallTranslation(callId: string) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: StartCallTranslation) => {
      const client = await getClient();
      const res = await client.post<{ data: DeskCallTranslation }>(path(callId), input);
      return res.data;
    },
    onSuccess: (state) => qc.setQueryData(deskCallTranslationKeys.call(callId), state),
  });
}

export function useUpdateDeskCallTranslation(callId: string) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateCallTranslation) => {
      const client = await getClient();
      const res = await client.patch<{ data: DeskCallTranslation }>(path(callId), input);
      return res.data;
    },
    onSuccess: (state) => qc.setQueryData(deskCallTranslationKeys.call(callId), state),
  });
}

export function useStopDeskCallTranslation(callId: string) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      const res = await client.delete<{ data: DeskCallTranslation }>(path(callId));
      return res.data;
    },
    onSuccess: (state) => qc.setQueryData(deskCallTranslationKeys.call(callId), state),
  });
}

/** What went wrong with a call-translation request; the UI words each. */
export type DeskCallTranslationFailure =
  | 'noCredits'
  | 'aiUnavailable'
  | 'notLive'
  | 'notYourCall'
  | 'alreadyTranslating'
  | 'notTranslating'
  | 'upstream'
  | 'generic';

const REASONS: Record<string, DeskCallTranslationFailure> = {
  not_live: 'notLive',
  not_your_call: 'notYourCall',
  already_translating: 'alreadyTranslating',
  not_translating: 'notTranslating',
};

/** Maps the routes' refusals (402, 409 with a `reason`, 502, 503) to a failure. */
export function deskCallTranslationFailure(err: unknown): DeskCallTranslationFailure {
  if (!isApiError(err)) return 'generic';
  if (err.status === 402) return 'noCredits';
  if (err.status === 503) return 'aiUnavailable';
  if (err.status === 502) return 'upstream';
  if (err.status === 409) {
    const body = err.body as { error?: { details?: { reason?: unknown } } } | undefined;
    const reason = body?.error?.details?.reason;
    return (typeof reason === 'string' && REASONS[reason]) || 'generic';
  }
  return 'generic';
}
