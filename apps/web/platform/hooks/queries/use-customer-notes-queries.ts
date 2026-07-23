
import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTopic } from '@weldsuite/realtime/react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { companyKeys } from '@/components/objects/company/use-company-data';
import { personKeys } from '@/components/objects/person/use-person-data';
import { activityKeys } from './use-activities-queries';

function useCustomerNoteAndCommentLiveSync(): void {
  const qc = useQueryClient();
  const handler = useCallback(
    (_event: { event: string; data: { id: string; type?: string } }) => {
      qc.invalidateQueries({ queryKey: customerNoteKeys.all });
      qc.invalidateQueries({ queryKey: customerCommentKeys.all });
    },
    [qc],
  );
  useTopic<{ id: string; type?: string }>('activity', handler);
}

const customerNoteKeys = {
  all: ['crm', 'customer-notes'] as const,
  list: (customerId: string) => [...customerNoteKeys.all, customerId] as const,
};

function useCustomerNotes(customerId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  useCustomerNoteAndCommentLiveSync();
  return useQuery({
    queryKey: customerNoteKeys.list(customerId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any[] }>(
        `/activities?customerId=${encodeURIComponent(customerId)}&type=note`,
      );
    },
    enabled: !!customerId && enabled,
  });
}

export function useCreateCustomerNote() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      customerId,
      content,
      entityType,
    }: {
      customerId: string;
      content: string;
      entityType?: 'customer' | 'contact';
    }) => {
      const client = await getClient();
      const activityData: Record<string, any> = {
        type: 'note',
        subject: 'Note',
        description: content,
        status: 'completed',
      };
      if (entityType === 'contact') {
        activityData.contactId = customerId;
      } else {
        activityData.customerId = customerId;
      }
      const res = await client.post<{ data: { id: string } }>('/activities', activityData);
      return res.data;
    },
    onSuccess: (_data, variables) => {
      if (variables.entityType === 'contact') {
        qc.invalidateQueries({ queryKey: personKeys.detail(variables.customerId) });
      } else {
        qc.invalidateQueries({ queryKey: companyKeys.detail(variables.customerId) });
      }
      qc.invalidateQueries({ queryKey: activityKeys.all });
      qc.invalidateQueries({ queryKey: customerNoteKeys.all });
    },
  });
}

export function useUpdateCustomerNote() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      noteId,
      content,
    }: {
      noteId: string;
      customerId: string;
      content: string;
    }) => {
      const client = await getClient();
      const res = await client.patch<{ data: { id: string } }>(`/activities/${noteId}`, {
        description: content,
      });
      return res.data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: companyKeys.detail(variables.customerId) });
      qc.invalidateQueries({ queryKey: activityKeys.all });
      qc.invalidateQueries({ queryKey: customerNoteKeys.all });
    },
  });
}

export function useDeleteCustomerNote() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ noteId }: { noteId: string; customerId: string }) => {
      const client = await getClient();
      await client.delete<void>(`/activities/${noteId}`);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: companyKeys.detail(variables.customerId) });
      qc.invalidateQueries({ queryKey: activityKeys.all });
      qc.invalidateQueries({ queryKey: customerNoteKeys.all });
    },
  });
}

// Comments are stored as activities of type 'comment'

const customerCommentKeys = {
  all: ['crm', 'customer-comments'] as const,
  list: (entityId: string, entityType: string) =>
    [...customerCommentKeys.all, entityType, entityId] as const,
};

export function useCustomerComments(
  entityId: string,
  entityType: 'customer' | 'contact' = 'customer',
  enabled = true,
) {
  const { getClient } = useAppApiClient();
  useCustomerNoteAndCommentLiveSync();
  const param = entityType === 'contact' ? 'contactId' : 'customerId';
  return useQuery({
    queryKey: customerCommentKeys.list(entityId, entityType),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any[] }>(
        `/activities?${param}=${encodeURIComponent(entityId)}&type=comment`,
      );
    },
    enabled: !!entityId && enabled,
  });
}

export function useCreateCustomerComment() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      entityId,
      content,
      entityType = 'customer',
    }: {
      entityId: string;
      content: string;
      entityType?: 'customer' | 'contact';
    }) => {
      const client = await getClient();
      const activityData: Record<string, any> = {
        type: 'comment',
        subject: 'Comment',
        description: content,
        status: 'completed',
      };
      if (entityType === 'contact') {
        activityData.contactId = entityId;
      } else {
        activityData.customerId = entityId;
      }
      const res = await client.post<{ data: { id: string } }>('/activities', activityData);
      return res.data;
    },
    onSuccess: (_data, variables) => {
      const et = variables.entityType ?? 'customer';
      if (et === 'contact') {
        qc.invalidateQueries({ queryKey: personKeys.detail(variables.entityId) });
      } else {
        qc.invalidateQueries({ queryKey: companyKeys.detail(variables.entityId) });
      }
      qc.invalidateQueries({ queryKey: activityKeys.all });
      qc.invalidateQueries({ queryKey: customerCommentKeys.all });
    },
  });
}
