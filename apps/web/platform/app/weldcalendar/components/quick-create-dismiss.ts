import { useEffect, type RefObject } from 'react';

/**
 * Selector of overlays that Radix (and our own inline dropdowns) portal out of
 * the quick-create card: popovers (date picker, repeat), selects, menus,
 * comboboxes and dialogs. They sit outside the card's DOM, but a click inside
 * one belongs to the card and must not count as an outside click.
 */
export const QUICK_CREATE_OVERLAY_SELECTOR = [
  '[data-radix-popper-content-wrapper]',
  '[data-radix-select-content]',
  '[data-slot="popover-content"]',
  '[data-slot="select-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="dialog-content"]',
  '[data-slot="alert-dialog-content"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[data-quick-create-overlay]',
].join(',');

/**
 * Whether a mousedown that reached the document started inside the card or in
 * an overlay opened from it. `composedPath()` is captured when the event is
 * dispatched, so this still works when the clicked control unmounted itself
 * (a picked day, a chosen guest) before the document listener ran.
 */
export function isInsideQuickCreate(path: EventTarget[], card: HTMLElement | null): boolean {
  if (card && path.includes(card)) return true;
  return path.some((node) => node instanceof Element && node.matches(QUICK_CREATE_OVERLAY_SELECTOR));
}

/**
 * Calls `onDismiss` on a mousedown outside the card while `enabled`. Clicks in
 * the card and in popovers / selects / dialogs opened from it do not count.
 */
export function useDismissOnOutsideMouseDown(
  enabled: boolean,
  cardRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!enabled) return;
    const handleMouseDown = (ev: MouseEvent) => {
      if (isInsideQuickCreate(ev.composedPath(), cardRef.current)) return;
      onDismiss();
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [enabled, cardRef, onDismiss]);
}
