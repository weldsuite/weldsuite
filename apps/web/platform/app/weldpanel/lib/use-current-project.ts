/**
 * The project every analytics page reads. The choice is shared by all pages
 * (and the module header's switcher) through a tiny store, and remembered per
 * workspace by `last-project.ts`. Falls back to the first project.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { useWeldPanelProjects } from '@/hooks/queries/use-weldpanel-queries';
import { pickProject, readLastProjectId, writeLastProjectId } from './last-project';

let chosenId: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): string | null {
  return chosenId;
}

export interface CurrentProject {
  projects: PanelProjectDto[];
  /** The project in use; undefined while loading or when the workspace has none. */
  project: PanelProjectDto | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  select: (projectId: string) => void;
}

export function useCurrentProject(): CurrentProject {
  const workspaceId = useWorkspaceId();
  const { data, isLoading, isError, refetch } = useWeldPanelProjects();
  const chosen = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const projects = useMemo(() => data ?? [], [data]);
  // `chosen` is a dependency on purpose: picking a project writes the remembered one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const lastId = useMemo(() => readLastProjectId(workspaceId), [workspaceId, chosen]);
  const project = pickProject(projects, chosen, lastId);

  const select = useCallback(
    (projectId: string) => {
      chosenId = projectId;
      writeLastProjectId(workspaceId, projectId);
      for (const listener of listeners) listener();
    },
    [workspaceId],
  );

  return { projects, project, isLoading, isError, refetch: () => void refetch(), select };
}

/** Tests: forget the choice between cases. */
export function resetCurrentProjectChoice(): void {
  chosenId = null;
}
