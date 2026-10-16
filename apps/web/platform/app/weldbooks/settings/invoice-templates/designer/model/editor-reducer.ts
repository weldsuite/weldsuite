/**
 * State of the designer: the template document being edited, its undo/redo
 * history and the selection. Pure reducer, no React.
 *
 * Consecutive edits that carry the same `coalesce` key (a drag, a run of arrow
 * key nudges, typing in one inspector field) share one history entry; any other
 * action, a selection change or `endCoalesce` closes the group.
 */
import type { InvoiceTemplateDocument, TemplateBlock } from '@weldsuite/books-domain/invoice-template/schema';
import { newBlockId, removableIds } from './block-factory';
import { round2, type Rect } from './snapping';

export const HISTORY_LIMIT = 100;
/** Offset of a duplicated block from its original, in points. */
export const DUPLICATE_OFFSET = 12;

export type ArrangeOp = 'forward' | 'backward' | 'front' | 'back';

/** A partial block (shallow-merged; `undefined` removes the key) or a function from block to block. */
export type BlockUpdate = Record<string, unknown> | ((block: TemplateBlock) => TemplateBlock);

export interface EditorState {
  doc: InvoiceTemplateDocument;
  /** The document as last saved; `doc !== saved` means unsaved changes. */
  saved: InvoiceTemplateDocument;
  past: InvoiceTemplateDocument[];
  future: InvoiceTemplateDocument[];
  selection: string[];
  coalesceKey: string | null;
}

export type EditorAction =
  | { type: 'reset'; doc: InvoiceTemplateDocument }
  /** `doc`: the document the save sent; edits made since stay unsaved. */
  | { type: 'markSaved'; doc?: InvoiceTemplateDocument }
  | { type: 'select'; ids: string[]; mode?: 'replace' | 'toggle' | 'add' }
  | { type: 'addBlock'; block: TemplateBlock }
  | { type: 'updateBlocks'; ids: string[]; update: BlockUpdate; coalesce?: string }
  | { type: 'setRects'; rects: Record<string, Rect>; coalesce?: string }
  | { type: 'nudge'; ids: string[]; dx: number; dy: number }
  | { type: 'deleteBlocks'; ids: string[] }
  | { type: 'duplicateBlocks'; ids: string[] }
  | { type: 'arrange'; ids: string[]; op: ArrangeOp }
  | { type: 'setOrder'; order: string[] }
  | { type: 'updateDoc'; update: (doc: InvoiceTemplateDocument) => InvoiceTemplateDocument; coalesce?: string }
  | { type: 'replaceDoc'; doc: InvoiceTemplateDocument }
  | { type: 'undo' }
  | { type: 'redo' }
  /** Closes the current coalescing group; with `prefixes` only when its key starts with one of them (a drag in progress is left alone). */
  | { type: 'endCoalesce'; prefixes?: string[] };

export function initialEditorState(doc: InvoiceTemplateDocument): EditorState {
  return { doc, saved: doc, past: [], future: [], selection: [], coalesceKey: null };
}

export const isDirty = (state: EditorState) => state.doc !== state.saved;
export const canUndo = (state: EditorState) => state.past.length > 0;
export const canRedo = (state: EditorState) => state.future.length > 0;

/** Schema limits of a block's rectangle. */
export function clampRect(rect: Rect): Rect {
  const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
  return {
    x: round2(clamp(rect.x, -50, 1000)),
    y: round2(clamp(rect.y, -50, 1000)),
    w: round2(clamp(rect.w, 2, 1000)),
    h: round2(clamp(rect.h, 0.5, 1000)),
  };
}

function patchBlock(block: TemplateBlock, update: BlockUpdate): TemplateBlock {
  if (typeof update === 'function') return update(block);
  let changed = false;
  const next: Record<string, unknown> = { ...block };
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined) {
      if (key in next) {
        delete next[key];
        changed = true;
      }
    } else if (!Object.is(next[key], value)) {
      next[key] = value;
      changed = true;
    }
  }
  return changed ? (next as unknown as TemplateBlock) : block;
}

function mapBlocks(doc: InvoiceTemplateDocument, ids: ReadonlySet<string>, fn: (block: TemplateBlock) => TemplateBlock): InvoiceTemplateDocument {
  let changed = false;
  const blocks = doc.blocks.map((block) => {
    if (!ids.has(block.id)) return block;
    const next = fn(block);
    if (next !== block) changed = true;
    return next;
  });
  return changed ? { ...doc, blocks } : doc;
}

