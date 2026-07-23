import { useEffect } from 'react';

/**
 * Object-panel layout reservation.
 *
 * The host (`ObjectPanelHost`) calls this hook so any module layout that
 * wants to shrink its content area when a panel opens can do so without a JS
 * subscriber — it just reads a CSS variable.
 *
 * Today we expose two variables on `:root`:
 *
 *   --object-panel-reservation-width   (always set, defaults to `0px`)
 *   --object-panel-reservation-open    (`1` when the stack is non-empty, `0` otherwise)
 *
 * A module layout reserves space with:
 *
 *   padding-right: var(--object-panel-reservation-width, 0px);
 *
 * or, in Tailwind:
 *
 *   className="pr-[var(--object-panel-reservation-width,0px)]"
 *
 * The legacy `object-panel-reservation` window event is still dispatched for
 * one release so any consumer that hasn't migrated keeps working; remove the
 * dispatch once all listeners are gone.
 */

const ROOT_VAR_WIDTH = '--object-panel-reservation-width';
const ROOT_VAR_OPEN = '--object-panel-reservation-open';

export function usePanelLayoutReservation(
  _legacyEventName: string,
  isOpen: boolean,
  width: number,
) {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const effectiveWidth = isOpen ? width : 0;
    root.style.setProperty(ROOT_VAR_WIDTH, `${effectiveWidth}px`);
    root.style.setProperty(ROOT_VAR_OPEN, isOpen ? '1' : '0');

    // Legacy bridge — keep dispatching the window event so any not-yet-migrated
    // listener still works. Remove once every layout consumes the CSS var.
    window.dispatchEvent(
      new CustomEvent('object-panel-reservation', {
        detail: { isOpen, width: effectiveWidth },
      }),
    );

    return () => {
      root.style.setProperty(ROOT_VAR_WIDTH, '0px');
      root.style.setProperty(ROOT_VAR_OPEN, '0');
      window.dispatchEvent(
        new CustomEvent('object-panel-reservation', {
          detail: { isOpen: false, width: 0 },
        }),
      );
    };
  }, [isOpen, width]);
}
