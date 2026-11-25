/**
 * Operations on the section lists of a site document, for the online store
 * editor. Pure functions over immutable data: each returns a new list (or the
 * same one when the operation is not allowed), so the editor's history keeps
 * every earlier state intact.
 *
 * The rules are the section catalog's (`@weldsuite/storefront-theme`), the
 * same the backend checks on save: only `addableSections(list)` can be added,
 * at most `limit` of a type per list and 40 sections per list, main sections
 * (`required`) are never removed, and blocks stay within `maxBlocks`.
 */

import {
  LIMITS,
  SECTION_CATALOG,
  addableSections,
  defaultBlockSettings,
  defaultSettings,
  type Block,
  type GroupName,
  type ListName,
  type Section,
  type SettingValues,
  type SiteDocument,
  type TemplateName,
} from '@weldsuite/storefront-theme/catalog';

/** What the editor edits: the draft document, and the sections of the content pages opened in it. */
export interface EditorContent {
  document: SiteDocument;
  /** A content page's own sections (the list `content`), by page id. */
  pages: Record<string, Section[]>;
}

/** Where a section list lives: a group, a template, or a content page (`content` with its page id). */
export type ListKey = { name: GroupName | TemplateName } | { name: 'content'; pageId: string };

export function isGroup(name: ListName): name is GroupName {
  return name === 'header' || name === 'footer';
}

export function listKeyEquals(a: ListKey, b: ListKey): boolean {
  if (a.name !== b.name) return false;
  return a.name !== 'content' || (b.name === 'content' && a.pageId === b.pageId);
}

export function getList(content: EditorContent, key: ListKey): Section[] {
  if (key.name === 'content') return content.pages[key.pageId] ?? [];
  if (isGroup(key.name)) return content.document.groups[key.name];
  return content.document.templates[key.name];
}

export function setList(content: EditorContent, key: ListKey, sections: Section[]): EditorContent {
  if (key.name === 'content') return { ...content, pages: { ...content.pages, [key.pageId]: sections } };
  if (isGroup(key.name)) {
    return { ...content, document: { ...content.document, groups: { ...content.document.groups, [key.name]: sections } } };
  }
  return { ...content, document: { ...content.document, templates: { ...content.document.templates, [key.name]: sections } } };
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** `value` without the hyphens it starts and ends with (`--a-b-` → `a-b`). */
export function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}

