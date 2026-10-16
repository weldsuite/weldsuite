import { describe, expect, it } from 'vitest';
import { invoiceTemplateDocumentSchema } from '@weldsuite/books-domain/invoice-template/schema';
import { presetTemplate } from '@weldsuite/books-domain/invoice-template/presets';
import { createBlock } from './block-factory';
import {
  canRedo,
  canUndo,
  editorReducer,
  initialEditorState,
  isDirty,
  type EditorAction,
  type EditorState,
} from './editor-reducer';

const start = () => initialEditorState(presetTemplate('classic', 'a4'));

function run(state: EditorState, ...actions: EditorAction[]): EditorState {
  return actions.reduce(editorReducer, state);
}

const block = (state: EditorState, id: string) => state.doc.blocks.find((b) => b.id === id)!;

describe('editorReducer: history', () => {
  it('starts clean and becomes dirty after an edit', () => {
    const s0 = start();
    expect(isDirty(s0)).toBe(false);
    const s1 = run(s0, { type: 'updateBlocks', ids: ['title'], update: { x: 10 } });
    expect(isDirty(s1)).toBe(true);
    expect(canUndo(s1)).toBe(true);
  });

  it('undo and redo restore documents by reference, so undo returns to clean', () => {
    const s0 = start();
    const s1 = run(s0, { type: 'updateBlocks', ids: ['title'], update: { x: 10 } });
    const undone = run(s1, { type: 'undo' });
    expect(undone.doc).toBe(s0.doc);
    expect(isDirty(undone)).toBe(false);
    expect(canRedo(undone)).toBe(true);
    const redone = run(undone, { type: 'redo' });
    expect(redone.doc).toBe(s1.doc);
  });

  it('a new edit clears the redo stack', () => {
    const s = run(
      start(),
      { type: 'updateBlocks', ids: ['title'], update: { x: 10 } },
      { type: 'undo' },
      { type: 'updateBlocks', ids: ['title'], update: { x: 20 } },
    );
    expect(canRedo(s)).toBe(false);
  });

  it('coalesces a drag into one history entry', () => {
    let s = start();
    const original = s.doc;
    for (let i = 1; i <= 10; i++) {
      s = run(s, { type: 'setRects', rects: { title: { x: 100 + i, y: 50, w: 240, h: 30 } }, coalesce: 'drag:1' });
    }
    expect(s.past).toHaveLength(1);
    expect(block(s, 'title').x).toBe(110);
    expect(run(s, { type: 'undo' }).doc).toBe(original);
  });

  it('starts a new history entry after the gesture ends', () => {
    let s = start();
    s = run(s, { type: 'setRects', rects: { title: { x: 100, y: 50, w: 240, h: 30 } }, coalesce: 'drag:1' });
    s = run(s, { type: 'endCoalesce' });
    s = run(s, { type: 'setRects', rects: { title: { x: 120, y: 50, w: 240, h: 30 } }, coalesce: 'drag:1' });
    expect(s.past).toHaveLength(2);
  });

  it('closes only the matching groups when asked to', () => {
    const drag = run(start(), { type: 'setRects', rects: { title: { x: 100, y: 50, w: 240, h: 30 } }, coalesce: 'drag:1' });
    expect(run(drag, { type: 'endCoalesce', prefixes: ['nudge:'] }).coalesceKey).toBe('drag:1');
    expect(run(drag, { type: 'endCoalesce', prefixes: ['drag:'] }).coalesceKey).toBeNull();
  });

  it('does not add history for a change that changes nothing', () => {
    const s0 = start();
    const x = block(s0, 'title').x;
    const s1 = run(s0, { type: 'updateBlocks', ids: ['title'], update: { x } });
    expect(s1).toBe(s0);
  });

  it('marks the current document as saved', () => {
    const s = run(start(), { type: 'updateBlocks', ids: ['title'], update: { x: 10 } }, { type: 'markSaved' });
    expect(isDirty(s)).toBe(false);
    expect(canUndo(s)).toBe(true);
    expect(isDirty(run(s, { type: 'undo' }))).toBe(true);
  });

  it('keeps edits made while a save was in flight unsaved', () => {
    const edited = run(start(), { type: 'updateBlocks', ids: ['title'], update: { x: 10 } });
    const sent = edited.doc;
    const meanwhile = run(edited, { type: 'updateBlocks', ids: ['title'], update: { x: 20 } });
    const s = run(meanwhile, { type: 'markSaved', doc: sent });
    expect(isDirty(s)).toBe(true);
    expect(s.saved).toBe(sent);
    expect(isDirty(run(s, { type: 'undo' }))).toBe(false);
  });
});

