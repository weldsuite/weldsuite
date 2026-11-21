/**
 * Pure edits of a form definition for the builder's outline: add, move,
 * duplicate and remove blocks and endings, keeping the logic that points at
 * them consistent. Every function returns a new definition and never mutates.
 *
 * Groups hold fields and statements but don't nest, and page breaks only make
 * sense at the top level, so a move that would break either is refused (the
 * definition comes back unchanged).
 */

import {
  createEnding,
  newBlockId,
  uniqueRef,
  type Block,
  type FieldBlock,
  type FormDefinition,
  type FormEnding,
  type GroupBlock,
  type StatementBlock,
} from '@weldsuite/forms-engine';

export type GroupChild = FieldBlock | StatementBlock;

export function isGroupChild(block: Block): block is GroupChild {
  return block.type !== 'group' && block.type !== 'page_break';
}

/** Moves one array item; indexes are clamped. Returns the same array when nothing moves. */
export function reorder<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length) return [...items];
  const target = Math.max(0, Math.min(items.length - 1, to));
  if (from === target) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved as T);
  return next;
}

/** Where a block sits: top level, or inside a group. */
export interface BlockLocation {
  parentId: string | null;
  index: number;
}

export function locate(def: Pick<FormDefinition, 'blocks'>, id: string): BlockLocation | null {
  const top = def.blocks.findIndex((b) => b.id === id);
  if (top !== -1) return { parentId: null, index: top };
  for (const block of def.blocks) {
    if (block.type !== 'group') continue;
    const index = block.children.findIndex((c) => c.id === id);
    if (index !== -1) return { parentId: block.id, index };
  }
  return null;
}

/** Every block id in the definition, group children included. */
function allBlockIds(def: Pick<FormDefinition, 'blocks'>): Set<string> {
  const ids = new Set<string>();
  for (const block of def.blocks) {
    ids.add(block.id);
    if (block.type === 'group') for (const child of block.children) ids.add(child.id);
  }
  return ids;
}

function replaceBlocks(def: FormDefinition, blocks: Block[]): FormDefinition {
  return { ...def, blocks };
}

/**
 * Adds a block. `parentId` puts it inside that group, otherwise it goes to the
 * top level; `index` is the position there (default: the end). A page break or
 * a group can't go inside a group.
 */
export function addBlock(def: FormDefinition, block: Block, at: { parentId?: string | null; index?: number } = {}): FormDefinition {
  if (at.parentId) {
    if (!isGroupChild(block)) return def;
    const group = def.blocks.find((b): b is GroupBlock => b.id === at.parentId && b.type === 'group');
    if (!group) return def;
    const children = [...group.children];
    children.splice(at.index ?? children.length, 0, block);
    return replaceBlocks(def, def.blocks.map((b) => (b.id === group.id ? { ...group, children } : b)));
  }
  const blocks = [...def.blocks];
  blocks.splice(at.index ?? blocks.length, 0, block);
  return replaceBlocks(def, blocks);
}

/** Adds a block right after another (a top-level block or a group child); at the end when `afterId` is unknown. */
export function addBlockAfter(def: FormDefinition, block: Block, afterId: string | null): FormDefinition {
  if (afterId) {
    const where = locate(def, afterId);
    if (where) {
      if (where.parentId && isGroupChild(block)) return addBlock(def, block, { parentId: where.parentId, index: where.index + 1 });
      // A group child after which a page break, a group or a new block of any kind is wanted: after the group.
      const topIndex = where.parentId ? def.blocks.findIndex((b) => b.id === where.parentId) : where.index;
      return addBlock(def, block, { index: topIndex + 1 });
    }
  }
  return addBlock(def, block);
}

