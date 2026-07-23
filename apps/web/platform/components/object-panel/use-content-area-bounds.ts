import { useEffect, useState } from 'react';

interface ContentAreaBounds {
  top: number;
  left: number;
}

const DRAWER_INSET_VAR = '--object-panel-drawer-inset';
const BOTTOM_INSET_VAR = '--object-panel-content-bottom-inset';

/**
 * Reports the bounding rect of the platform's module content area — the
 * `[data-module-content]` div rendered by each module layout (e.g.
 * `app/weldcrm/components/crm-layout-client.tsx`).
 *
 * Used by overlay-style panels (fullscreen mode) to set their `topOffset`
 * and `leftOffset` so they cover the content area only, leaving the
 * platform sidebar (64px) and the per-module sidebar (16rem when
 * expanded) visible.
 *
 * Right-side drawer inset (the cumulative width of any open Agent /
 * Calendar / Notifications drawer) is exposed as a CSS variable on
 * `:root` (`--object-panel-drawer-inset`) and is NOT reported as React
 * state on purpose. The content-area `ResizeObserver` fires every frame
 * during a drawer's open/close transition; routing that through
 * `setState` would re-render every open panel a dozen times in 200ms.
 * The variable is updated imperatively each frame, and `EntityDetailView`
 * consumes it inside a non-transitioned `left` calc — so the panel snaps
 * to the content area's right edge without React touching anything.
 *
 * Falls back to the platform header height + primary sidebar width when no
 * module sidebar is present.
 */
export function useContentAreaBounds(): ContentAreaBounds {
  const [bounds, setBounds] = useState<ContentAreaBounds>({ top: 60, left: 64 });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const root = document.documentElement;
    let lastTop = -1;
    let lastLeft = -1;
    let lastInset = -1;
    let lastBottom = -1;

    const update = () => {
      const el = document.querySelector('[data-module-content]') as HTMLElement | null;
      if (!el) {
        if (lastTop !== 60 || lastLeft !== 64) {
          lastTop = 60;
          lastLeft = 64;
          setBounds({ top: 60, left: 64 });
        }
        if (lastInset !== 0) {
          lastInset = 0;
          root.style.setProperty(DRAWER_INSET_VAR, '0px');
        }
        if (lastBottom !== 0) {
          lastBottom = 0;
          root.style.setProperty(BOTTOM_INSET_VAR, '0px');
        }
        return;
      }
      const rect = el.getBoundingClientRect();
      // The content also shrinks by `--object-panel-reservation-width`
      // when the panel itself is open, so we subtract that out —
      // otherwise the panel would double-count its own reservation.
      const reservationStr = getComputedStyle(root)
        .getPropertyValue('--object-panel-reservation-width')
        .trim();
      const reservation = parseFloat(reservationStr) || 0;
      const rightInset = Math.max(0, Math.floor(window.innerWidth - rect.right - reservation));
      const bottomInset = Math.max(0, Math.floor(window.innerHeight - rect.bottom));
      const top = Math.floor(rect.top);
      const left = Math.floor(rect.left);

      // Write the drawer + bottom insets straight to CSS variables — never
      // through React state — so we don't re-render the world on every
      // ResizeObserver tick. The fullscreen object-panel overlay reads them to
      // sit exactly over the module content card (rounded, inset), tracking any
      // open drawer on the right without a React round-trip.
      if (rightInset !== lastInset) {
        lastInset = rightInset;
        root.style.setProperty(DRAWER_INSET_VAR, `${rightInset}px`);
      }
      if (bottomInset !== lastBottom) {
        lastBottom = bottomInset;
        root.style.setProperty(BOTTOM_INSET_VAR, `${bottomInset}px`);
      }

      // `top` / `left` only meaningfully change on layout-level events
      // (window resize, module sidebar collapse). Cheap to dedupe.
      if (top !== lastTop || left !== lastLeft) {
        lastTop = top;
        lastLeft = left;
        setBounds({ top, left });
      }
    };

    update();
    window.addEventListener('resize', update);

    let observer: ResizeObserver | undefined;
    let mutationObserver: MutationObserver | undefined;
    const target = document.querySelector('[data-module-content]');
    if (target && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update);
      observer.observe(target);
    }
    // The module sidebar collapse/expand transitions don't always fire a
    // window resize — observe DOM mutations on its parent so we catch
    // class changes.
    if (typeof MutationObserver !== 'undefined') {
      mutationObserver = new MutationObserver(update);
      mutationObserver.observe(document.body, {
        attributes: true,
        subtree: true,
        attributeFilter: ['class', 'style', 'data-state'],
      });
    }

    return () => {
      window.removeEventListener('resize', update);
      observer?.disconnect();
      mutationObserver?.disconnect();
    };
  }, []);

  return bounds;
}
