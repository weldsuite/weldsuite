import { useEffect, type RefObject } from 'react';

/**
 * Room (px) a table has left to grow before it overflows its wrapper. The
 * wrapper's horizontal padding is reserved for the row handle and the
 * "add column" button, so the table may only fill the wrapper's content box.
 */
export function tableResizeHeadroom(table: HTMLElement, wrapper: HTMLElement): number {
  const style = getComputedStyle(wrapper);
  const available =
    wrapper.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  return Math.max(0, Math.floor(available - table.offsetWidth));
}

/**
 * Stops a table column from being dragged wider than the editor's content
 * width.
 *
 * BlockNote's column resizing (prosemirror-tables `columnResizing`) has a
 * minimum cell width but no maximum: it derives the new width from the mouse
 * `clientX` on every `mousemove` and again on `mouseup`, so a column can be
 * dragged until the table overflows and scrolls sideways. The plugin exposes
 * no hook for a maximum, so this caps the pointer position it reads instead:
 * while a column is being dragged, events past the limit report the limit as
 * their `clientX`. The live preview and the committed width therefore both
 * stop at the content edge.
 */
export function useTableResizeClamp(containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const win = container.ownerDocument.defaultView ?? window;

    let maxClientX: number | null = null;

    const handleMouseDown = (event: MouseEvent) => {
      maxClientX = null;
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      // prosemirror-tables puts `resize-cursor` on the editor while the
      // pointer is over a column edge; a mousedown there starts a resize.
      if (!event.target.closest('.resize-cursor')) return;
      const table = event.target.closest('table');
      const wrapper = table?.closest<HTMLElement>('.tableWrapper');
      if (!table || !wrapper) return;
      maxClientX = event.clientX + tableResizeHeadroom(table, wrapper);
    };

    const clampPointer = (event: MouseEvent) => {
      if (maxClientX === null) return;
      if (event.clientX > maxClientX) {
        Object.defineProperty(event, 'clientX', { value: maxClientX, configurable: true });
      }
      if (event.type === 'mouseup' || event.buttons === 0) maxClientX = null;
    };

    // Capture phase: the window listeners must run before the plugin's own,
    // which it registers on the window in the bubble phase.
    container.addEventListener('mousedown', handleMouseDown, true);
    win.addEventListener('mousemove', clampPointer, true);
    win.addEventListener('mouseup', clampPointer, true);
    return () => {
      container.removeEventListener('mousedown', handleMouseDown, true);
      win.removeEventListener('mousemove', clampPointer, true);
      win.removeEventListener('mouseup', clampPointer, true);
    };
  }, [containerRef]);
}
