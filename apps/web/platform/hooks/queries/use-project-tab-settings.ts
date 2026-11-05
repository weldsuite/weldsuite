import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  projectTabSettingsOf,
  type ProjectTabSettings,
} from '@weldsuite/app-api-client/schemas/project-tabs';
import type { ApiProject } from '@/app/weldflow/lib/api-client';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { projectKeys, useProject } from './use-projects-queries';

type ProjectDetail = { data: ApiProject };

/** The project's tab settings (`settings.tabs`), read from the project detail. */
export function useProjectTabSettings(projectId: string) {
  const query = useProject(projectId);
  return {
    settings: projectTabSettingsOf(query.data?.data?.settings),
    isLoading: query.isLoading,
  };
}

/**
 * Save the project's tab settings (`PUT /projects/:id/tabs`, written whole).
 * The project detail is updated right away, so the tab bar follows the switch
 * before the server answers, and rolled back when the save fails.
 */
export function useUpdateProjectTabSettings(projectId: string) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  const key = projectKeys.detail(projectId);

  const write = (tabs: ProjectTabSettings) =>
    qc.setQueryData<ProjectDetail>(key, (old) =>
      old?.data ? { ...old, data: { ...old.data, settings: { ...old.data.settings, tabs } } } : old,
    );

  return useMutation({
    // One save at a time: each sends the whole settings, so they must land in order.
    scope: { id: `project-tabs-${projectId}` },
    mutationFn: async (tabs: ProjectTabSettings) => {
      const client = await getClient();
      return client.put<{ data: ProjectTabSettings }>(`/projects/${projectId}/tabs`, tabs);
    },
    onMutate: async (tabs) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ProjectDetail>(key);
      write(tabs);
      return { previous };
    },
    onError: (_error, _tabs, context) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
    onSuccess: (response) => {
      if (response?.data) write(response.data);
    },
  });
}