function commit(state: EditorState, doc: InvoiceTemplateDocument, options: { coalesce?: string; selection?: string[] } = {}): EditorState {
  if (doc === state.doc) {
    return options.selection ? { ...state, selection: options.selection } : state;
  }
  const grouped = options.coalesce !== undefined && options.coalesce === state.coalesceKey;
  return {
    ...state,
    doc,
    past: grouped ? state.past : [...state.past, state.doc].slice(-HISTORY_LIMIT),
    future: [],
    coalesceKey: options.coalesce ?? null,
    selection: options.selection ?? state.selection,
  };
}

/** The ids of a selection that still exist in the document. */
function existing(doc: InvoiceTemplateDocument, ids: readonly string[]): string[] {
  const all = new Set(doc.blocks.map((b) => b.id));
  return ids.filter((id) => all.has(id));
}

/** Moves `ids` one step towards the front (`forward`) or the back (`backward`), each past one unselected neighbour. */
function stepBlocks(blocks: TemplateBlock[], ids: ReadonlySet<string>, op: 'forward' | 'backward'): TemplateBlock[] {
  const next = [...blocks];
  if (op === 'forward') {
    for (let i = next.length - 2; i >= 0; i--) {
      if (ids.has(next[i].id) && !ids.has(next[i + 1].id)) [next[i], next[i + 1]] = [next[i + 1], next[i]];
    }
  } else {
    for (let i = 1; i < next.length; i++) {
      if (ids.has(next[i].id) && !ids.has(next[i - 1].id)) [next[i], next[i - 1]] = [next[i - 1], next[i]];
    }
  }
  return next;
}

function arrange(blocks: TemplateBlock[], ids: ReadonlySet<string>, op: ArrangeOp): TemplateBlock[] {
  const picked = blocks.filter((b) => ids.has(b.id));
  const rest = blocks.filter((b) => !ids.has(b.id));
  if (picked.length === 0) return blocks;
  if (op === 'front') return [...rest, ...picked];
  if (op === 'back') return [...picked, ...rest];
  return stepBlocks(blocks, ids, op);
}

type ActionOf<T extends EditorAction['type']> = Extract<EditorAction, { type: T }>;

function endCoalesce(state: EditorState, action: ActionOf<'endCoalesce'>): EditorState {
  const key = state.coalesceKey;
  if (key === null) return state;
  if (action.prefixes && !action.prefixes.some((p) => key.startsWith(p))) return state;
  return { ...state, coalesceKey: null };
}

function select(state: EditorState, action: ActionOf<'select'>): EditorState {
  const ids = existing(state.doc, action.ids);
  let selection: string[];
  if (action.mode === 'toggle') {
    const current = new Set(state.selection);
    for (const id of ids) {
      if (current.has(id)) current.delete(id);
      else current.add(id);
    }
    selection = [...current];
  } else if (action.mode === 'add') {
    selection = [...new Set([...state.selection, ...ids])];
  } else {
    selection = ids;
  }
  return { ...state, selection, coalesceKey: null };
}

function addBlock(state: EditorState, action: ActionOf<'addBlock'>): EditorState {
  if (state.doc.blocks.some((b) => b.id === action.block.id)) return state;
  if (action.block.type === 'lineItems' && state.doc.blocks.some((b) => b.type === 'lineItems')) return state;
  return commit(state, { ...state.doc, blocks: [...state.doc.blocks, action.block] }, { selection: [action.block.id] });
}

function updateBlocks(state: EditorState, action: ActionOf<'updateBlocks'>): EditorState {
  const ids = new Set(action.ids);
  return commit(state, mapBlocks(state.doc, ids, (b) => patchBlock(b, action.update)), { coalesce: action.coalesce });
}

function setRects(state: EditorState, action: ActionOf<'setRects'>): EditorState {
  const ids = new Set(Object.keys(action.rects));
  const doc = mapBlocks(state.doc, ids, (block) => {
    if (block.locked) return block;
    const r = clampRect(action.rects[block.id]);
    if (block.x === r.x && block.y === r.y && block.w === r.w && block.h === r.h) return block;
    return { ...block, ...r };
  });
  return commit(state, doc, { coalesce: action.coalesce });
}

