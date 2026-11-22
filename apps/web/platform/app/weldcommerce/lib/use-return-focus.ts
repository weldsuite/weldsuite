import { useEffect, useRef } from 'react';

/**
 * For a button that opens an editor in place of itself (it hides while the
 * editor is open). When the editor closes with focus inside it, that focus
 * goes with it to the page; this puts it back on the button instead. Focus
 * that already moved elsewhere (another row's editor, say) is left alone.
 */
export function useReturnFocus<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    const active = document.activeElement;
    if (wasOpen.current && !open && (active === null || active === document.body)) ref.current?.focus();
    wasOpen.current = open;
  }, [open]);
  return ref;
}
