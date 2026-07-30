import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTopic } from '@weldsuite/realtime/react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { Pipeline, PipelineStage } from '@/lib/api/domains/weldcrm';

export type { Pipeline, PipelineStage } from '@/lib/api/domains/weldcrm';

interface ListResponse<T> {
  data: T[];
  pagination?: { totalCount: number; hasMore: boolean; cursor: string | null };
}

interface DetailResponse<T> {
  data: T;
}

export const pipelineKeys = {
  all: ['crm', 'pipelines'] as const,
  lists: () => [...pipelineKeys.all, 'list'] as const,
  detail: (id: string) => [...pipelineKeys.all, 'detail', id] as const,
  stages: () => ['crm', 'pipeline-stages'] as const,
  stagesForPipeline: (pipelineId: string) => [...pipelineKeys.stages(), pipelineId] as const,
  stageDetail: (id: string) => [...pipelineKeys.stages(), 'detail', id] as const,
  fieldVisibility: (pipelineId: string) =>
    [...pipelineKeys.all, 'field-visibility', pipelineId] as const,
};

type PipelineRealtimePayload = { id: string };

function usePipelineLiveSync(): void {
  const qc = useQueryClient();
  const handler = useCallback(
    (event: { event: string; data: PipelineRealtimePayload }) => {
      const id = event.data?.id;
      qc.invalidateQueries({ queryKey: pipelineKeys.all });
      if (event.event === 'deleted' && id) {
        qc.removeQueries({ queryKey: pipelineKeys.detail(id) });
      }
    },
    [qc],
  );
  useTopic<PipelineRealtimePayload>('pipeline', handler);
}

function usePipelineStageLiveSync(): void {
  const qc = useQueryClient();
  const handler = useCallback(
    (event: { event: string; data: { id: string; pipeline?: string } }) => {
      qc.invalidateQueries({ queryKey: pipelineKeys.stages() });
      const pipelineId = event.data?.pipeline;
      if (pipelineId) {
        qc.invalidateQueries({ queryKey: pipelineKeys.stagesForPipeline(pipelineId) });
      }
    },
    [qc],
  );
  useTopic<{ id: string; pipeline?: string }>('pipeline_stage', handler);
}

export function usePipelines() {
  const { getClient } = useAppApiClient();
  usePipelineLiveSync();
  return useQuery({
    queryKey: pipelineKeys.lists(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<ListResponse<Pipeline>>('/pipelines');
    },
  });
}

export function usePipeline(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  usePipelineLiveSync();
  return useQuery({
    queryKey: pipelineKeys.detail(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DetailResponse<Pipeline>>(`/pipelines/${id}`);
    },
    enabled: !!id && enabled,
  });
}

export function usePipelineStages(pipelineId?: string) {
  const { getClient } = useAppApiClient();
  usePipelineStageLiveSync();
  return useQuery({
    queryKey: pipelineId ? pipelineKeys.stagesForPipeline(pipelineId) : pipelineKeys.stages(),
    queryFn: async () => {
      const client = await getClient();
      const query = pipelineId ? `?pipeline=${encodeURIComponent(pipelineId)}` : '';
      return client.get<ListResponse<PipelineStage>>(`/pipeline-stages${query}`);
    },
  });
}

export function useCreatePipeline() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Partial<Pipeline>) => {
      const client = await getClient();
      const res = await client.post<DetailResponse<Pipeline>>('/pipelines', data);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pipelineKeys.all });
    },
  });
}

export function useUpdatePipeline() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<Pipeline> }) => {
      const client = await getClient();
      const res = await client.patch<DetailResponse<Pipeline>>(`/pipelines/${id}`, data);
      return res.data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: pipelineKeys.all });
      qc.invalidateQueries({ queryKey: pipelineKeys.detail(variables.id) });
    },
  });
}

export function useDeletePipeline() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete<void>(`/pipelines/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pipelineKeys.all });
    },
  });
}

export function useCreatePipelineStage() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Partial<PipelineStage>) => {
      const client = await getClient();
      const res = await client.post<DetailResponse<PipelineStage>>('/pipeline-stages', data);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pipelineKeys.stages() });
    },
  });
}