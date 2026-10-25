/**
 * One PDF page drawn by pdf.js at `scale` pixels per point, sharp on high-DPI
 * screens. The box is sized from the stored page size first, so the layout
 * does not jump while the page renders; children (the field layer) sit on top.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { SignPageSize } from '@weldsuite/app-api-client/schemas/weldsign';

export function PdfPage({
  pdf,
  pageIndex,
  size,
  scale,
  children,
}: Readonly<{ pdf: PDFDocumentProxy | null; pageIndex: number; size: SignPageSize; scale: number; children?: ReactNode }>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendered, setRendered] = useState(false);
  const width = size.width * scale;
  const height = size.height * scale;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!pdf || !canvas) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    void pdf.getPage(pageIndex + 1).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      task = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      task.promise.then(
        () => !cancelled && setRendered(true),
        () => undefined, // cancelled by a newer render
      );
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageIndex, scale]);

  return (
    <div className="relative bg-white shadow-sm ring-1 ring-black/10" style={{ width, height }}>
      <canvas ref={canvasRef} className="absolute inset-0" style={{ width, height, opacity: rendered ? 1 : 0 }} />
      {children}
    </div>
  );
}
