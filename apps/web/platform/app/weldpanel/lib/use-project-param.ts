/**
 * Pages that can be linked to with `?project=` (a recordings link from a
 * funnel, an email) switch the shared project to it once, when it is one the
 * workspace has. Later switches from the project bar are left alone.
 */

import { useEffect, useRef } from 'react';
import { useCurrentProject } from './use-current-project';

export function useProjectParam(projectId: string | undefined): void {
  const { projects, project, select } = useCurrentProject();
  const applied = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!projectId || applied.current === projectId || projects.length === 0) return;
    applied.current = projectId;
    if (project?.id !== projectId && projects.some((p) => p.id === projectId)) select(projectId);
  }, [projectId, projects, project, select]);
}
