
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

const profileKeys = {
  all: ['profile'] as const,
  user: () => [...profileKeys.all, 'user'] as const,
  team: () => [...profileKeys.all, 'team'] as const,
  preferences: () => [...profileKeys.all, 'preferences'] as const,
};

function useUserPreferences() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: profileKeys.preferences(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: Record<string, unknown> }>('/user-preferences');
      return result.data;
    },
  });
}

function useUpdateThemePreference() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (theme: 'light' | 'dark' | 'system') => {
      const client = await getClient();
      return client.patch<{ data: { theme: string } }>('/user-preferences/theme', { theme });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: profileKeys.preferences() });
    },
  });
}

function useUpdateUserPreferences() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (preferences: Record<string, any>) => {
      const client = await getClient();
      return client.put<{ data: Record<string, unknown> }>('/user-preferences', preferences);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: profileKeys.preferences() });
    },
  });
}

function useUpdateSidebarAppOrder() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (appOrder: string[]) => {
      const client = await getClient();
      return client.put<{ data: Record<string, unknown> }>('/user-preferences', {
        uiPreferences: { sidebarAppOrder: appOrder },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: profileKeys.preferences() });
    },
  });
}

function useTeamMembers() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: profileKeys.team(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: Record<string, unknown>[] }>('/team-members?limit=100');
      return result.data;
    },
  });
}
