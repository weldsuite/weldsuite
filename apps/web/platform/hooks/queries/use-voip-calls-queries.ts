/**
 * VoIP call hooks — app-api `/api/calls` + `/api/call-intelligence/*`.
 *
 * W5 moved the remaining legacy `/crm/call-intelligence/*` calls onto app-api;
 * W5b removed the last two (hold/resume), which pointed at already-deleted
 * routes — see the note at the bottom of the file. This file is fully on
 * app-api.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type {
  VoipCall,
  CallFilters,
  CallStats,
  VoipPhoneNumber,
  PaginatedResponse,
  SingleResponse,
} from '@/lib/api/domains/call-intelligence';

export type { VoipCall, CallFilters, CallStats, VoipPhoneNumber } from '@/lib/api/domains/call-intelligence';


// =============================================================================
// Helper
// =============================================================================

function buildQueryString(params: Record<string, any>): string {
  const queryParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      queryParams.set(key, String(value));
    }
  }
  const query = queryParams.toString();
  return query ? `?${query}` : '';
}

// =============================================================================
// Query Keys
// =============================================================================

const voipCallKeys = {
  all: ['crm', 'voip-calls'] as const,
  lists: () => [...voipCallKeys.all, 'list'] as const,
  list: (filters?: Record<string, any>) => [...voipCallKeys.lists(), filters] as const,
  detail: (id: string) => [...voipCallKeys.all, 'detail', id] as const,
  stats: () => [...voipCallKeys.all, 'stats'] as const,
  phoneNumbers: () => [...voipCallKeys.all, 'phone-numbers'] as const,
  voipConfigured: () => [...voipCallKeys.all, 'configured'] as const,
  transcription: (callId: string) => [...voipCallKeys.all, callId, 'transcription'] as const,
  transcriptionStatus: (callId: string) => [...voipCallKeys.all, callId, 'transcription-status'] as const,
};

// =============================================================================
// Queries
// =============================================================================

export function useVoipCalls(filters?: CallFilters) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: voipCallKeys.list(filters),
    queryFn: async () => {
      const client = await getClient();
      const qs: Record<string, unknown> = { ...((filters ?? {}) as Record<string, unknown>) };
      if (qs.pageSize !== undefined) {
        qs.limit = qs.pageSize;
        delete qs.pageSize;
      }
      delete qs.page;
      const query = buildQueryString(qs);
      return client.get<PaginatedResponse<VoipCall>>(`/calls${query}`);
    },
  });
}

export function useVoipCall(callId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: voipCallKeys.detail(callId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<SingleResponse<VoipCall>>(`/calls/${callId}`);
    },
    enabled: !!callId && enabled,
  });
}

export function useVoipCallStats() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: voipCallKeys.stats(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<SingleResponse<CallStats>>('/call-intelligence/stats');
    },
  });
}

export function useVoipPhoneNumbers() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: voipCallKeys.phoneNumbers(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<SingleResponse<VoipPhoneNumber[]>>('/call-intelligence/phone-numbers');
    },
  });
}

/**
 * "Does this workspace have a usable number?" — NOT the same question as
 * `useVoipConfigured` in `hooks/use-phone-numbers.ts`, which asks whether
 * Telnyx is wired up at the environment level.
 *
 * The legacy `/crm/voip-configured` route answered this by counting active
 * `voipPhoneNumbers` rows server-side. app-api has no such endpoint, so we run
 * the same count client-side off the canonical phone-number list. Keeping the
 * `{ configured }` return shape means the WeldCall gate needs no change.
 */
export function useVoipConfigured() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: voipCallKeys.voipConfigured(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<SingleResponse<VoipPhoneNumber[]>>(
        '/call-intelligence/phone-numbers?status=active',
      );
      return { configured: (result.data ?? []).length > 0 };
    },
  });
}

export function useVoipCallTranscription(callId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: voipCallKeys.transcription(callId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<any>(`/call-intelligence/calls/${callId}/transcription`);
    },
    enabled: !!callId && enabled,
  });
}

function useVoipCallTranscriptionStatus(callId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: voipCallKeys.transcriptionStatus(callId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<any>(`/call-intelligence/calls/${callId}/transcription/status`);
    },
    enabled: !!callId && enabled,
  });
}

// =============================================================================
// Mutations
// =============================================================================

function useInitiateVoipCall() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      toNumber: string;
      fromNumber: string;
      customerId?: string;
      contactId?: string;
      opportunityId?: string;
      enableRecording?: boolean;
    }) => {
      const client = await getClient();
      return client.post<{ data: { id: string } }>('/calls', {
        direction: 'outbound',
        fromNumber: data.fromNumber,
        toNumber: data.toNumber,
        customerId: data.customerId,
        contactId: data.contactId,
        opportunityId: data.opportunityId,
        isRecorded: data.enableRecording ?? true,
        provider: 'telnyx',
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: voipCallKeys.all });
    },
  });
}

function useUpdateVoipCall() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ callId, data }: {
      callId: string;
      data: {
        status?: string;
        answeredAt?: string;
        endedAt?: string;
        duration?: number;
        customerId?: string | null;
        contactId?: string | null;
        opportunityId?: string | null;
        notes?: string;
      };
    }) => {
      const client = await getClient();
      return client.put<{ data: Partial<VoipCall> }>(`/calls/${callId}`, data);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: voipCallKeys.all });
      qc.invalidateQueries({ queryKey: voipCallKeys.detail(variables.callId) });
    },
  });
}

export function useDeleteVoipCall() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (callId: string) => {
      const client = await getClient();
      return client.delete<Record<string, never>>(`/calls/${callId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: voipCallKeys.all });
    },
  });
}

function useLinkVoipCallToCrm() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ callId, data }: {
      callId: string;
      data: {
        customerId?: string | null;
        contactId?: string | null;
        opportunityId?: string | null;
      };
    }) => {
      const client = await getClient();
      return client.put<{ data: Partial<VoipCall> }>(`/calls/${callId}`, data);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: voipCallKeys.all });
      qc.invalidateQueries({ queryKey: voipCallKeys.detail(variables.callId) });
    },
  });
}

/**
 * Queues a transcription for a call. app-api models this as "create the
 * transcription record" (`POST .../transcription`) rather than the legacy
 * verb-style `/transcribe`; the worker picks the pending row up from there.
 */
export function useTranscribeVoipCall() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ callId, language }: { callId: string; language?: string }) => {
      const client = await getClient();
      return client.post<any>(`/call-intelligence/calls/${callId}/transcription`, { language });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: voipCallKeys.transcription(variables.callId) });
      qc.invalidateQueries({ queryKey: voipCallKeys.transcriptionStatus(variables.callId) });
    },
  });
}

// In-call hold/resume is intentionally absent: `/crm/call-intelligence/{hold,
// resume}` are already deleted from api-worker (404 today) and were never ported
// to app-api. The two hooks that wrapped them were private and unreferenced, so
// they generated no traffic and nothing rendered them. Landing hold/resume means
// building the app-api routes first, then re-adding hooks against them.
