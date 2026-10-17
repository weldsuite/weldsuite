/**
 * Element-level merge helpers for the collaborative whiteboard.
 *
 * The whiteboard is saved as one `elements[]` array. Without these helpers every client
 * overwrote the stored scene wholesale (last writer wins) and undo restored a full
 * snapshot, which deleted collaborators' work. Everything here works per element id:
 *
 * - `diffElements` / `applyDelta` express a local edit as a delta, so undo/redo only
 *   touches the elements the local user changed.
 * - `applyRemote*` apply a collaborator's operation to the live scene AND to every
 *   history snapshot, which keeps remote operations out of the local undo stack.
 * - `mergeScenes` three-way merges (base, local, server) before a save, so a save never
 *   deletes or reverts an element somebody else changed.
 */

export interface SceneElement {
  id: string;
}

export interface ElementDelta<T extends SceneElement> {
  /** Elements present in `to` but not in `from`, with the index they had in `to`. */
  added: { element: T; index: number }[];
  /** Ids present in `from` but not in `to`. */
  removed: string[];
  /** Elements present in both whose content differs; carries the `to` version. */
  changed: T[];
}

const serialize = (element: unknown): string => JSON.stringify(element);

function indexById<T extends SceneElement>(elements: readonly T[]): Map<string, T> {
  return new Map(elements.map((el) => [el.id, el]));
}

/** The delta that turns `from` into `to`. */
export function diffElements<T extends SceneElement>(from: readonly T[], to: readonly T[]): ElementDelta<T> {
  const fromById = indexById(from);
  const toIds = new Set(to.map((el) => el.id));
  const delta: ElementDelta<T> = { added: [], removed: [], changed: [] };

  to.forEach((element, index) => {
    const before = fromById.get(element.id);
    if (!before) {
      delta.added.push({ element, index });
    } else if (before !== element && serialize(before) !== serialize(element)) {
      delta.changed.push(element);
    }
  });
  for (const el of from) {
    if (!toIds.has(el.id)) delta.removed.push(el.id);
  }
  return delta;
}

export function isEmptyDelta<T extends SceneElement>(delta: ElementDelta<T>): boolean {
  return delta.added.length === 0 && delta.removed.length === 0 && delta.changed.length === 0;
}

/**
 * Apply a delta to `elements`. Elements the delta does not mention keep their current
 * state, so a collaborator's edits survive. A changed element that no longer exists (a
 * collaborator deleted it) is not resurrected.
 */
export function applyDelta<T extends SceneElement>(elements: readonly T[], delta: ElementDelta<T>): T[] {
  if (isEmptyDelta(delta)) return elements as T[];
  const removed = new Set(delta.removed);
  const changed = indexById(delta.changed);
  const result: T[] = [];
  for (const el of elements) {
    if (removed.has(el.id)) continue;
    result.push(changed.get(el.id) ?? el);
  }
  const present = new Set(result.map((el) => el.id));
  const additions = [...delta.added].sort((a, b) => a.index - b.index);
  for (const { element, index } of additions) {
    if (present.has(element.id)) continue;
    result.splice(Math.min(index, result.length), 0, element);
    present.add(element.id);
  }
  return result;
}

/** A collaborator added an element. Ignores ids that are already on the board. */
export function applyRemoteAdd<T extends SceneElement>(elements: readonly T[], element: T): T[] {
  if (elements.some((el) => el.id === element.id)) return elements as T[];
  return [...elements, element];
}

/** A collaborator changed some properties of an element. */
export function applyRemoteUpdate<T extends SceneElement>(
  elements: readonly T[],
  elementId: string,
  changes: Partial<T>,
): T[] {
  if (!elements.some((el) => el.id === elementId)) return elements as T[];
  return elements.map((el) => (el.id === elementId ? { ...el, ...changes } : el));
}

/** A collaborator deleted an element. */
export function applyRemoteDelete<T extends SceneElement>(elements: readonly T[], elementId: string): T[] {
  if (!elements.some((el) => el.id === elementId)) return elements as T[];
  return elements.filter((el) => el.id !== elementId);
}

/**
 * Three-way merge of the scene the user is about to save.
 *
 * - `base`: the scene as last loaded/saved by this client.
 * - `local`: what this client wants to save.
 * - `server`: what is stored right now (may contain collaborators' saves).
 *
 * An element the local user touched (added, changed, deleted) wins; every other element
 * takes the server's version, including deletions and additions made by collaborators.
 * Order follows the local scene; elements only the server knows are appended.
 */
export function mergeScenes<T extends SceneElement>(base: readonly T[], local: readonly T[], server: readonly T[]): T[] {
  const baseById = indexById(base);
  const localById = indexById(local);
  const serverById = indexById(server);

  const touchedLocally = (id: string): boolean => {
    const before = baseById.get(id);
    const now = localById.get(id);
    if (!before || !now) return before !== now;
    return before !== now && serialize(before) !== serialize(now);
  };

  const merged: T[] = [];
  const seen = new Set<string>();

  for (const el of local) {
    seen.add(el.id);
    if (touchedLocally(el.id)) {
      merged.push(el);
      continue;
    }
    // Untouched locally: the server decides (it may have changed or deleted it).
    const theirs = serverById.get(el.id);
    if (theirs) merged.push(theirs);
  }
  for (const el of server) {
    if (seen.has(el.id)) continue;
    // Deleted locally (in base, absent from local): keep it deleted.
    if (baseById.has(el.id) && !localById.has(el.id)) continue;
    merged.push(el);
  }
  return merged;
}
