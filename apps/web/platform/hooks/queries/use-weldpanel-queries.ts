/**
 * WeldPanel hooks (phase 1, collect): the project list, one project, the
 * install check and the project mutations. Keys build on `weldpanelKeys.all`,
 * the root a realtime sync entry for `panel_project` would invalidate.
 *
 * The install check is nested under its project, so anything that refreshes
 * the project (a rotated token changes the snippet) refreshes it too. It is
 * live data and polls while the project is still waiting for its first event,
 * which is why it stays out of the persisted query cache.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type {
  CreatePanelProjectInput,
  PanelProjectDto,
  UpdatePanelProjectInput,
  UpdatePanelProjectSettingsInput,
} from '@weldsuite/app-api-client/schemas/weldpanel';

export const weldpanelKeys = {
  all: ['weldpanel'] as const,
  projects: () => [...weldpanelKeys.all, 'projects'] as const,
  projectList: () => [...weldpanelKeys.projects(), 'list'] as const,
  project: (id: string) => [...weldpanelKeys.projects(), 'detail', id] as const,
  /** Nested under the project: invalidating the project refreshes the install check too. */
  install: (id: string) => [...weldpanelKeys.project(id), 'install'] as const,
};

/** How often the install check runs while no event has arrived yet. */
export const INSTALL_POLL_MS = 10_000;

export function useWeldPanelProjects() {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.projectList(),
    queryFn: () => weldpanel.projects.list(),
    select: (res) => res.data,
  });
}

export function useWeldPanelProject(id: string) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.project(id),
    queryFn: () => weldpanel.projects.get(id),
    select: (res) => res.data,
    enabled: id !== '',
  });
}

/**
 * Whether events have arrived for a project, with the snippets to paste.
 * Re-checks every 10 seconds until the first event is in, then stops.
 */
export function useWeldPanelInstall(id: string, enabled = true) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelKeys.install(id),
    queryFn: () => weldpanel.projects.install(id),
    select: (res) => res.data,
    enabled: enabled && id !== '',
    refetchInterval: (query) => (query.state.data?.data.status === 'waiting' ? INSTALL_POLL_MS : false),
    // The status changes by the minute: a copy restored from storage would show a stale one.
    meta: { persist: false },
  });
}

/** Puts a changed project in the cache and refreshes the list it appears in. */
function useStoreProject() {
  const queryClient = useQueryClient();
  return (project: PanelProjectDto) => {
    queryClient.setQueryData(weldpanelKeys.project(project.id), { data: project });
    void queryClient.invalidateQueries({ queryKey: weldpanelKeys.projectList() });
  };
}

export function useCreateWeldPanelProject() {
  const { weldpanel } = useAppApi();
  const store = useStoreProject();
  return useMutation({
    mutationFn: (input: CreatePanelProjectInput) => weldpanel.projects.create(input).then((res) => res.data),
    onSuccess: store,
  });
}

/** Name, type and allowed domains (`panel_projects:update`). */
export function useUpdateWeldPanelProject(id: string) {
  const { weldpanel } = useAppApi();
  const store = useStoreProject();
  return useMutation({
    mutationFn: (input: UpdatePanelProjectInput) => weldpanel.projects.update(id, input).then((res) => res.data),
    onSuccess: store,
  });
}

/** Collector and privacy settings, and pausing or resuming (`panel_projects:manage`). */
export function useUpdateWeldPanelProjectSettings(id: string) {
  const { weldpanel } = useAppApi();
  const store = useStoreProject();
  return useMutation({
    mutationFn: (input: UpdatePanelProjectSettingsInput) => weldpanel.projects.updateSettings(id, input).then((res) => res.data),
    onSuccess: store,
  });
}

/** A new token: the old snippet stops working at once, so the install check and snippets are refetched. */
export function useRotateWeldPanelToken(id: string) {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  const store = useStoreProject();
  return useMutation({
    mutationFn: () => weldpanel.projects.rotateToken(id).then((res) => res.data),
    onSuccess: (project) => {
      store(project);
      void queryClient.invalidateQueries({ queryKey: weldpanelKeys.install(id) });
    },
  });
}

export function useDeleteWeldPanelProject() {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldpanel.projects.remove(id),
    onSuccess: (_void, id) => {
      queryClient.removeQueries({ queryKey: weldpanelKeys.project(id) });
      void queryClient.invalidateQueries({ queryKey: weldpanelKeys.projectList() });
    },
  });
}
