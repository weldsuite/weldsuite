import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTopic } from '@weldsuite/realtime/react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { Pipeline, PipelineStage } from '@/lib/api/domains/weldcrm';
import type {
  PipelineFieldVisibility,
  UpdatePipelineFieldVisibilityInput,
} from '@weldsuite/app-api-client/schemas/pipeline-field-visibility';

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

function useUpdatePipelineStage() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<PipelineStage> }) => {
      const client = await getClient();
      const res = await client.patch<DetailResponse<PipelineStage>>(`/pipeline-stages/${id}`, data);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pipelineKeys.stages() });
    },
  });
}

function useDeletePipelineStage() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete<void>(`/pipeline-stages/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pipelineKeys.stages() });
    },
  });
}

function useReorderPipelineStages() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (stageIds: string[]) => {
      const client = await getClient();
      await client.post<DetailResponse<{ ok: boolean }>>('/pipeline-stages/reorder', { stageIds });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pipelineKeys.stages() });
    },
  });
}

/**
 * Duplicate by reading the pipeline + its stages and creating fresh copies.
 * Composite client-side because app-api has no /pipelines/:id/duplicate endpoint.
 */
function useDuplicatePipeline() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, newName }: { id: string; newName?: string }) => {
      const client = await getClient();
      const source = await client.get<DetailResponse<Pipeline>>(`/pipelines/${id}`);
      const stages = await client.get<ListResponse<PipelineStage>>(
        `/pipeline-stages?pipeline=${encodeURIComponent(id)}`,
      );
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = source.data as any;
      const created = await client.post<DetailResponse<Pipeline>>('/pipelines', {
        ...rest,
        name: newName || `${(source.data as any).name} (Copy)`,
      });
      const newId = (created.data as any).id as string;
      for (const stage of stages.data) {
        const { id: _sid, createdAt: _sc, updatedAt: _su, pipelineId: _pid, ...stageRest } = stage as any;
        await client.post('/pipeline-stages', { ...stageRest, pipelineId: newId });
      }
      return created.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pipelineKeys.all });
    },
  });
}

function useExportPipeline() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      const pipeline = await client.get<DetailResponse<Pipeline>>(`/pipelines/${id}`);
      const stages = await client.get<ListResponse<PipelineStage>>(
        `/pipeline-stages?pipeline=${encodeURIComponent(id)}`,
      );
      return { data: { pipeline: pipeline.data, stages: stages.data } };
    },
  });
}

interface PipelineFilter {
  workspaceId: string;
  search?: string;
  stage?: string;
  assignedTo?: string;
  minValue?: number;
  maxValue?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

function useFetchPipelineDeals() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (filter: PipelineFilter) => {
      const client = await getClient();
      const params = new URLSearchParams();
      if (filter.search) params.set('search', filter.search);
      if (filter.stage && filter.stage !== 'all') params.set('stage', filter.stage);
      if (filter.assignedTo && filter.assignedTo !== 'all') params.set('ownerId', filter.assignedTo);
      params.set('limit', String(filter.limit ?? 100));
      const result = await client.get<ListResponse<any>>(`/opportunities?${params.toString()}`);

      let deals = result.data ?? [];

      if (filter.minValue !== undefined) {
        deals = deals.filter((d: any) => parseFloat(d.amount) >= filter.minValue!);
      }
      if (filter.maxValue !== undefined) {
        deals = deals.filter((d: any) => parseFloat(d.amount) <= filter.maxValue!);
      }
      if (filter.sortBy) {
        deals = [...deals].sort((a: any, b: any) => {
          let aVal: any = a[filter.sortBy!];
          let bVal: any = b[filter.sortBy!];
          if (filter.sortBy === 'value') {
            aVal = parseFloat(a.amount) || 0;
            bVal = parseFloat(b.amount) || 0;
          }
          if (filter.sortBy === 'createdAt' || filter.sortBy === 'closeDate') {
            aVal = new Date(aVal).getTime();
            bVal = new Date(bVal).getTime();
          }
          if (filter.sortOrder === 'asc') return aVal > bVal ? 1 : -1;
          return aVal < bVal ? 1 : -1;
        });
      }

      const allDeals = result.data ?? [];
      const counts = {
        total: allDeals.length,
        prospecting: allDeals.filter((d: any) => d.stage === 'prospecting').length,
        qualified: allDeals.filter((d: any) => d.stage === 'qualification' || d.stage === 'qualified').length,
        proposal: allDeals.filter((d: any) => d.stage === 'proposal').length,
        negotiation: allDeals.filter((d: any) => d.stage === 'negotiation').length,
        closed: allDeals.filter((d: any) => d.stage === 'closed_won' || d.status === 'won').length,
        lost: allDeals.filter((d: any) => d.stage === 'closed_lost' || d.status === 'lost').length,
      };

      const transformedDeals = deals.map((deal: any) => ({
        id: deal.id,
        name: deal.name,
        value: parseFloat(deal.amount) || 0,
        stage: deal.stage?.toUpperCase() || 'PROSPECTING',
        probability: deal.probability || 0,
        createdAt: deal.createdAt,
        closeDate: deal.closeDate,
        company: deal.customerName ? { name: deal.customerName } : null,
        contact: null,
        owner: deal.ownerId ? { email: deal.ownerId } : null,
        activities: [],
      }));

      return {
        deals: transformedDeals,
        pagination: {
          page: 1,
          limit: filter.limit ?? 100,
          totalCount: result.pagination?.totalCount ?? deals.length,
          totalPages: 1,
          hasMore: result.pagination?.hasMore ?? false,
        },
        counts,
      };
    },
  });
}

// Field visibility — GET/PATCH /api/pipeline-field-visibility/:id/field-visibility
// on app-api (apps/workers/app-api/src/routes/pipeline-field-visibility).
function usePipelineFieldVisibility(pipelineId: string | undefined, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: pipelineId
      ? pipelineKeys.fieldVisibility(pipelineId)
      : ['crm', 'pipelines', 'field-visibility', 'none'],
    queryFn: async () => {
      const client = await getClient();
      return client.get<DetailResponse<PipelineFieldVisibility>>(
        `/pipeline-field-visibility/${pipelineId as string}/field-visibility`,
      );
    },
    enabled: !!pipelineId && enabled,
    staleTime: 60 * 1000,
  });
}

function useUpdatePipelineFieldVisibility(pipelineId: string) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: UpdatePipelineFieldVisibilityInput) => {
      const client = await getClient();
      return client.patch<DetailResponse<PipelineFieldVisibility>>(
        `/pipeline-field-visibility/${pipelineId}/field-visibility`,
        data,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pipelineKeys.fieldVisibility(pipelineId) });
    },
  });
}

function useExportPipelineDeals() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (filter: Omit<PipelineFilter, 'limit' | 'sortBy' | 'sortOrder'>) => {
      const client = await getClient();
      const params = new URLSearchParams();
      if (filter.search) params.set('search', filter.search);
      if (filter.stage && filter.stage !== 'all') params.set('stage', filter.stage);
      if (filter.assignedTo && filter.assignedTo !== 'all') params.set('ownerId', filter.assignedTo);
      params.set('limit', '1000');
      return client.get<ListResponse<any>>(`/opportunities?${params.toString()}`);
    },
  });
}
