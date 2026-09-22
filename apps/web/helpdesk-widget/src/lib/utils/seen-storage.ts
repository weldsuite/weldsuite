/**
 * Per-visitor "last seen" timestamps, one per conversation, used for the
 * unread badge on the launcher and in the Messages list. Stored locally —
 * read receipts are a client concern until the API grows them.
 */

type SeenMap = Record<string, string>;

const key = (widgetId: string) => `weld_messenger_seen_${widgetId}`;
const memory = new Map<string, SeenMap>();

export function loadSeen(widgetId: string): SeenMap | null {
  try {
    const raw = localStorage.getItem(key(widgetId));
    return raw ? (JSON.parse(raw) as SeenMap) : null;
  } catch {
    return memory.get(widgetId) ?? null;
  }
}

export function saveSeen(widgetId: string, seen: SeenMap): void {
  memory.set(widgetId, seen);
  try {
    localStorage.setItem(key(widgetId), JSON.stringify(seen));
  } catch {
    // storage unavailable (private mode, blocked 3p storage) — memory copy stays
  }
}