function nudge(state: EditorState, action: ActionOf<'nudge'>): EditorState {
  const rects: Record<string, Rect> = {};
  for (const block of state.doc.blocks) {
    if (action.ids.includes(block.id) && !block.locked) {
      rects[block.id] = { x: block.x + action.dx, y: block.y + action.dy, w: block.w, h: block.h };
    }
  }
  return setRects(state, { type: 'setRects', rects, coalesce: `nudge:${[...action.ids].sort().join(',')}` });
}

function deleteBlocks(state: EditorState, action: ActionOf<'deleteBlocks'>): EditorState {
  const ids = new Set(removableIds(state.doc, action.ids));
  if (ids.size === 0) return state;
  const doc = { ...state.doc, blocks: state.doc.blocks.filter((b) => !ids.has(b.id)) };
  return commit(state, doc, { selection: state.selection.filter((id) => !ids.has(id)) });
}

function duplicateBlocks(state: EditorState, action: ActionOf<'duplicateBlocks'>): EditorState {
  const wanted = new Set(action.ids);
  const taken = new Set(state.doc.blocks.map((b) => b.id));
  const copies: TemplateBlock[] = [];
  for (const block of state.doc.blocks) {
    // The template has exactly one line-items table.
    if (!wanted.has(block.id) || block.type === 'lineItems') continue;
    const id = newBlockId(block.type, taken);
    taken.add(id);
    const copy = structuredClone(block);
    // A copy of a locked block starts unlocked, so it can be moved away from the original.
    delete (copy as { locked?: boolean }).locked;
    copies.push({ ...copy, id, x: block.x + DUPLICATE_OFFSET, y: block.y + DUPLICATE_OFFSET });
  }
  if (copies.length === 0) return state;
  return commit(state, { ...state.doc, blocks: [...state.doc.blocks, ...copies] }, { selection: copies.map((c) => c.id) });
}

/** Commits a reordered block list, unless it is in the same order as now. */
function commitOrder(state: EditorState, blocks: TemplateBlock[]): EditorState {
  const same = blocks.every((b, i) => b === state.doc.blocks[i]);
  return same ? state : commit(state, { ...state.doc, blocks });
}

function arrangeBlocks(state: EditorState, action: ActionOf<'arrange'>): EditorState {
  return commitOrder(state, arrange(state.doc.blocks, new Set(action.ids), action.op));
}

function setOrder(state: EditorState, action: ActionOf<'setOrder'>): EditorState {
  const byId = new Map(state.doc.blocks.map((b) => [b.id, b]));
  if (action.order.length !== byId.size || !action.order.every((id) => byId.has(id))) return state;
  return commitOrder(
    state,
    action.order.map((id) => byId.get(id)!),
  );
}

function undo(state: EditorState): EditorState {
  if (state.past.length === 0) return state;
  const doc = state.past[state.past.length - 1];
  return {
    ...state,
    doc,
    past: state.past.slice(0, -1),
    future: [state.doc, ...state.future],
    selection: existing(doc, state.selection),
    coalesceKey: null,
  };
}

function redo(state: EditorState): EditorState {
  if (state.future.length === 0) return state;
  const [doc, ...future] = state.future;
  return {
    ...state,
    doc,
    past: [...state.past, state.doc],
    future,
    selection: existing(doc, state.selection),
    coalesceKey: null,
  };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'reset':
      return initialEditorState(action.doc);
    case 'markSaved':
      return { ...state, saved: action.doc ?? state.doc };
    case 'endCoalesce':
      return endCoalesce(state, action);
    case 'select':
      return select(state, action);
    case 'addBlock':
      return addBlock(state, action);
    case 'updateBlocks':
      return updateBlocks(state, action);
    case 'setRects':
      return setRects(state, action);
    case 'nudge':
      return nudge(state, action);
    case 'deleteBlocks':
      return deleteBlocks(state, action);
    case 'duplicateBlocks':
      return duplicateBlocks(state, action);
    case 'arrange':
      return arrangeBlocks(state, action);
    case 'setOrder':
      return setOrder(state, action);
    case 'updateDoc':
      return commit(state, action.update(state.doc), { coalesce: action.coalesce });
    case 'replaceDoc':
      return commit(state, action.doc, { selection: [] });
    case 'undo':
      return undo(state);
    case 'redo':
      return redo(state);
  }
}
