import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api';

export type UserAppVisibility = 'private' | 'public';
export type UserAppReviewStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface UserApp {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  category?: string | null;
  visibility: UserAppVisibility;
  reviewStatus: UserAppReviewStatus;
  reviewNotes?: string | null;
  currentVersionId?: string | null;
  requestedScopes: string[];
  pricingType: string;
  websiteUrl?: string | null;
  privacyUrl?: string | null;
  screenshots?: string[] | null;
  webhookUrl?: string | null;
  installCount: number;
  isActive: boolean;
  createdAt: string;
}

export interface UserAppVersion {
  version: string;
  status: string;
  changelog?: string | null;
  bundleSize?: number | null;
  fileCount?: number | null;
  createdAt: string;
  publishedAt?: string | null;
}

export interface CreateUserAppInput {
  code: string;
  name: string;
  description?: string;
  icon?: string;
  category?: string;
}

export interface UserAppOauthClient {
  clientId: string;
}

export interface UserAppOauthClientCreated {
  clientId: string;
  clientSecret: string;
}

export const userAppsKeys = {
  all: ['user-apps'] as const,
  mine: () => [...userAppsKeys.all, 'mine'] as const,
  detail: (id: string) => [...userAppsKeys.all, 'detail', id] as const,
  versions: (id: string) => [...userAppsKeys.all, id, 'versions'] as const,
  oauthClient: (id: string) => [...userAppsKeys.all, id, 'oauth-client'] as const,
};

export function useMyUserApps(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: userAppsKeys.mine(),
    enabled,
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: UserApp[] }>('/user-apps');
      return result.data;
    },
  });
}

export function useUserApp(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: userAppsKeys.detail(id),
    enabled: !!id && enabled,
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: UserApp }>(`/user-apps/${id}`);
      return result.data;
    },
  });
}

export function useUserAppVersions(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: userAppsKeys.versions(id),
    enabled: !!id && enabled,
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: UserAppVersion[] }>(`/user-apps/${id}/versions`);
      return result.data;
    },
  });
}

export function useUserAppOauthClient(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: userAppsKeys.oauthClient(id),
    enabled: !!id && enabled,
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: UserAppOauthClient | null }>(
        `/user-apps/${id}/oauth-client`,
      );
      return result.data;
    },
  });
}

export function useCreateUserApp() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateUserAppInput) => {
      const client = await getClient();
      const result = await client.post<{ data: UserApp }>('/user-apps', data);
      return result.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: userAppsKeys.mine() });
    },
  });
}

export function useUpdateUserApp() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<CreateUserAppInput> }) => {
      const client = await getClient();
      const result = await client.patch<{ data: UserApp }>(`/user-apps/${id}`, data);
      return result.data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: userAppsKeys.detail(variables.id) });
      qc.invalidateQueries({ queryKey: userAppsKeys.mine() });
    },
  });
}

export function useDeleteUserApp() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete<void>(`/user-apps/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: userAppsKeys.mine() });
    },
  });
}

export function useSubmitUserApp() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, notes }: { id: string; notes?: string }) => {
      const client = await getClient();
      const result = await client.post<{ data: UserApp }>(`/user-apps/${id}/submit`, { notes });
      return result.data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: userAppsKeys.detail(variables.id) });
      qc.invalidateQueries({ queryKey: userAppsKeys.mine() });
    },
  });
}

export function useCreateUserAppOauthClient() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      const result = await client.post<{ data: UserAppOauthClientCreated }>(
        `/user-apps/${id}/oauth-client`,
      );
      return result.data;
    },
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: userAppsKeys.oauthClient(id) });
    },
  });
}
