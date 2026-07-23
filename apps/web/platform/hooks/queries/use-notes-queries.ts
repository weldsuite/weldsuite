import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTopic } from '@weldsuite/realtime/react';
import type { z } from 'zod';
import {
  createActivitySchema,
  updateActivitySchema,
} from '@weldsuite/core-api-client/schemas/activities';
import { useAppApiClient } from '@/lib/api/use-app-api';

type CreateActivityInput = z.infer<typeof createActivitySchema>;
type UpdateActivityInput = z.infer<typeof updateActivitySchema>;

type RecordKind = 'company' | 'person';

export interface CreateNoteInput {
  subject?: string;
  description?: string;
  /** What the note is attached to. */
  recordKind?: RecordKind;
  recordId?: string;
  recordName?: string;
  /** Optional CRM joins kept on the wire. */
  leadId?: string;
  opportunityId?: string;
}

export interface UpdateNoteInput {
  subject?: string;
  description?: string;
}

export interface NoteFilters {
  companyId?: string;
  personId?: string;
  leadId?: string;
  opportunityId?: string;
  assignedToId?: string;
  search?: string;
  limit?: number;
  cursor?: string;
}

interface ListNotesResponse {
  data: Array<Record<string, any>>;
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

interface CreateNoteResponse {
  data: { id: string };
}

interface NoteDetailResponse {
  data: Record<string, any>;
}

const notesKeys = {
  all: ['notes'] as const,
  lists: () => [...notesKeys.all, 'list'] as const,
  list: (filters?: NoteFilters) => [...notesKeys.lists(), filters] as const,
  details: () => [...notesKeys.all, 'detail'] as const,
  detail: (id: string) => [...notesKeys.details(), id] as const,
};

/**
 * The wire schema still calls these `customerId` / `contactId` because the
 * `crm_activities` table hasn't been renamed. We translate clean UI names to
 * those wire names at the boundary so callers never see the legacy vocab.
 */
function toWireFilters(filters: NoteFilters | undefined): URLSearchParams {
  const params = new URLSearchParams();
  params.set('type', 'note');
  if (!filters) return params;
  const { companyId, personId, leadId, opportunityId, assignedToId, search, limit, cursor } =
    filters;
  if (companyId) params.set('customerId', companyId);
  if (personId) params.set('contactId', personId);
  if (leadId) params.set('leadId', leadId);
  if (opportunityId) params.set('opportunityId', opportunityId);
  if (assignedToId) params.set('assignedToId', assignedToId);
  if (search) params.set('search', search);
  if (limit !== undefined) params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  return params;
}

function toCreatePayload(input: CreateNoteInput): CreateActivityInput {
  const payload: CreateActivityInput = {
    type: 'note',
    subject: input.subject ?? 'Note',
    description: input.description,
    leadId: input.leadId,
    opportunityId: input.opportunityId,
  };
  if (input.recordKind === 'company' && input.recordId) {
    payload.customerId = input.recordId;
    payload.relatedTo = 'company';
    payload.relatedToId = input.recordId;
    payload.relatedToName = input.recordName;
  } else if (input.recordKind === 'person' && input.recordId) {
    payload.contactId = input.recordId;
    payload.relatedTo = 'person';
    payload.relatedToId = input.recordId;
    payload.relatedToName = input.recordName;
  }
  return payload;
}

function toUpdatePayload(input: UpdateNoteInput): UpdateActivityInput {
  return {
    subject: input.subject,
    description: input.description,
  };
}

function useNoteLiveSync(): void {
  const qc = useQueryClient();
  const handler = useCallback(
    (event: { event: string; data: { id: string; type?: string } }) => {
      const id = event.data?.id;
      qc.invalidateQueries({ queryKey: notesKeys.all });
      if (event.event === 'deleted' && id) {
        qc.removeQueries({ queryKey: notesKeys.detail(id) });
      }
    },
    [qc],
  );
  useTopic<{ id: string; type?: string }>('activity', handler);
}

export function useNotes(filters?: NoteFilters) {
  const { getClient } = useAppApiClient();
  useNoteLiveSync();
  return useQuery({
    queryKey: notesKeys.list(filters),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListNotesResponse>(`/activities?${toWireFilters(filters).toString()}`);
    },
  });
}

function useNote(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  useNoteLiveSync();
  return useQuery({
    queryKey: notesKeys.detail(id),
    enabled: !!id && enabled,
    queryFn: async () => {
      const client = await getClient();
      return client.get<NoteDetailResponse>(`/activities/${id}`);
    },
  });
}

export function useCreateNote() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateNoteInput) => {
      const client = await getClient();
      const res = await client.post<CreateNoteResponse>('/activities', toCreatePayload(input));
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notesKeys.all });
    },
  });
}

export function useUpdateNote() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateNoteInput }) => {
      const client = await getClient();
      const res = await client.patch<{ data: { id: string } }>(`/activities/${id}`, toUpdatePayload(data));
      return res.data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: notesKeys.all });
      qc.invalidateQueries({ queryKey: notesKeys.detail(vars.id) });
    },
  });
}

/**
 * Toggle the favorite/starred flag on a note. Backed by the `isFavorite`
 * column on `crm_activities` — persists across reloads (unlike the previous
 * local-state-only handler).
 */
export function useToggleNoteFavorite() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, isFavorite }: { id: string; isFavorite: boolean }) => {
      const client = await getClient();
      const res = await client.patch<{ data: { id: string } }>(`/activities/${id}`, {
        isFavorite,
      });
      return res.data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: notesKeys.all });
      qc.invalidateQueries({ queryKey: notesKeys.detail(vars.id) });
    },
  });
}

export function useDeleteNote() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete<void>(`/activities/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notesKeys.all });
    },
  });
}
