import type { DocController } from './doc-controller';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Handles a key press in the editor. Returns true when it was an editor
 * command (the caller then prevents the browser's default). Typing itself
 * arrives through `beforeinput`, so IMEs and dead keys work.
 */
export function handleKey(ctl: DocController, e: KeyboardEvent | React.KeyboardEvent): boolean {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const word = IS_MAC ? e.altKey : e.ctrlKey;
  const shift = e.shiftKey;
  const key = e.key;
  const code = e.code;

  // Moving around (with Shift: selecting).
  switch (key) {
    case 'ArrowLeft':
      if (IS_MAC && e.metaKey) ctl.move(-1, 'lineEdge', shift);
      else ctl.move(-1, word ? 'word' : 'char', shift);
      return true;
    case 'ArrowRight':
      if (IS_MAC && e.metaKey) ctl.move(1, 'lineEdge', shift);
      else ctl.move(1, word ? 'word' : 'char', shift);
      return true;
    case 'ArrowUp':
      if (mod) ctl.move(-1, IS_MAC ? 'document' : 'paragraph', shift);
      else ctl.move(-1, 'line', shift);
      return true;
    case 'ArrowDown':
      if (mod) ctl.move(1, IS_MAC ? 'document' : 'paragraph', shift);
      else ctl.move(1, 'line', shift);
      return true;
    case 'Home':
      ctl.move(-1, mod ? 'document' : 'lineEdge', shift);
      return true;
    case 'End':
      ctl.move(1, mod ? 'document' : 'lineEdge', shift);
      return true;
    case 'PageUp':
      ctl.move(-1, 'page', shift);
      return true;
    case 'PageDown':
      ctl.move(1, 'page', shift);
      return true;
  }

  if (mod && !e.altKey) {
    switch (key.toLowerCase()) {
      case 'a':
        ctl.selectAll();
        return true;
      case 'z':
        if (shift) ctl.redo();
        else ctl.undo();
        return true;
      case 'y':
        ctl.redo();
        return true;
      case 'f':
      case 'h':
        ctl.openFind();
        return true;
      case 'p':
        ctl.setPrinting(true);
        return true;
      case 's':
        // Saving is automatic; keep the browser's save dialog away.
        return true;
      case '/':
        ctl.openDialog('shortcuts');
        return true;
    }
    if (shift && e.code === 'KeyC') {
      ctl.openDialog('wordCount');
      return true;
    }
  }

  if (ctl.readOnly) return false;

  if (mod && !e.altKey) {
    if (shift) {
      switch (code) {
        case 'Digit7':
          ctl.toggleList('numbered');
          return true;
        case 'Digit8':
          ctl.toggleList('bullet');
          return true;
        case 'Digit9':
          ctl.toggleList('check');
          return true;
        case 'KeyL':
          ctl.setParagraph({ align: null });
          return true;
        case 'KeyE':
          ctl.setParagraph({ align: 'center' });
          return true;
        case 'KeyR':
          ctl.setParagraph({ align: 'right' });
          return true;
        case 'KeyJ':
          ctl.setParagraph({ align: 'justify' });
          return true;
        case 'KeyX':
          ctl.toggle('strike');
          return true;
      }
    }
    switch (key) {
      case 'b':
      case 'B':
        ctl.toggle('bold');
        return true;
      case 'i':
      case 'I':
        ctl.toggle('italic');
        return true;
      case 'u':
      case 'U':
        ctl.toggle('underline');
        return true;
      case 'k':
      case 'K':
        ctl.openDialog('link');
        return true;
      case '.':
        ctl.toggleScript('super');
        return true;
      case ',':
        ctl.toggleScript('sub');
        return true;
      case '\\':
        ctl.clearFormatting();
        return true;
      case '[':
        ctl.indent(-1);
        return true;
      case ']':
        ctl.indent(1);
        return true;
      case 'Enter':
        ctl.insertPageBreak();
        return true;
      case 'Backspace':
        ctl.backspace(true);
        return true;
      case 'Delete':
        ctl.deleteForward(true);
        return true;
    }
  }

  // Ctrl+Alt+0 normal text, 1–6 headings (Cmd+Option on a Mac).
  if (mod && e.altKey && /^Digit[0-6]$/.test(code)) {
    const n = Number(code.slice(5));
    ctl.setParagraphStyle(n === 0 ? 'normal' : `heading${n}`);
    return true;
  }
  if (e.altKey && shift && code === 'Digit5') {
    ctl.toggle('strike');
    return true;
  }

  switch (key) {
    case 'Enter':
      if (shift) ctl.lineBreak();
      else ctl.enter();
      return true;
    case 'Backspace':
      ctl.backspace(e.altKey);
      return true;
    case 'Delete':
      ctl.deleteForward(e.altKey);
      return true;
    case 'Tab':
      ctl.tab(shift);
      return true;
    case 'Escape':
      if (ctl.find) {
        ctl.closeFind();
        return true;
      }
      return false;
  }
  return false;
}

export const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl';
