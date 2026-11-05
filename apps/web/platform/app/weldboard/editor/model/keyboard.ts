/**
 * Keyboard shortcuts on the board, close to Miro's. Returns true when a key
 * was handled (the view then prevents the browser's default).
 */

import { alignOps, groupOps, moveOps, newId, stackOps, ungroupOps } from '@weldsuite/board-engine';
import type { BoardController } from './board-controller';
import { nextZoom } from './camera';
import { duplicateSelection } from './clipboard';
import { copyStyle, pasteStyle } from './style';
import { focusStep } from './focus';
import type { Interactions } from './interactions';
import { deleteBackward, deleteForward, insertText, moveCaret, selectAllText, toggleMark } from './text-editing';
import { TOOL_KEYS } from './tools';

export interface KeyInfo {
  key: string;
  shift: boolean;
  alt: boolean;
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  mod: boolean;
  /** An IME composition is in progress: leave keys to it. */
  composing?: boolean;
}

export interface KeyActions {
  openShortcuts?: () => void;
  openLink?: () => void;
  togglePresent?: () => void;
  openFind?: () => void;
}

/** What one key does; true when it was handled. */
type KeyHandler = (c: BoardController, k: KeyInfo, ia: Interactions, actions: KeyActions) => boolean;

/** A key that is always handled. */
function always(run: (c: BoardController, k: KeyInfo, ia: Interactions, actions: KeyActions) => void): KeyHandler {
  return (c, k, ia, actions) => {
    run(c, k, ia, actions);
    return true;
  };
}

/** A key left to the browser (the clipboard events handle cut, copy and paste). */
const unhandled: KeyHandler = () => false;

/** Alt or Ctrl/Cmd: the caret moves and deletes by word. */
function byWord(k: KeyInfo): boolean {
  return k.alt || k.mod;
}

function undoOrRedo(c: BoardController, k: KeyInfo): boolean {
  if (k.shift) c.redo();
  else c.undo();
  return true;
}

const redo = always((c) => c.redo());

// ---------------------------------------------------------------- editing text

/** Keys while editing text, by `KeyInfo.key`. */
const TEXT_KEYS = new Map<string, KeyHandler>([
  ['Escape', always((c) => c.stopEditing())],
  ['Backspace', always((c, k) => deleteBackward(c, byWord(k)))],
  ['Delete', always((c, k) => deleteForward(c, byWord(k)))],
  ['ArrowLeft', always((c, k) => moveCaret(c, 'left', k.shift, byWord(k)))],
  ['ArrowRight', always((c, k) => moveCaret(c, 'right', k.shift, byWord(k)))],
  ['ArrowUp', always((c, k) => moveCaret(c, k.mod ? 'start' : 'up', k.shift))],
  ['ArrowDown', always((c, k) => moveCaret(c, k.mod ? 'end' : 'down', k.shift))],
  ['Home', always((c, k) => moveCaret(c, k.mod ? 'start' : 'lineStart', k.shift))],
  ['End', always((c, k) => moveCaret(c, k.mod ? 'end' : 'lineEnd', k.shift))],
  [
    'Enter',
    always((c, k) => {
      // Enter adds a line; Ctrl/Cmd+Enter (or Enter in a connector label) finishes.
      if (k.mod) c.stopEditing();
      else insertText(c, '\n');
    }),
  ],
  ['Tab', always(() => undefined)],
]);

/** Ctrl/Cmd keys while editing text, by lower-cased key. */
const TEXT_MOD_KEYS = new Map<string, KeyHandler>([
  ['a', always((c) => selectAllText(c))],
  ['b', always((c) => toggleMark(c, 'b'))],
  ['i', always((c) => toggleMark(c, 'i'))],
  ['u', always((c) => toggleMark(c, 'u'))],
  ['x', unhandled],
  ['c', unhandled],
  ['v', unhandled],
  ['z', undoOrRedo],
  ['y', redo],
  [
    's',
    (c, k) => {
      if (!k.shift) return false;
      toggleMark(c, 's');
      return true;
    },
  ],
]);

