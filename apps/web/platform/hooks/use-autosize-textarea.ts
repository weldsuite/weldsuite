import { useLayoutEffect, type RefObject } from 'react';

/**
 * Keeps a textarea exactly as tall as its content, wrapped lines included, for
 * single-field editors such as document titles. Re-measures whenever `value`
 * changes.
 */
export function useAutosizeTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}
