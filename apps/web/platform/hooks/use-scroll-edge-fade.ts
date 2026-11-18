import { useEffect, useRef, type RefObject } from 'react';

/**
 * Marks the edges of a scroll container that have content scrolled out of
 * view, with `data-fade-top` and `data-fade-bottom`, so CSS can fade them out
 * instead of slicing an item in half (`.app-rail-scroll` in globals.css).
 *
 * The attributes are set on the node directly, so scrolling never re-renders.
 * They are re-checked on scroll, on resize and when the children change.
 */
export function useScrollEdgeFade<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      el.toggleAttribute('data-fade-top', el.scrollTop > 1);
      el.toggleAttribute('data-fade-bottom', el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(el);
    const mutationObserver = new MutationObserver(update);
    mutationObserver.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener('scroll', update);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  return ref;
}
