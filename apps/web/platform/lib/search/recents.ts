/**
 * Recent-items store for the global Cmd+K palette.
 * Keyed per workspace; capped at 10 most-recently-used.
 */

import type { SearchEntityType } from '@weldsuite/core-api-client/schemas/search';

export interface RecentItem {
  id: string;
  type: SearchEntityType;
  title: string;
  subtitle?: string | null;
  url: string;
  ts: number;
}

const MAX = 10;
const KEY = (workspaceId: string) => `weldsuite.cmdk.recents.${workspaceId}`;

function isBrowser() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function getRecents(workspaceId: string | null | undefined): RecentItem[] {
  if (!workspaceId || !isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(KEY(workspaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (i): i is RecentItem =>
        i && typeof i.id === 'string' && typeof i.type === 'string' && typeof i.url === 'string',
    );
  } catch {
    return [];
  }
}

export function pushRecent(
  workspaceId: string | null | undefined,
  item: Omit<RecentItem, 'ts'>,
): void {
  if (!workspaceId || !isBrowser()) return;
  try {
    const current = getRecents(workspaceId);
    const filtered = current.filter((r) => !(r.id === item.id && r.type === item.type));
    const next: RecentItem[] = [{ ...item, ts: Date.now() }, ...filtered].slice(0, MAX);
    window.localStorage.setItem(KEY(workspaceId), JSON.stringify(next));
  } catch {
    // ignore quota errors etc.
  }
}

function clearRecents(workspaceId: string | null | undefined): void {
  if (!workspaceId || !isBrowser()) return;
  try {
    window.localStorage.removeItem(KEY(workspaceId));
  } catch {
    // ignore
  }
}
