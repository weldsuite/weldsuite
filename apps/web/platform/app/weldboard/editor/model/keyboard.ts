/**
 * Keyboard shortcuts on the board, close to Miro's. Returns true when a key
 * was handled (the view then prevents the browser's default).
 */

import { alignOps, groupOps, moveOps, newId, stackOps, ungroupOps } from '@weldsuite/board-engine';
import type { BoardController } from './board-controller';
import { nextZoom } from './camera';
import { duplicateSelection } from './clipboard';
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
}

/** Keys while editing text. */
function textKey(c: BoardController, k: KeyInfo): boolean {
  const word = k.alt || k.mod;
  switch (k.key) {
    case 'Escape':
      c.stopEditing();
      return true;
    case 'Backspace':
      deleteBackward(c, word);
      return true;
    case 'Delete':
      deleteForward(c, word);
      return true;
    case 'ArrowLeft':
      moveCaret(c, 'left', k.shift, word);
      return true;
    case 'ArrowRight':
      moveCaret(c, 'right', k.shift, word);
      return true;
    case 'ArrowUp':
      moveCaret(c, k.mod ? 'start' : 'up', k.shift);
      return true;
    case 'ArrowDown':
      moveCaret(c, k.mod ? 'end' : 'down', k.shift);
      return true;
    case 'Home':
      moveCaret(c, k.mod ? 'start' : 'lineStart', k.shift);
      return true;
    case 'End':
      moveCaret(c, k.mod ? 'end' : 'lineEnd', k.shift);
      return true;
    case 'Enter':
      // Enter adds a line; Ctrl/Cmd+Enter (or Enter in a connector label) finishes.
      if (k.mod) {
        c.stopEditing();
        return true;
      }
      insertText(c, '\n');
      return true;
    case 'Tab':
      return true;
  }
  if (k.mod) {
    switch (k.key.toLowerCase()) {
      case 'a':
        selectAllText(c);
        return true;
      case 'b':
        toggleMark(c, 'b');
        return true;
      case 'i':
        toggleMark(c, 'i');
        return true;
      case 'u':
        toggleMark(c, 'u');
        return true;
      case 'x':
      case 'c':
      case 'v':
        return false; // The clipboard events handle these.
      case 'z':
        if (k.shift) c.redo();
        else c.undo();
        return true;
      case 'y':
        c.redo();
        return true;
    }
    if (k.shift && k.key.toLowerCase() === 's') {
      toggleMark(c, 's');
      return true;
    }
  }
  return false;
}

export function handleKey(c: BoardController, ia: Interactions, k: KeyInfo, actions: KeyActions = {}): boolean {
  if (k.composing) return false;
  if (c.editing) return textKey(c, k);
  const key = k.key.toLowerCase();

  if (k.mod) {
    switch (key) {
      case 'z':
        if (k.shift) c.redo();
        else c.undo();
        return true;
      case 'y':
        c.redo();
        return true;
      case 'a':
        c.selectAll();
        return true;
      case 'd':
        duplicateSelection(c);
        return true;
      case 'g': {
        if (c.readOnly) return true;
        const sel = [...c.selection];
        if (k.shift) {
          for (const id of sel) if (c.board.get(id)?.type === 'group') c.apply(ungroupOps(c.board, id), { select: c.board.childIds(id) });
        } else if (sel.length > 1) {
          const id = newId('g');
          c.apply(groupOps(c.board, sel, id), { select: [id] });
        }
        return true;
      }
      case 'l': {
        if (c.readOnly) return true;
        const els = c.selected;
        const lock = !els.every((e) => e.locked);
        c.apply({ type: 'batch', ops: els.map((e) => ({ type: 'set' as const, id: e.id, patch: { locked: lock } })) });
        return true;
      }
      case 'k':
        actions.openLink?.();
        return true;
      case ']':
        c.apply(stackOps(c.board, c.selection, 'front'));
        return true;
      case '[':
        c.apply(stackOps(c.board, c.selection, 'back'));
        return true;
      case '=':
      case '+':
        c.zoomTo(nextZoom(c.camera.zoom, 1));
        return true;
      case '-':
        c.zoomTo(nextZoom(c.camera.zoom, -1));
        return true;
      case '0':
        c.zoomTo(1);
        return true;
      case 'c':
      case 'x':
      case 'v':
        return false;
    }
    if (k.alt) {
      const align: Record<string, Parameters<typeof alignOps>[2]> = { a: 'left', d: 'right', w: 'top', s: 'bottom', h: 'center', v: 'middle' };
      const mode = align[key];
      if (mode) {
        c.apply(alignOps(c.board, c.selection, mode));
        return true;
      }
    }
    return false;
  }

  if (k.shift) {
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
  }

  switch (k.key) {
    case 'Escape':
      if (ia.dragging) ia.cancel();
      else if (c.tool !== 'select') c.setTool('select');
      else c.select([]);
      return true;
    case 'Delete':
    case 'Backspace':
      c.deleteSelection();
      return true;
    case 'Enter':
      if (ia.addMindMapNode('sibling')) return true;
      if (c.selection.size === 1) {
        const el = c.selected[0]!;
        if (c.canEditText(el) || el.type === 'connector') c.startEditing(el.id);
        return true;
      }
      return false;
    case 'Tab':
      return ia.addMindMapNode('child');
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown': {
      if (!c.selection.size || c.readOnly) return false;
      const step = k.shift ? 10 : 1;
      const dx = k.key === 'ArrowLeft' ? -step : k.key === 'ArrowRight' ? step : 0;
      const dy = k.key === 'ArrowUp' ? -step : k.key === 'ArrowDown' ? step : 0;
      c.apply(moveOps(c.board, c.selected.filter((e) => !e.locked).map((e) => e.id), dx, dy), { gesture: 'nudge' });
      return true;
    }
    case ']':
      c.apply(stackOps(c.board, c.selection, 'forward'));
      return true;
    case '[':
      c.apply(stackOps(c.board, c.selection, 'backward'));
      return true;
    case 'F5':
      actions.togglePresent?.();
      return true;
  }

  if (k.alt) return false;
  const tool = TOOL_KEYS[key];
  if (tool && (!c.readOnly || tool === 'select' || tool === 'hand' || tool === 'comment')) {
    c.setTool(tool);
    return true;
  }
  // Typing on a selected sticky or shape starts editing it with that character.
  if (k.key.length === 1 && c.selection.size === 1 && !c.readOnly) {
    const el = c.selected[0]!;
    if (c.canEditText(el)) {
      c.editing = { id: el.id, anchor: 0, head: el.text?.text.length ?? 0 };
      insertText(c, k.key);
      return true;
    }
  }
  return false;
}
