/**
 * How each item type looks: its letter and tone (`GlyphBadge`), and how to
 * read a task's free-text `type` column as one of the known types.
 */

import type { GlyphTone } from '@weldsuite/ui/components/glyph-badge';
import {
  CONTAINER_ITEM_TYPES,
  ITEM_TYPES,
  type ItemType,
  type ItemTypeNaming,
} from '@weldsuite/app-api-client/schemas/flow-agile';

export const ITEM_TYPE_TONES: Record<ItemType, GlyphTone> = {
  epic: 'violet',
  feature: 'pink',
  story: 'green',
  bug: 'red',
  task: 'blue',
  spike: 'amber',
  subtask: 'neutral',
};

const LETTERS: Record<Exclude<ItemType, 'story'>, string> = {
  epic: 'E',
  feature: 'F',
  bug: 'B',
  task: 'T',
  spike: 'S',
  subtask: '↳',
};

/** The type's letter; a story is `P` (PBI) or `U` (User story) by the project's naming. */
export function itemTypeGlyph(type: ItemType, naming: ItemTypeNaming): string {
  if (type === 'story') return naming === 'story' ? 'U' : 'P';
  return LETTERS[type];
}

/**
 * A task's `type` as a known item type. Older values map onto the closest one
 * (`improvement` is a task, `feature` without the feature level is an epic's
 * item, so a story); an empty or unknown value is a task, and a task with a
 * parent is a subtask.
 */
export function itemTypeOf(
  type: string | null | undefined,
  options: { hasParent?: boolean; featureLevel?: boolean } = {},
): ItemType {
  if (options.hasParent) return 'subtask';
  const value = (type ?? '').trim().toLowerCase();
  if (value === 'feature' && options.featureLevel === false) return 'story';
  if ((ITEM_TYPES as readonly string[]).includes(value)) return value as ItemType;
  if (value === 'pbi' || value === 'user_story' || value === 'requirement') return 'story';
  return 'task';
}

/** Epics and features hold items. */
export function isContainerType(type: ItemType): boolean {
  return CONTAINER_ITEM_TYPES.includes(type);
}

/** The prefixes of the quick-create row: `/bug Fix the login` makes a bug. */
const PREFIXES: Record<string, ItemType> = {
  epic: 'epic',
  feature: 'feature',
  story: 'story',
  pbi: 'story',
  bug: 'bug',
  task: 'task',
  spike: 'spike',
};

/** Splits a leading `/type` off a quick-create title. */
export function parseQuickCreate(input: string): { type: ItemType | null; title: string } {
  const match = /^\/([a-z]+)\s+(.*)$/i.exec(input.trim());
  const prefix = match?.[1]?.toLowerCase();
  if (match && prefix && prefix in PREFIXES) {
    return { type: PREFIXES[prefix] ?? null, title: (match[2] ?? '').trim() };
  }
  return { type: null, title: input.trim() };
}