/** Keys while editing text. */
function textKey(c: BoardController, k: KeyInfo, ia: Interactions, actions: KeyActions): boolean {
  const handler = TEXT_KEYS.get(k.key) ?? (k.mod ? TEXT_MOD_KEYS.get(k.key.toLowerCase()) : undefined);
  return handler ? handler(c, k, ia, actions) : false;
}

// ---------------------------------------------------------------- the board

/** Ctrl/Cmd+G groups the selection; with Shift it ungroups the selected groups. */
function groupKey(c: BoardController, k: KeyInfo): void {
  if (c.readOnly) return;
  const sel = [...c.selection];
  if (k.shift) {
    for (const id of sel) if (c.board.get(id)?.type === 'group') c.apply(ungroupOps(c.board, id), { select: c.board.childIds(id) });
  } else if (sel.length > 1) {
    const id = newId('g');
    c.apply(groupOps(c.board, sel, id), { select: [id] });
  }
}

/** Ctrl/Cmd+L locks the selection, or unlocks it when all of it is locked. */
function lockKey(c: BoardController): void {
  if (c.readOnly) return;
  const els = c.selected;
  const lock = !els.every((e) => e.locked);
  c.apply({ type: 'batch', ops: els.map((e) => ({ type: 'set' as const, id: e.id, patch: { locked: lock } })) });
}

const zoomIn = always((c) => c.zoomTo(nextZoom(c.camera.zoom, 1)));

/** Ctrl/Cmd keys on the board, by lower-cased key. */
const MOD_KEYS = new Map<string, KeyHandler>([
  ['z', undoOrRedo],
  ['y', redo],
  ['a', always((c) => c.selectAll())],
  ['d', always((c) => duplicateSelection(c))],
  ['g', always(groupKey)],
  ['l', always(lockKey)],
  ['k', always((_c, _k, _ia, actions) => actions.openLink?.())],
  ['f', always((_c, _k, _ia, actions) => actions.openFind?.())],
  [
    'p',
    (c, k) => {
      if (!k.alt) return false;
      pasteStyle(c);
      return true;
    },
  ],
  [']', always((c) => c.apply(stackOps(c.board, c.selection, 'front')))],
  ['[', always((c) => c.apply(stackOps(c.board, c.selection, 'back')))],
  ['=', zoomIn],
  ['+', zoomIn],
  ['-', always((c) => c.zoomTo(nextZoom(c.camera.zoom, -1)))],
  ['0', always((c) => c.zoomTo(1))],
  [
    'c',
    (c, k) => {
      if (k.alt) {
        copyStyle(c);
        return true;
      }
      return false;
    },
  ],
  ['x', unhandled],
  ['v', unhandled],
]);

/** Ctrl/Cmd+Alt with these keys aligns the selection (unless the key has a Ctrl/Cmd shortcut of its own). */
const ALIGN_KEYS: Record<string, Parameters<typeof alignOps>[2]> = { a: 'left', d: 'right', w: 'top', s: 'bottom', h: 'center', v: 'middle' };

function modKey(c: BoardController, k: KeyInfo, key: string, ia: Interactions, actions: KeyActions): boolean {
  const handler = MOD_KEYS.get(key);
  if (handler) return handler(c, k, ia, actions);
  if (k.alt) {
    const mode = ALIGN_KEYS[key];
    if (mode) {
      c.apply(alignOps(c.board, c.selection, mode));
      return true;
    }
  }
  return false;
}

/** Shift+1 fits the board, Shift+2 the selection, ? opens the shortcuts. False for any other key. */
function shiftKey(c: BoardController, k: KeyInfo, key: string, actions: KeyActions): boolean {
  if (key === '!' || k.key === '1') {
    c.zoomToFit();
    return true;
  }
  if (key === '@' || k.key === '2') {
    c.zoomToSelection();
    return true;
  }
  if (key === '?') {
    actions.openShortcuts?.();
    return true;
  }
  return false;
}

