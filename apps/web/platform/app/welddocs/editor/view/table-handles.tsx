import { useState } from 'react';
import { resizeColumn, tableColumnEdges, type ColumnEdge } from '@weldsuite/docs-engine';
import type { DocController } from '../model/doc-controller';

/**
 * Grips on the column borders of the tables on a page: drag one to make the
 * column wider or narrower (the next column gives or takes the space; the
 * last column moves the table's edge). Drawn in page points inside the
 * page's scaled layer; `ptPerPx` turns pointer movement back into points.
 */
export function ColumnHandles({ controller, pageIndex, ptPerPx, label }: { controller: DocController; pageIndex: number; ptPerPx: number; label: string }) {
  const [drag, setDrag] = useState<{ edge: ColumnEdge; dx: number } | null>(null);
  if (controller.readOnly) return null;
  const edges = tableColumnEdges(controller.layout, pageIndex);

  const start = (e: React.PointerEvent, edge: ColumnEdge) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const move = (ev: PointerEvent) => setDrag({ edge, dx: (ev.clientX - startX) * ptPerPx });
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      const dx = (ev.clientX - startX) * ptPerPx;
      if (Math.abs(dx) >= 0.5) controller.apply(resizeColumn(controller.doc, edge.tableId, edge.col, dx));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    setDrag({ edge, dx: 0 });
  };

  return (
    <>
      {edges.map((edge) => (
        <div
          key={`${edge.tableId}:${edge.col}:${edge.y}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={label}
          className="absolute z-[1] w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-blue-500/30"
          style={{ left: `${edge.x}pt`, top: `${edge.y}pt`, height: `${edge.height}pt` }}
          onPointerDown={(e) => start(e, edge)}
          onMouseDown={(e) => e.stopPropagation()}
        />
      ))}
      {drag && (
        <div
          className="pointer-events-none absolute border-l border-dashed border-blue-600"
          style={{ left: `${drag.edge.x + drag.dx}pt`, top: `${drag.edge.y}pt`, height: `${drag.edge.height}pt` }}
        />
      )}
    </>
  );
}
