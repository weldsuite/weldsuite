/**
 * Announcements the visitor closed, per widget. Kept in localStorage, with a
 * memory copy for when storage is blocked (private mode, partitioned
 * third-party storage), so a closed banner at least stays closed on this page.
 */

const key = (widgetId: string) => `weld_messenger_dismissed_${widgetId}`;
/** Enough for every banner a widget shows at once; older ids fall off. */
const MAX_REMEMBERED = 100;
const memory = new Map<string, string[]>();

export function loadDismissed(widgetId: string): string[] {
  try {
    const raw = localStorage.getItem(key(widgetId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return memory.get(widgetId) ?? [];
  }
}

export function dismiss(widgetId: string, id: string): string[] {
  const next = [...loadDismissed(widgetId).filter((known) => known !== id), id].slice(-MAX_REMEMBERED);
  memory.set(widgetId, next);
  try {
    localStorage.setItem(key(widgetId), JSON.stringify(next));
  } catch {
    // storage unavailable — memory copy stays
  }
  return next;
}
