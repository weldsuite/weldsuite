import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

// =============================================================================
// Types
// =============================================================================

export interface TaskDigestSettings {
  id: string | null;
  enabled: boolean;
  sendHour: number;
  taskTypes: {
    projectTasks: boolean;
    personalTasks: boolean;
  };
  sections: {
    overdue: boolean;
    dueToday: boolean;
    dueThisWeek: boolean;
  };
  createdAt: string | null;
  updatedAt: string | null;
}

export interface UpdateTaskDigestSettings {
  enabled: boolean;
  sendHour: number;
  taskTypes: {
    projectTasks: boolean;
    personalTasks: boolean;
  };
  sections: {
    overdue: boolean;
    dueToday: boolean;
    dueThisWeek: boolean;
  };
}

// =============================================================================
// Query Keys
// =============================================================================

const taskDigestKeys = {
  all: ['task-digest'] as const,
  settings: () => [...taskDigestKeys.all, 'settings'] as const,
};

// =============================================================================
// Queries
// =============================================================================

export function useTaskDigestSettings() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: taskDigestKeys.settings(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: TaskDigestSettings }>('/digest-settings');
      return result.data;
    },
  });
}

// =============================================================================
// Mutations
// =============================================================================

export function useUpdateTaskDigestSettings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: UpdateTaskDigestSettings) => {
      const client = await getClient();
      return client.put<{ data: TaskDigestSettings }>('/digest-settings', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: taskDigestKeys.settings() });
    },
  });
}