/** Applies a patch to one block (top level or group child). */
export function updateBlock(def: FormDefinition, id: string, patch: (block: Block) => Block): FormDefinition {
  let changed = false;
  const blocks = def.blocks.map((block): Block => {
    if (block.id === id) {
      changed = true;
      return patch(block);
    }
    if (block.type === 'group') {
      let childChanged = false;
      const children = block.children.map((child) => {
        if (child.id !== id) return child;
        childChanged = true;
        return patch(child) as GroupChild;
      });
      if (!childChanged) return block;
      changed = true;
      return { ...block, children };
    }
    return block;
  });
  return changed ? replaceBlocks(def, blocks) : def;
}

/**
 * Moves a block to `toIndex` inside `toParentId` (null = top level). Groups and
 * page breaks stay at the top level; a block can't move into itself.
 */
export function moveBlock(def: FormDefinition, id: string, toIndex: number, toParentId: string | null = null): FormDefinition {
  const from = locate(def, id);
  if (!from) return def;
  const block = from.parentId
    ? (def.blocks.find((b): b is GroupBlock => b.id === from.parentId)?.children.find((c) => c.id === id) as Block | undefined)
    : def.blocks[from.index];
  if (!block) return def;
  if (toParentId !== null && (!isGroupChild(block) || toParentId === id)) return def;
  if (toParentId !== null && !def.blocks.some((b) => b.id === toParentId && b.type === 'group')) return def;

  // Same list: a plain reorder.
  if (from.parentId === toParentId) {
    if (toParentId === null) return replaceBlocks(def, reorder(def.blocks, from.index, toIndex));
    return replaceBlocks(
      def,
      def.blocks.map((b) => (b.id === toParentId && b.type === 'group' ? { ...b, children: reorder(b.children, from.index, toIndex) } : b)),
    );
  }

  // Across lists: take it out, then add it where asked.
  const without = removeFromTree(def, id);
  return addBlock(without, block, { parentId: toParentId, index: toIndex });
}

function removeFromTree(def: FormDefinition, id: string): FormDefinition {
  const blocks = def.blocks
    .filter((b) => b.id !== id)
    .map((b) => (b.type === 'group' && b.children.some((c) => c.id === id) ? { ...b, children: b.children.filter((c) => c.id !== id) } : b));
  return replaceBlocks(def, blocks);
}

/** Moves a block one step up or down among its siblings. */
export function nudgeBlock(def: FormDefinition, id: string, direction: -1 | 1): FormDefinition {
  const where = locate(def, id);
  if (!where) return def;
  return moveBlock(def, id, where.index + direction, where.parentId);
}

/**
 * Removes a block and what depended on it: its own logic, jumps and
 * "otherwise" that targeted it. Conditions that read it are left alone so the
 * issue markers show where the rule now points at nothing.
 */
export function removeBlock(def: FormDefinition, id: string): FormDefinition {
  const removedIds = new Set<string>([id]);
  const top = def.blocks.find((b) => b.id === id);
  if (top?.type === 'group') for (const child of top.children) removedIds.add(child.id);

  const base = removeFromTree(def, id);
  const logic = base.logic
    .filter((l) => !removedIds.has(l.blockId))
    .map((l) => ({
      ...l,
      jumps: l.jumps.filter((j) => !(j.to.type === 'block' && removedIds.has(j.to.id))),
      otherwise: l.otherwise && l.otherwise.type === 'block' && removedIds.has(l.otherwise.id) ? null : l.otherwise,
    }))
    // An entry that only existed to point at the removed block says nothing now.
    .filter((l) => l.calculations.length > 0 || l.jumps.length > 0 || l.otherwise !== null);
  return { ...base, logic };
}

