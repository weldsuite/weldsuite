/** The Notes tab's sections. */

import type { NoteRecord } from '@/services/notes';
import { isToday, startOfDay } from './dates';

export type SectionKey = 'pinned' | 'today' | 'yesterday' | 'earlier';

/** Pinned notes first, then by the day they were last changed (like the web's Notes page). */
export function groupNotes(notes: readonly NoteRecord[], now: Date = new Date()): { key: SectionKey; data: NoteRecord[] }[] {
  // Calendar arithmetic, not "minus 24 hours", so a DST change can't skip a day.
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const sections: Record<SectionKey, NoteRecord[]> = { pinned: [], today: [], yesterday: [], earlier: [] };
  for (const note of notes) {
    const updated = new Date(note.updatedAt);
    if (note.isFavorite) sections.pinned.push(note);
    else if (isToday(updated, now)) sections.today.push(note);
    else if (startOfDay(updated).getTime() === yesterday.getTime()) sections.yesterday.push(note);
    else sections.earlier.push(note);
  }
  return (['pinned', 'today', 'yesterday', 'earlier'] as const)
    .map((key) => ({ key, data: sections[key] }))
    .filter((section) => section.data.length > 0);
}
