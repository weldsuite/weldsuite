/**
 * The project the Overview shows, remembered per workspace in localStorage.
 * Storage can be missing or throw (private windows, blocked site data), so
 * every access is guarded and the page works without it.
 */

const keyFor = (workspaceId: string) => `weldpanel:last-project:${workspaceId}`;

export function readLastProjectId(workspaceId: string | null): string | null {
  if (!workspaceId) return null;
  try {
    return window.localStorage.getItem(keyFor(workspaceId));
  } catch {
    return null;
  }
}

export function writeLastProjectId(workspaceId: string | null, projectId: string): void {
  if (!workspaceId) return;
  try {
    window.localStorage.setItem(keyFor(workspaceId), projectId);
  } catch {
    // Nothing to do: the next visit falls back to the first project.
  }
}

/** The chosen project if it still exists, else the remembered one, else the first. */
export function pickProject<T extends { id: string }>(projects: readonly T[], chosenId: string | null, lastId: string | null): T | undefined {
  return projects.find((p) => p.id === chosenId) ?? projects.find((p) => p.id === lastId) ?? projects[0];
}
