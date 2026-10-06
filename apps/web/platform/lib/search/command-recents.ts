/**
 * Pages opened from the command palette, per workspace.
 * Separate from entity recents (`recents.ts`): those are records, these are commands.
 */

export interface RecentCommand {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  ts: number;
}

const MAX = 5;
const KEY = (workspaceId: string) => `weldsuite.cmdk.commands.${workspaceId}`;

function isBrowser() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function getRecentCommands(workspaceId: string | null | undefined): RecentCommand[] {
  if (!workspaceId || !isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(KEY(workspaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RecentCommand =>
        !!item &&
        typeof item.id === 'string' &&
        typeof item.title === 'string' &&
        typeof item.href === 'string',
    );
  } catch {
    return [];
  }
}

export function pushRecentCommand(
  workspaceId: string | null | undefined,
  item: Omit<RecentCommand, 'ts'>,
): void {
  if (!workspaceId || !isBrowser()) return;
  try {
    const current = getRecentCommands(workspaceId);
    const filtered = current.filter((recent) => recent.id !== item.id);
    const next: RecentCommand[] = [{ ...item, ts: Date.now() }, ...filtered].slice(0, MAX);
    window.localStorage.setItem(KEY(workspaceId), JSON.stringify(next));
  } catch {
    // ignore quota errors
  }
}
