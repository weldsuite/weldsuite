import type { DocController, Movement } from './doc-controller';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

type KeyEvent = KeyboardEvent | React.KeyboardEvent;
/** An editor command for a key; returning false means the key was not handled after all. */
type Command = (ctl: DocController, e: KeyEvent) => boolean | void;

/** Ctrl (Cmd on a Mac). */
const modKey = (e: KeyEvent) => (IS_MAC ? e.metaKey : e.ctrlKey);
/** The modifier that moves by words: Ctrl (Option on a Mac). */
const wordKey = (e: KeyEvent) => (IS_MAC ? e.altKey : e.ctrlKey);

/** Left and right: by character, by word, or (Cmd on a Mac) to the line's edge. */
function horizontalUnit(e: KeyEvent): Movement {
  if (IS_MAC && e.metaKey) return 'lineEdge';
  return wordKey(e) ? 'word' : 'char';
}

/** Up and down: by line, or with the modifier by paragraph (to the document's edge on a Mac). */
function verticalUnit(e: KeyEvent): Movement {
  if (!modKey(e)) return 'line';
  return IS_MAC ? 'document' : 'paragraph';
}

/** Moving around (with Shift: selecting). Works in a read-only document too. */
const NAVIGATION = new Map<string, Command>([
  ['ArrowLeft', (ctl, e) => ctl.move(-1, horizontalUnit(e), e.shiftKey)],
  ['ArrowRight', (ctl, e) => ctl.move(1, horizontalUnit(e), e.shiftKey)],
  ['ArrowUp', (ctl, e) => ctl.move(-1, verticalUnit(e), e.shiftKey)],
  ['ArrowDown', (ctl, e) => ctl.move(1, verticalUnit(e), e.shiftKey)],
  ['Home', (ctl, e) => ctl.move(-1, modKey(e) ? 'document' : 'lineEdge', e.shiftKey)],
  ['End', (ctl, e) => ctl.move(1, modKey(e) ? 'document' : 'lineEdge', e.shiftKey)],
  ['PageUp', (ctl, e) => ctl.move(-1, 'page', e.shiftKey)],
  ['PageDown', (ctl, e) => ctl.move(1, 'page', e.shiftKey)],
]);

/** Ctrl + a key (lowercased) that does not change the document. */
const VIEW_KEYS = new Map<string, Command>([
  ['a', (ctl) => ctl.selectAll()],
  ['z', (ctl, e) => (e.shiftKey ? ctl.redo() : ctl.undo())],
  ['y', (ctl) => ctl.redo()],
  ['f', (ctl) => ctl.openFind()],
  ['h', (ctl) => ctl.openFind()],
  ['p', (ctl) => ctl.setPrinting(true)],
  // Saving is automatic; keep the browser's save dialog away.
  ['s', () => true],
  ['/', (ctl) => ctl.openDialog('shortcuts')],
]);

/** Ctrl+Shift + a key (by its physical code): lists, alignment, strikethrough. */
const SHIFT_EDIT_CODES = new Map<string, Command>([
  ['Digit7', (ctl) => ctl.toggleList('numbered')],
  ['Digit8', (ctl) => ctl.toggleList('bullet')],
  ['Digit9', (ctl) => ctl.toggleList('check')],
  ['KeyL', (ctl) => ctl.setParagraph({ align: null })],
  ['KeyE', (ctl) => ctl.setParagraph({ align: 'center' })],
  ['KeyR', (ctl) => ctl.setParagraph({ align: 'right' })],
  ['KeyJ', (ctl) => ctl.setParagraph({ align: 'justify' })],
  ['KeyX', (ctl) => ctl.toggle('strike')],
]);

const bold: Command = (ctl) => ctl.toggle('bold');
const italic: Command = (ctl) => ctl.toggle('italic');
const underline: Command = (ctl) => ctl.toggle('underline');
const link: Command = (ctl) => ctl.openDialog('link');

/** Ctrl + a key that edits the document. */
const EDIT_KEYS = new Map<string, Command>([
  ['b', bold],
  ['B', bold],
  ['i', italic],
  ['I', italic],
  ['u', underline],
  ['U', underline],
  ['k', link],
  ['K', link],
  ['.', (ctl) => ctl.toggleScript('super')],
  [',', (ctl) => ctl.toggleScript('sub')],
  ['\\', (ctl) => ctl.clearFormatting()],
  ['[', (ctl) => ctl.indent(-1)],
  [']', (ctl) => ctl.indent(1)],
  ['Enter', (ctl) => ctl.insertPageBreak()],
  ['Backspace', (ctl) => ctl.backspace(true)],
  ['Delete', (ctl) => ctl.deleteForward(true)],
]);

/** Keys that edit without Ctrl (or whose Ctrl combination is not a command). */
const PLAIN_KEYS = new Map<string, Command>([
  ['Enter', (ctl, e) => (e.shiftKey ? ctl.lineBreak() : ctl.enter())],
  ['Backspace', (ctl, e) => ctl.backspace(e.altKey)],
  ['Delete', (ctl, e) => ctl.deleteForward(e.altKey)],
  ['Tab', (ctl, e) => ctl.tab(e.shiftKey)],
  [
    'Escape',
    (ctl) => {
      if (!ctl.find) return false;
      ctl.closeFind();
      return true;
    },
  ],
]);

const wordCount: Command = (ctl) => ctl.openDialog('wordCount');

/** Ctrl+Alt+0 normal text, 1–6 headings (Cmd+Option on a Mac). */
const paragraphStyle: Command = (ctl, e) => {
  const n = Number(e.code.slice(5));
  ctl.setParagraphStyle(n === 0 ? 'normal' : `heading${n}`);
};

const strike: Command = (ctl) => ctl.toggle('strike');

/** The command for a key that does not change the document (allowed when read-only). */
function viewCommand(e: KeyEvent): Command | undefined {
  if (!modKey(e) || e.altKey) return undefined;
  const command = VIEW_KEYS.get(e.key.toLowerCase());
  if (command) return command;
  return e.shiftKey && e.code === 'KeyC' ? wordCount : undefined;
}

/** The command for a key that edits the document. */
function editCommand(e: KeyEvent): Command | undefined {
  const mod = modKey(e);
  if (mod && !e.altKey) {
    const command = (e.shiftKey ? SHIFT_EDIT_CODES.get(e.code) : undefined) ?? EDIT_KEYS.get(e.key);
    if (command) return command;
  }
  if (mod && e.altKey && /^Digit[0-6]$/.test(e.code)) return paragraphStyle;
  if (e.altKey && e.shiftKey && e.code === 'Digit5') return strike;
  return PLAIN_KEYS.get(e.key);
}

/** Runs a command; true when there was one and it handled the key. */
function run(command: Command | undefined, ctl: DocController, e: KeyEvent): boolean {
  return !!command && command(ctl, e) !== false;
}

/**
 * Handles a key press in the editor. Returns true when it was an editor
 * command (the caller then prevents the browser's default). Typing itself
 * arrives through `beforeinput`, so IMEs and dead keys work.
 */
export function handleKey(ctl: DocController, e: KeyEvent): boolean {
  const command = NAVIGATION.get(e.key) ?? viewCommand(e);
  if (command) return run(command, ctl, e);
  if (ctl.readOnly) return false;
  return run(editCommand(e), ctl, e);
}

export const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl';
