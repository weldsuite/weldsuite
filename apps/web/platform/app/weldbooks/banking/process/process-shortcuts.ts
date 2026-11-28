/**
 * Keyboard shortcuts of the processing view. `J`/`K` move through the queue,
 * Enter accepts the suggestion, `C R T P I U` run an action and `?` opens the
 * list. They never fire while somebody types (an input, textarea, select,
 * contenteditable or an open list), while a dialog is open, with a modifier
 * held or on a control that already owns the key (Enter on a button).
 */

import { useEffect, useRef } from 'react';

export type ProcessShortcut =
  | 'next'
  | 'previous'
  | 'accept'
  | 'category'
  | 'receipt'
  | 'transfer'
  | 'private'
  | 'ignore'
  | 'undo'
  | 'help'
  | 'close';

const LETTER_SHORTCUTS: Readonly<Record<string, ProcessShortcut>> = {
  j: 'next',
  k: 'previous',
  c: 'category',
  r: 'receipt',
  t: 'transfer',
  p: 'private',
  i: 'ignore',
  u: 'undo',
};

const TYPING_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
].join(',');

/** Controls that act on Enter themselves: the shortcut must not steal it. */
const ENTER_OWNER_SELECTOR = 'button, a[href], summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"]';

const OPEN_DIALOG_SELECTOR = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], dialog[open]';

/** Somebody is typing, or choosing from an open list. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TYPING_SELECTOR) !== null;
}

/** A modal dialog or sheet is open anywhere on the page. */
export function isDialogOpen(doc: Document = document): boolean {
  return doc.querySelector(OPEN_DIALOG_SELECTOR) !== null;
}

type KeyEventLike = Pick<
  KeyboardEvent,
  'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'repeat' | 'defaultPrevented' | 'target'
>;

/**
 * The shortcut a key press stands for, or null when it must be left alone:
 * not a shortcut key, a modifier held, composing text, typing in a field, or a
 * dialog open.
 */
export function shortcutFor(event: KeyEventLike, doc: Document = document): ProcessShortcut | null {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isTypingTarget(event.target) || isDialogOpen(doc)) return null;

  let shortcut: ProcessShortcut | null = null;
  if (event.key === 'Enter') {
    // A focused button or link takes Enter for itself.
    const owned = event.target instanceof Element && event.target.closest(ENTER_OWNER_SELECTOR) !== null;
    shortcut = owned ? null : 'accept';
  } else if (event.key === 'Escape') {
    shortcut = 'close';
  } else if (event.key === '?') {
    shortcut = 'help';
  } else {
    shortcut = LETTER_SHORTCUTS[event.key.toLowerCase()] ?? null;
  }
  // Holding a key down repeats it; only moving through the queue may repeat.
  if (shortcut && event.repeat && shortcut !== 'next' && shortcut !== 'previous') return null;
  return shortcut;
}

/**
 * Runs the handler of the shortcut a key press stands for. A shortcut without
 * a handler is left to the browser (so Escape still closes what it closes).
 */
export function useProcessShortcuts(
  enabled: boolean,
  handlers: Partial<Record<ProcessShortcut, () => void>>,
): void {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = shortcutFor(event);
      const handler = shortcut ? latest.current[shortcut] : undefined;
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
