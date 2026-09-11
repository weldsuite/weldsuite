/**
 * Next-conversation helpers for WeldMail triage (Check = archive and open
 * the following row, matching web `getNextThreadHref`).
 *
 * The visible list lives in a module snapshot so the phone detail route can
 * read it without a context provider. Inbox and search publish on render /
 * focus; the snapshot is only consulted at tap time.
 */

export function getNextEmailId(ids: readonly string[], currentId: string): string | null {
  const index = ids.indexOf(currentId);
  if (index < 0) return null;
  return ids[index + 1] ?? null;
}

export function idsFromSections(sections: ReadonlyArray<{ data: ReadonlyArray<{ id: string }> }>): string[] {
  return sections.flatMap((section) => section.data.map((item) => item.id));
}

let visibleIds: string[] = [];

export function setVisibleMessageIds(ids: readonly string[]): void {
  visibleIds = ids.slice();
}

export function getVisibleMessageIds(): readonly string[] {
  return visibleIds;
}

export function getNextVisibleMessageId(currentId: string): string | null {
  return getNextEmailId(visibleIds, currentId);
}