describe('editorReducer: blocks', () => {
  it('adds a block and selects it', () => {
    const s = run(start(), { type: 'addBlock', block: createBlock('text', 'text-1', { x: 10, y: 10, text: 'Hello' }) });
    expect(s.selection).toEqual(['text-1']);
    expect(invoiceTemplateDocumentSchema.safeParse(s.doc).success).toBe(true);
  });

  it('refuses a second line-items table', () => {
    const s0 = start();
    const s1 = run(s0, { type: 'addBlock', block: createBlock('lineItems', 'items-2') });
    expect(s1).toBe(s0);
  });

  it('removes a key set to undefined', () => {
    const s = run(
      start(),
      { type: 'updateBlocks', ids: ['title'], update: { everyPage: true } },
      { type: 'updateBlocks', ids: ['title'], update: { everyPage: undefined } },
    );
    expect('everyPage' in block(s, 'title')).toBe(false);
  });

  it('deletes blocks but never the line-items table', () => {
    const s = run(
      start(),
      { type: 'select', ids: ['title', 'items'] },
      { type: 'deleteBlocks', ids: ['title', 'items'] },
    );
    expect(s.doc.blocks.some((b) => b.id === 'title')).toBe(false);
    expect(s.doc.blocks.some((b) => b.id === 'items')).toBe(true);
    expect(s.selection).toEqual(['items']);
  });

  it('refuses to delete only the table', () => {
    const s0 = start();
    expect(run(s0, { type: 'deleteBlocks', ids: ['items'] })).toBe(s0);
  });

  it('duplicates blocks with fresh ids, offset, selected, and skips the table', () => {
    const s = run(start(), { type: 'duplicateBlocks', ids: ['title', 'items'] });
    const ids = s.doc.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(s.selection).toHaveLength(1);
    const copy = block(s, s.selection[0]);
    expect(copy.type).toBe('field');
    expect(copy.x).toBe(block(s, 'title').x + 12);
    expect(s.doc.blocks.filter((b) => b.type === 'lineItems')).toHaveLength(1);
    expect(invoiceTemplateDocumentSchema.safeParse(s.doc).success).toBe(true);
  });

  it('duplicates a locked block unlocked', () => {
    const s = run(
      start(),
      { type: 'updateBlocks', ids: ['title'], update: { locked: true } },
      { type: 'duplicateBlocks', ids: ['title'] },
    );
    expect(block(s, s.selection[0]).locked).toBeUndefined();
  });

  it('does not move locked blocks', () => {
    const s0 = run(start(), { type: 'updateBlocks', ids: ['title'], update: { locked: true } });
    const before = block(s0, 'title');
    const s1 = run(s0, { type: 'setRects', rects: { title: { x: 0, y: 0, w: 10, h: 10 } } });
    expect(block(s1, 'title')).toBe(before);
    const s2 = run(s0, { type: 'nudge', ids: ['title'], dx: 5, dy: 5 });
    expect(block(s2, 'title')).toBe(before);
  });

  it('clamps rectangles to the schema limits', () => {
    const s = run(start(), { type: 'setRects', rects: { title: { x: -500, y: 5000, w: 0, h: 99999 } } });
    const t = block(s, 'title');
    expect(t.x).toBe(-50);
    expect(t.y).toBe(1000);
    expect(t.w).toBe(2);
    expect(t.h).toBe(1000);
  });

  it('coalesces arrow nudges of the same selection', () => {
    let s = start();
    for (let i = 0; i < 5; i++) s = run(s, { type: 'nudge', ids: ['title'], dx: 1, dy: 0 });
    expect(s.past).toHaveLength(1);
    expect(block(s, 'title').x).toBe(block(start(), 'title').x + 5);
  });
});