function escapeKey(c: BoardController, _k: KeyInfo, ia: Interactions): boolean {
  if (ia.dragging) ia.cancel();
  else if (c.tool !== 'select') c.setTool('select');
  else c.select([]);
  return true;
}

/** Enter adds a mind-map sibling, or starts editing the one selected element. */
function enterKey(c: BoardController, _k: KeyInfo, ia: Interactions): boolean {
  if (ia.addMindMapNode('sibling')) return true;
  if (c.selection.size === 1) {
    const el = c.selected[0]!;
    if (c.canEditText(el) || el.type === 'connector') c.startEditing(el.id);
    return true;
  }
  return false;
}

/** A mind-map node grows a child; otherwise Tab walks the board's elements. */
function tabKey(c: BoardController, k: KeyInfo, ia: Interactions): boolean {
  if (!k.shift && ia.addMindMapNode('child')) return true;
  return focusStep(c, k.shift ? -1 : 1);
}

/** How far an arrow key moves the selection. */
function nudgeDelta(key: string, step: number): { dx: number; dy: number } {
  if (key === 'ArrowLeft') return { dx: -step, dy: 0 };
  if (key === 'ArrowRight') return { dx: step, dy: 0 };
  if (key === 'ArrowUp') return { dx: 0, dy: -step };
  return { dx: 0, dy: step };
}

/** Arrows nudge the selection, 10 with Shift. */
function nudgeKey(c: BoardController, k: KeyInfo): boolean {
  if (!c.selection.size || c.readOnly) return false;
  const { dx, dy } = nudgeDelta(k.key, k.shift ? 10 : 1);
  c.apply(moveOps(c.board, c.selected.filter((e) => !e.locked).map((e) => e.id), dx, dy), { gesture: 'nudge' });
  return true;
}

/** Keys on the board without Ctrl/Cmd, by `KeyInfo.key`. */
const PLAIN_KEYS = new Map<string, KeyHandler>([
  ['Escape', escapeKey],
  ['Delete', always((c) => c.deleteSelection())],
  ['Backspace', always((c) => c.deleteSelection())],
  ['Enter', enterKey],
  ['Tab', tabKey],
  ['ArrowLeft', nudgeKey],
  ['ArrowRight', nudgeKey],
  ['ArrowUp', nudgeKey],
  ['ArrowDown', nudgeKey],
  [']', always((c) => c.apply(stackOps(c.board, c.selection, 'forward')))],
  ['[', always((c) => c.apply(stackOps(c.board, c.selection, 'backward')))],
  ['F5', always((_c, _k, _ia, actions) => actions.togglePresent?.())],
]);

/** A tool's letter picks the tool; another character typed on a selected sticky or shape starts editing it. */
function toolOrTypingKey(c: BoardController, k: KeyInfo, key: string): boolean {
  const tool = TOOL_KEYS[key];
  if (tool && (!c.readOnly || tool === 'select' || tool === 'hand' || tool === 'comment')) {
    c.setTool(tool);
    return true;
  }
  // Typing on a selected sticky or shape starts editing it with that character (Space pans instead).
  if (k.key.length === 1 && k.key !== ' ' && c.selection.size === 1 && !c.readOnly) {
    const el = c.selected[0]!;
    if (c.canEditText(el)) {
      c.editing = { id: el.id, anchor: 0, head: el.text?.text.length ?? 0 };
      insertText(c, k.key);
      return true;
    }
  }
  return false;
}

export function handleKey(c: BoardController, ia: Interactions, k: KeyInfo, actions: KeyActions = {}): boolean {
  if (k.composing) return false;
  if (c.editing) return textKey(c, k, ia, actions);
  const key = k.key.toLowerCase();
  if (k.mod) return modKey(c, k, key, ia, actions);
  if (k.shift && shiftKey(c, k, key, actions)) return true;
  const plain = PLAIN_KEYS.get(k.key);
  if (plain) return plain(c, k, ia, actions);
  if (k.alt) return false;
  return toolOrTypingKey(c, k, key);
}
