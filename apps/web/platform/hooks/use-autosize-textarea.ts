import { useLayoutEffect, type RefObject } from 'react';

/**
 * Keeps a textarea exactly as tall as its content, wrapped lines included, for
 * single-field editors such as document titles. Re-measures whenever `value`
 * changes and whenever the textarea's width changes (wrapping depends on it).
 */
export function useAutosizeTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const resize = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    };
    resize();
    if (typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      resize();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, value]);
}