describe('editorReducer: selection', () => {
  it('replaces, toggles and adds', () => {
    let s = run(start(), { type: 'select', ids: ['title'] });
    expect(s.selection).toEqual(['title']);
    s = run(s, { type: 'select', ids: ['number'], mode: 'toggle' });
    expect(s.selection.sort()).toEqual(['number', 'title']);
    s = run(s, { type: 'select', ids: ['title'], mode: 'toggle' });
    expect(s.selection).toEqual(['number']);
    s = run(s, { type: 'select', ids: ['seller'], mode: 'add' });
    expect(s.selection.sort()).toEqual(['number', 'seller']);
  });

  it('ignores ids that do not exist', () => {
    expect(run(start(), { type: 'select', ids: ['nope'] }).selection).toEqual([]);
  });

  it('drops selected ids that undo removes', () => {
    let s = run(start(), { type: 'addBlock', block: createBlock('text', 'text-1') });
    expect(s.selection).toEqual(['text-1']);
    s = run(s, { type: 'undo' });
    expect(s.selection).toEqual([]);
  });
});

describe('editorReducer: z-order', () => {
  const order = (s: EditorState) => s.doc.blocks.map((b) => b.id);

  it('brings a block to the front and sends it to the back', () => {
    const s0 = start();
    const front = run(s0, { type: 'arrange', ids: ['logo'], op: 'front' });
    expect(order(front).at(-1)).toBe('logo');
    const back = run(s0, { type: 'arrange', ids: ['title'], op: 'back' });
    expect(order(back)[0]).toBe('title');
  });

  it('moves one step forward and backward', () => {
    const s0 = start();
    const [a, b, c] = order(s0);
    const fwd = run(s0, { type: 'arrange', ids: [a], op: 'forward' });
    expect(order(fwd).slice(0, 3)).toEqual([b, a, c]);
    const back = run(fwd, { type: 'arrange', ids: [a], op: 'backward' });
    expect(order(back).slice(0, 3)).toEqual([a, b, c]);
  });

  it('does nothing at the end of the stack', () => {
    const s0 = start();
    const last = order(s0).at(-1)!;
    expect(run(s0, { type: 'arrange', ids: [last], op: 'forward' })).toBe(s0);
  });

  it('keeps the relative order of several blocks', () => {
    const s0 = start();
    const [a, b] = order(s0);
    const s = run(s0, { type: 'arrange', ids: [b, a], op: 'front' });
    expect(order(s).slice(-2)).toEqual([a, b]);
  });

  it('sets a whole new order, but only a permutation', () => {
    const s0 = start();
    const reversed = [...order(s0)].reverse();
    expect(order(run(s0, { type: 'setOrder', order: reversed }))).toEqual(reversed);
    expect(run(s0, { type: 'setOrder', order: ['title'] })).toBe(s0);
  });
});

describe('editorReducer: document', () => {
  it('updates the theme as one undoable step', () => {
    const s = run(start(), { type: 'updateDoc', update: (d) => ({ ...d, theme: { ...d.theme, font: 'times' } }) });
    expect(s.doc.theme.font).toBe('times');
    expect(run(s, { type: 'undo' }).doc.theme.font).toBe('helvetica');
  });

  it('replaces the document and clears the selection', () => {
    const s = run(start(), { type: 'select', ids: ['title'] }, { type: 'replaceDoc', doc: presetTemplate('modern', 'a4') });
    expect(s.selection).toEqual([]);
    expect(canUndo(s)).toBe(true);
  });

  it('resets history on load', () => {
    const s = run(start(), { type: 'updateBlocks', ids: ['title'], update: { x: 3 } }, { type: 'reset', doc: presetTemplate('minimal', 'letter') });
    expect(canUndo(s)).toBe(false);
    expect(isDirty(s)).toBe(false);
  });
});
