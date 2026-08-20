import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { DataResponse } from '@weldsuite/core-api-client/types';
import type {
  SendcloudConnectInput,
  SendcloudSettingsPublic,
  UpdateSendcloudSettingsInput,
} from '@weldsuite/app-api-client/schemas/sendcloud';

export const sendcloudKeys = {
  all: ['sendcloud'] as const,
  settings: () => [...sendcloudKeys.all, 'settings'] as const,
};

export function useSendcloudSettings() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: sendcloudKeys.settings(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<SendcloudSettingsPublic>>('/sendcloud');
    },
  });
}

export function useConnectSendcloud() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: SendcloudConnectInput) => {
      const client = await getClient();
      return client.put<DataResponse<SendcloudSettingsPublic>>('/sendcloud/connect', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sendcloudKeys.settings() });
    },
  });
}

export function useSyncSendcloud() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      return client.post<DataResponse<SendcloudSettingsPublic>>('/sendcloud/sync', {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sendcloudKeys.settings() });
    },
  });
}

export function useUpdateSendcloudSettings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: UpdateSendcloudSettingsInput) => {
      const client = await getClient();
      return client.patch<DataResponse<SendcloudSettingsPublic>>('/sendcloud', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sendcloudKeys.settings() });
    },
  });
}

export function useDisconnectSendcloud() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      await client.delete('/sendcloud');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sendcloudKeys.settings() });
    },
  });
}