/** An id matching `[a-z0-9_-]{1,40}` that no item in `taken` has: the base, then `-2`, `-3`, … */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const stem = trimHyphens(base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')).slice(0, LIMITS.idLength - 4) || 'item';
  if (!used.has(stem)) return stem;
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** A main section of this list: it must be there exactly once, so it cannot be removed (or added again). */
export function isRequired(section: Pick<Section, 'type'>, list: ListName): boolean {
  const required = SECTION_CATALOG[section.type]?.required ?? [];
  return (required as ListName[]).includes(list);
}

export function canRemoveSection(section: Pick<Section, 'type'>, list: ListName): boolean {
  return !isRequired(section, list);
}

export type AddRefusal = 'notAllowed' | 'limit' | 'listFull';

/** Why `type` can't be added to this list now, or `null` when it can. */
export function addSectionRefusal(sections: readonly Section[], type: string, list: ListName): AddRefusal | null {
  if (!addableSections(list).includes(type)) return 'notAllowed';
  if (sections.length >= LIMITS.sectionsPerList) return 'listFull';
  const limit = SECTION_CATALOG[type]?.limit;
  if (limit != null && sections.filter((section) => section.type === type).length >= limit) return 'limit';
  return null;
}

/** A new section of `type` with its defaults, and an empty block list when the type has blocks. */
export function newSectionOf(type: string, taken: Iterable<string>): Section {
  const definition = SECTION_CATALOG[type];
  const section: Section = { id: uniqueId(type, taken), type, settings: defaultSettings(type) };
  if (definition && definition.maxBlocks > 0) section.blocks = [];
  return section;
}

/** The list with a new section of `type` at the end (or after `afterId`), and the new section's id; `null` when refused. */
export function addSection(
  sections: readonly Section[],
  type: string,
  list: ListName,
  afterId?: string,
): { sections: Section[]; id: string } | null {
  if (addSectionRefusal(sections, type, list)) return null;
  const section = newSectionOf(
    type,
    sections.map((s) => s.id),
  );
  const next = [...sections];
  const after = afterId ? next.findIndex((s) => s.id === afterId) : -1;
  next.splice(after === -1 ? next.length : after + 1, 0, section);
  return { sections: next, id: section.id };
}

/** The list after moving the item at `index` one place up (`-1`) or down (`1`); the same list at an edge. */
export function moveItem<T>(items: readonly T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function moveSection(sections: readonly Section[], id: string, direction: -1 | 1): Section[] {
  return moveItem(
    sections,
    sections.findIndex((s) => s.id === id),
    direction,
  );
}

export function toggleSectionHidden(sections: readonly Section[], id: string): Section[] {
  return sections.map((section) => {
    if (section.id !== id) return section;
    if (section.hidden) {
      const shown = { ...section };
      delete shown.hidden;
      return shown;
    }
    return { ...section, hidden: true };
  });
}

/** The list without that section; unchanged when it is a main section of this list. */
export function removeSection(sections: readonly Section[], id: string, list: ListName): Section[] {
  const section = sections.find((s) => s.id === id);
  if (!section || !canRemoveSection(section, list)) return [...sections];
  return sections.filter((s) => s.id !== id);
}

export function updateSectionSettings(sections: readonly Section[], id: string, settings: SettingValues): Section[] {
  return sections.map((section) => (section.id === id ? { ...section, settings: { ...section.settings, ...settings } } : section));
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export function maxBlocks(section: Pick<Section, 'type'>): number {
  return Math.min(SECTION_CATALOG[section.type]?.maxBlocks ?? 0, LIMITS.blocksPerSection);
}

/** The block types the section takes, in catalog order. */
export function blockTypes(section: Pick<Section, 'type'>): string[] {
  return Object.keys(SECTION_CATALOG[section.type]?.blocks ?? {});
}

export function canAddBlock(section: Section, blockType: string): boolean {
  return blockTypes(section).includes(blockType) && (section.blocks?.length ?? 0) < maxBlocks(section);
}

function withBlocks(sections: readonly Section[], id: string, change: (section: Section, blocks: Block[]) => Block[]): Section[] {
  return sections.map((section) => (section.id === id ? { ...section, blocks: change(section, section.blocks ?? []) } : section));
}

/** The list with a new block at the end of that section, and the block's id; `null` when the section is full or takes no such block. */
export function addBlock(sections: readonly Section[], sectionId: string, blockType: string): { sections: Section[]; id: string } | null {
  const section = sections.find((s) => s.id === sectionId);
  if (!section || !canAddBlock(section, blockType)) return null;
  const block: Block = {
    id: uniqueId(
      blockType,
      (section.blocks ?? []).map((b) => b.id),
    ),
    type: blockType,
    settings: defaultBlockSettings(section.type, blockType),
  };
  return { sections: withBlocks(sections, sectionId, (_, blocks) => [...blocks, block]), id: block.id };
}

export function moveBlock(sections: readonly Section[], sectionId: string, blockId: string, direction: -1 | 1): Section[] {
  return withBlocks(sections, sectionId, (_, blocks) =>
    moveItem(
      blocks,
      blocks.findIndex((b) => b.id === blockId),
      direction,
    ),
  );
}

export function removeBlock(sections: readonly Section[], sectionId: string, blockId: string): Section[] {
  return withBlocks(sections, sectionId, (_, blocks) => blocks.filter((b) => b.id !== blockId));
}

export function updateBlockSettings(sections: readonly Section[], sectionId: string, blockId: string, settings: SettingValues): Section[] {
  return withBlocks(sections, sectionId, (_, blocks) =>
    blocks.map((block) => (block.id === blockId ? { ...block, settings: { ...block.settings, ...settings } } : block)),
  );
}