/** A copy of a block with new ids and refs (choices, rows and columns included). */
function cloneBlock<T extends Block>(def: FormDefinition, block: T, taken: FormDefinition): T {
  const ref = uniqueRef(taken, `${block.ref}_copy`);
  const clone = { ...block, id: newBlockId('b'), ref } as Block;
  if (clone.type === 'multiple_choice' || clone.type === 'dropdown' || clone.type === 'picture_choice' || clone.type === 'ranking') {
    clone.properties = { ...clone.properties, choices: clone.properties.choices.map((c) => ({ ...c, id: newBlockId('c') })) } as typeof clone.properties;
  } else if (clone.type === 'matrix') {
    clone.properties = {
      ...clone.properties,
      rows: clone.properties.rows.map((r) => ({ ...r, id: newBlockId('r') })),
      columns: clone.properties.columns.map((c) => ({ ...c, id: newBlockId('k') })),
    };
  } else if (clone.type === 'group') {
    let working = taken;
    const children: GroupChild[] = [];
    for (const child of clone.children) {
      const copy = cloneBlock(def, child, working);
      children.push(copy);
      working = addBlock(working, copy);
    }
    clone.children = children;
  }
  return clone as T;
}

/** Duplicates a block right below itself (logic is not copied). */
export function duplicateBlock(def: FormDefinition, id: string): FormDefinition {
  const where = locate(def, id);
  if (!where) return def;
  const source = where.parentId
    ? def.blocks.find((b): b is GroupBlock => b.id === where.parentId)?.children.find((c) => c.id === id)
    : def.blocks[where.index];
  if (!source) return def;
  const copy = cloneBlock(def, source, def);
  return addBlock(def, copy, { parentId: where.parentId, index: where.index + 1 });
}

// ---------------------------------------------------------------------------
// Endings
// ---------------------------------------------------------------------------

export function addEnding(def: FormDefinition, title: string): FormDefinition {
  const ending = createEnding({ title, ref: uniqueRef(def, 'ending') });
  return { ...def, endings: [...def.endings, ending] };
}

export function updateEnding(def: FormDefinition, id: string, patch: (ending: FormEnding) => FormEnding): FormDefinition {
  return { ...def, endings: def.endings.map((e) => (e.id === id ? patch(e) : e)) };
}

/** Removes an ending (the last one stays) and the jumps and rules that pointed at it. */
export function removeEnding(def: FormDefinition, id: string): FormDefinition {
  if (def.endings.length <= 1 || !def.endings.some((e) => e.id === id)) return def;
  return {
    ...def,
    endings: def.endings.filter((e) => e.id !== id),
    endingRules: def.endingRules.filter((r) => r.endingId !== id),
    logic: def.logic.map((l) => ({
      ...l,
      jumps: l.jumps.filter((j) => !(j.to.type === 'ending' && j.to.id === id)),
      otherwise: l.otherwise && l.otherwise.type === 'ending' && l.otherwise.id === id ? null : l.otherwise,
    })),
  };
}

export function moveEnding(def: FormDefinition, id: string, toIndex: number): FormDefinition {
  const from = def.endings.findIndex((e) => e.id === id);
  if (from === -1) return def;
  return { ...def, endings: reorder(def.endings, from, toIndex) };
}

/** Does a block with this id exist anywhere (for dropping stale selections)? */
export function hasBlock(def: Pick<FormDefinition, 'blocks'>, id: string): boolean {
  return allBlockIds(def).has(id);
}

/** The id of the block to select after removing `id`: the next sibling, else the previous, else the parent, else null. */
export function selectionAfterRemoval(def: FormDefinition, id: string): string | null {
  const where = locate(def, id);
  if (!where) return null;
  const siblings = where.parentId
    ? ((def.blocks.find((b): b is GroupBlock => b.id === where.parentId)?.children ?? []) as Block[])
    : def.blocks;
  return siblings[where.index + 1]?.id ?? siblings[where.index - 1]?.id ?? where.parentId;
}

/** Merges a patch into a block's `properties` (a block type without properties is returned unchanged). */
export function withProperties<T extends Block>(block: T, patch: Record<string, unknown>): T {
  if (!('properties' in block)) return block;
  return { ...block, properties: { ...block.properties, ...patch } } as T;
}

/** The first top-level index of the block that is, or contains, `id`; -1 when unknown. */
export function topLevelIndex(def: Pick<FormDefinition, 'blocks'>, id: string): number {
  return def.blocks.findIndex((b) => b.id === id || (b.type === 'group' && b.children.some((c) => c.id === id)));
}
