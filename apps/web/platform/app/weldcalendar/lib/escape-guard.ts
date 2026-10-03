/**
 * Containers whose own Escape handling must win over the calendar's global
 * "Escape closes the cards" shortcut: dialogs, popovers (Radix portals them to
 * the body, wrapped in a popper wrapper), listboxes / comboboxes, menus, cmdk.
 */
const POPUP_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="combobox"][aria-expanded="true"]',
  '[data-radix-popper-content-wrapper]',
  '[cmdk-root]',
].join(',');

function asElement(target: EventTarget | null): Element | null {
  return typeof Element !== 'undefined' && target instanceof Element ? target : null;
}

/**
 * True when an Escape keydown was (or is about to be) consumed by something
 * more specific than the calendar: a Radix layer that already dismissed itself
 * (it calls `preventDefault`), or focus that sits inside a popup.
 */
export function isEscapeHandledElsewhere(e: { defaultPrevented: boolean; target: EventTarget | null }): boolean {
  if (e.defaultPrevented) return true;
  const el = asElement(e.target);
  return !!el?.closest(POPUP_SELECTOR);
}

/** True when the key was pressed in a text field that has its own Escape (cancel edit) behaviour. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = asElement(target);
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLElement && el.isContentEditable === true) return true;
  // jsdom has no `isContentEditable`; the attribute (nearest ancestor wins) says the same thing.
  const attr = el.closest('[contenteditable]')?.getAttribute('contenteditable');
  return attr != null && attr !== 'false';
}
